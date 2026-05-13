/**
 * Snapsus — Snapshot share API
 *   POST /api/snap/save   → { id, url } — store a snapshot, return short URL
 *   GET  /api/snap/<id>   → snapshot JSON — used by share.html
 *
 * Storage: same KV namespace as rate-limiter (env.RL), keyed under "snap:<id>".
 * TTL: 1 year. Returns 503 if KV isn't bound yet — the rest of the app keeps
 * working, just sharing is unavailable.
 *
 * Origin allowlist + per-IP rate limit (5 saves/min) applies. Reads are
 * lightly capped (60/min) and edge-cached for 5 minutes.
 */

const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

const SAVE_LIMIT_PER_MIN = 5;
const READ_LIMIT_PER_MIN = 60;
const ID_LEN = 8;
const ID_RE = /^[A-HJ-NP-Z2-9]{8}$/; // matches alphabet below
const TTL_SEC = 60 * 60 * 24 * 365; // 1 year
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB — well under KV's 25MB cap, safer

function originAllowed(request) {
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    if (ALLOWED_HOSTS.has(host)) return true;
    if (host.endsWith(".snapsus.pages.dev")) return true;
    return false;
  } catch { return false; }
}

/* In-memory burst tracker (per Worker instance).
   Worker JS is single-threaded inside one instance → this Map is *atomic* for
   bursts that hit the same instance. Cloudflare spreads load across many
   instances per region, so a determined burst can still get through ~10×
   what the KV counter allows, but that's down from "unlimited" to "minor". */
const recentHits = new Map(); // ip -> array of timestamps (ms)
const BURST_WINDOW_MS = 5_000;  // 5-second sliding window for burst check
const BURST_LIMIT     = 3;      // max 3 requests per 5 sec per IP per instance

function checkBurst(ip) {
  const now = Date.now();
  const cutoff = now - BURST_WINDOW_MS;
  let hits = recentHits.get(ip) || [];
  // Prune old entries
  hits = hits.filter(t => t > cutoff);
  if (hits.length >= BURST_LIMIT) {
    return { ok: false, hitsInWindow: hits.length };
  }
  hits.push(now);
  recentHits.set(ip, hits);
  // Opportunistic cleanup so Map doesn't grow forever
  if (recentHits.size > 1024) {
    for (const [k, v] of recentHits) {
      if (!v.length || v[v.length - 1] < cutoff) recentHits.delete(k);
    }
  }
  return { ok: true };
}

async function rateLimit(env, request, ctx, kind, limit) {
  const ip = request.headers.get("cf-connecting-ip") || "anon";

  // Layer 1 — atomic in-memory burst check (this Worker instance).
  const burst = checkBurst(ip);
  if (!burst.ok) return { ok: false, retry: 5, reason: "burst" };

  if (!env || !env.RL) return { ok: true };

  // Layer 2 — KV per-minute counter (distributed view). cacheTtl: 0 forces a
  // fresh read so we see writes from concurrent instances within the same
  // minute. Race window still exists but is reduced from 30s to ~1ms.
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:snap:${kind}:${ip}:${minute}`;
  let cur;
  try { cur = parseInt((await env.RL.get(key, { cacheTtl: 0 })) || "0", 10); }
  catch { return { ok: true }; }
  if (cur >= limit) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    return { ok: false, retry, reason: "minute" };
  }

  // Layer 3 — probabilistic rejection as we approach the limit. With 5/min
  // budget, hits 4 and 5 get random reject chance to flatten burst load.
  const ratio = cur / limit;
  if (ratio >= 0.7 && Math.random() < (ratio - 0.7) * 2) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    return { ok: false, retry, reason: "approach" };
  }

  ctx.waitUntil(env.RL.put(key, String(cur + 1), { expirationTtl: 90 }).catch(() => {}));
  return { ok: true };
}

/* Random base32-ish ID (no I/O/0/1 to avoid confusion). */
function randId(len) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

export const onRequest = async (ctx) => {
  const { request, env } = ctx;

  if (!env.RL) {
    return json({ error: "Sharing requires KV. See README — bind a KV namespace as variable RL in Cloudflare Pages settings." }, 503);
  }

  if (!originAllowed(request)) {
    return json({ error: "Forbidden — only the Snapsus frontend may use this endpoint." }, 403);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ['api', 'snap', ...]
  if (parts[0] !== "api" || parts[1] !== "snap" || parts.length < 3) {
    return json({ error: "Bad path" }, 400);
  }
  const action = parts[2];

  /* ── POST /api/snap/save ── */
  if (action === "save" && request.method === "POST") {
    const rl = await rateLimit(env, request, ctx, "save", SAVE_LIMIT_PER_MIN);
    if (!rl.ok) {
      return json({ error: "Too many saves — slow down.", retry_after: rl.retry }, 429, { "retry-after": String(rl.retry) });
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BYTES) {
        return json({ error: "Snapshot too large to share (>12MB)." }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return json({ error: "Invalid body" }, 400);
    }
    if (!Array.isArray(body.holders)) {
      return json({ error: "Missing holders array" }, 400);
    }
    if (body.holders.length > 500_000) {
      return json({ error: "Too many holders (max 500,000)" }, 413);
    }

    /* Build a clean record with server-controlled metadata. We strictly
       allowlist fields so visitors can't be tricked by a malformed payload. */
    const record = {
      v: 1,
      created_at: new Date().toISOString(),
      captured_at: typeof body.captured_at === "string" ? body.captured_at.slice(0, 64) : null,
      kind: body.kind === "historical" ? "historical" : "live",
      blocks: body.blocks && typeof body.blocks === "object" ? body.blocks : {},
      sources: Array.isArray(body.sources) ? body.sources.slice(0, 50).map(s => ({
        address: typeof s.address === "string" ? s.address.toLowerCase().slice(0, 42) : null,
        ens: typeof s.ens === "string" ? s.ens.slice(0, 80) : null,
        kind: s.kind === "contract" ? "contract" : "wallet",
      })) : [],
      collections: Array.isArray(body.collections) ? body.collections.slice(0, 200).map(c => ({
        contract: typeof c.contract === "string" ? c.contract.toLowerCase().slice(0, 42) : null,
        chain:    typeof c.chain    === "string" ? c.chain.slice(0, 16) : null,
        name:     typeof c.name     === "string" ? c.name.slice(0, 120) : null,
        standard: c.standard === "ERC1155" ? "ERC1155" : "ERC721",
      })) : [],
      allocation: body.allocation && typeof body.allocation === "object" ? {
        mode: typeof body.allocation.mode === "string" ? body.allocation.mode.slice(0, 20) : "total",
        value: typeof body.allocation.value === "number" ? body.allocation.value : null,
        min_tokens: typeof body.allocation.min_tokens === "number" ? body.allocation.min_tokens : 1,
      } : { mode: "total", value: null, min_tokens: 1 },
      stats: {
        wallets: body.holders.length,
        total: body.holders.reduce((s, h) => s + (Number(h && (h.count != null ? h.count : h[1])) || 0), 0),
      },
      /* Compact representation: array of [address, count] pairs.
         Saves ~50% vs object-of-objects for large lists. */
      h: body.holders.map(h => {
        if (Array.isArray(h)) return [String(h[0] || "").toLowerCase().slice(0, 42), Number(h[1]) || 0];
        return [String((h && h.address) || "").toLowerCase().slice(0, 42), Number((h && h.count) || 0)];
      }).filter(([a, c]) => /^0x[0-9a-f]{40}$/.test(a) && c >= 1),
    };

    const text = JSON.stringify(record);
    if (text.length > MAX_BYTES) {
      return json({ error: "Encoded snapshot too large" }, 413);
    }

    /* Generate ID; on rare collision, retry once. */
    let id, exists;
    for (let attempt = 0; attempt < 3; attempt++) {
      id = randId(ID_LEN);
      exists = await env.RL.get(`snap:${id}`);
      if (!exists) break;
    }
    if (exists) {
      return json({ error: "ID collision — try again" }, 503);
    }

    try {
      await env.RL.put(`snap:${id}`, text, { expirationTtl: TTL_SEC });
    } catch (e) {
      return json({ error: "Failed to store snapshot", detail: String(e && e.message || e) }, 502);
    }

    return json({ id, url: `${url.origin}/s/${id}`, expires_in: TTL_SEC });
  }

  /* ── GET /api/snap/<id> ── */
  if (request.method === "GET") {
    const id = action;
    if (!ID_RE.test(id)) {
      return json({ error: "Invalid snapshot ID" }, 400);
    }

    const rl = await rateLimit(env, request, ctx, "read", READ_LIMIT_PER_MIN);
    if (!rl.ok) {
      return json({ error: "Too many requests", retry_after: rl.retry }, 429, { "retry-after": String(rl.retry) });
    }

    let data;
    try { data = await env.RL.get(`snap:${id}`); }
    catch { return json({ error: "Storage error" }, 502); }
    if (!data) {
      return json({ error: "Snapshot not found or expired" }, 404);
    }

    return new Response(data, {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300, s-maxage=300",
        "x-snapsus-cache": "MISS",
      },
    });
  }

  return json({ error: "Method not allowed" }, 405);
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

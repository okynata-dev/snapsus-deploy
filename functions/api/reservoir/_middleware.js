/**
 * Snapsus — Reservoir search proxy
 *   /api/reservoir/search?name=X&chain=Y  →  https://{host}/search/collections/v2?name=X
 *
 * Why Reservoir: OpenSea v2 has no text search endpoint. Reservoir does
 * — fuzzy `name=` query against their indexed collection set, with images
 * and contract addresses already attached.
 *
 * Endpoints:
 *   GET /api/reservoir/search?name=Q[&chain=ethereum|base|polygon|arbitrum|optimism][&limit=N]
 *
 * Hardening:
 *   - Origin allowlist (snapsus.com, *.pages.dev)
 *   - Only the search endpoint is allowed — no generic Reservoir proxying
 *   - Edge cache 1 hour per (query, chain) — search results are stable
 *   - Per-IP rate limit (60/min via env.RL when bound)
 *   - Works without an API key (Reservoir's free tier covers small volume).
 *     Set RESERVOIR_API_KEY in Cloudflare Pages env for higher limits.
 */

const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

/* Reservoir uses a per-chain host. Map our chain ids to their subdomains. */
const CHAIN_HOSTS = {
  "ethereum": "api.reservoir.tools",
  "base":     "api-base.reservoir.tools",
  "polygon":  "api-polygon.reservoir.tools",
  "arbitrum": "api-arbitrum.reservoir.tools",
  "optimism": "api-optimism.reservoir.tools",
};

const RATE_LIMIT_PER_MIN = 60;
const FRESH_TTL = 3600;   // 1 hour
const STALE_TTL = 21600;  // 6 hours

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

async function checkRateLimit(env, request, ctx) {
  if (!env || !env.RL) return { ok: true };
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:rsv:${ip}:${minute}`;
  let cur;
  try { cur = parseInt((await env.RL.get(key, { cacheTtl: 30 })) || "0", 10); }
  catch { return { ok: true }; }
  if (cur >= RATE_LIMIT_PER_MIN) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    return { ok: false, retry };
  }
  ctx.waitUntil(env.RL.put(key, String(cur + 1), { expirationTtl: 90 }).catch(() => {}));
  return { ok: true };
}

export const onRequest = async (ctx) => {
  const { request, env } = ctx;

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — this proxy only serves the Snapsus frontend." }, 403);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // /api/reservoir/search
  if (parts[0] !== "api" || parts[1] !== "reservoir" || parts[2] !== "search") {
    return json({ error: "Bad request: /api/reservoir/search?name=..." }, 400);
  }

  const name = (url.searchParams.get("name") || "").trim();
  if (!name || name.length < 2) {
    return json({ error: "Query too short (min 2 chars)" }, 400);
  }
  const chain = (url.searchParams.get("chain") || "ethereum").toLowerCase();
  if (!CHAIN_HOSTS[chain]) {
    return json({ error: `Unknown chain: ${chain}` }, 400);
  }
  const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));

  // Rate limit
  const rl = await checkRateLimit(env, request, ctx);
  if (!rl.ok) {
    return json({ error: "Rate limit exceeded — slow down.", retry_after: rl.retry }, 429,
                 { "retry-after": String(rl.retry) });
  }

  // Edge cache by full URL
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) {
    const freshUntil = Number(cached.headers.get("x-snapsus-fresh-until")) || 0;
    if (freshUntil > Math.floor(Date.now() / 1000)) {
      const headers = new Headers(cached.headers);
      headers.set("x-snapsus-cache", "HIT");
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    }
  }

  const upstreamUrl = `https://${CHAIN_HOSTS[chain]}/search/collections/v2?name=${encodeURIComponent(name)}&limit=${limit}`;
  const headers = new Headers();
  headers.set("accept", "application/json");
  if (env.RESERVOIR_API_KEY) headers.set("x-api-key", env.RESERVOIR_API_KEY);

  let upstreamResp;
  try { upstreamResp = await fetch(upstreamUrl, { headers }); }
  catch (e) {
    if (cached) return staleResponse(cached);
    return json({ error: "Reservoir fetch failed", detail: String(e && e.message || e) }, 502);
  }

  if (upstreamResp.status === 429 && cached) return staleResponse(cached);

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete("set-cookie");

  if (upstreamResp.ok) {
    const now = Math.floor(Date.now() / 1000);
    respHeaders.set("cache-control", `public, max-age=300, s-maxage=${STALE_TTL}`);
    respHeaders.set("x-snapsus-fresh-until", String(now + FRESH_TTL));
    respHeaders.set("x-snapsus-cache", "MISS");
    const buf = await upstreamResp.arrayBuffer();
    const toCache = new Response(buf, {
      status: upstreamResp.status, statusText: upstreamResp.statusText, headers: respHeaders,
    });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    return toCache;
  }

  respHeaders.set("cache-control", "private, no-store");
  return new Response(upstreamResp.body, {
    status: upstreamResp.status, statusText: upstreamResp.statusText, headers: respHeaders,
  });
};

function staleResponse(cached) {
  const headers = new Headers(cached.headers);
  headers.set("x-snapsus-cache", "STALE");
  headers.set("cache-control", "public, max-age=30, s-maxage=60");
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

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

/**
 * Snapsus — Alchemy proxy
 *   /api/alchemy/{network}/v2                     → POST  https://{network}.g.alchemy.com/v2/{KEY}
 *   /api/alchemy/{network}/nft/v3/{method}        → GET   https://{network}.g.alchemy.com/nft/v3/{KEY}/{method}
 *
 * Hardening:
 *   - Origin/Referer allowlist (snapsus.com, *.snapsus.pages.dev)
 *   - Network allowlist
 *   - RPC method allowlist (v2 path only)
 *   - Edge cache for GET (300s)
 *   - Optional per-IP rate limit (active when env.RL KV namespace is bound)
 *
 * KV setup (optional but recommended):
 *   1. wrangler kv:namespace create snapsus_rl
 *   2. Cloudflare → Pages → snapsus → Settings → Functions → KV namespace bindings
 *   3. Add binding: variable=RL, namespace=snapsus_rl
 *   4. Redeploy.
 *
 * Without RL bound the proxy still works — just no rate limiting.
 */

const ALLOWED_NETWORKS = new Set([
  "eth-mainnet",
  "base-mainnet",
  "polygon-mainnet",
  "arb-mainnet",
  "opt-mainnet",
]);

const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

/* RPC methods we actually call from the frontend.
   Anything else is rejected — protects against the proxy being abused
   as a generic Alchemy gateway. */
const ALLOWED_RPC_METHODS = new Set([
  "eth_getCode",
  "eth_getTransactionReceipt",
  "alchemy_getAssetTransfers",
]);

/* Per-IP cap. KV-based; only enforced when env.RL is bound. */
const RATE_LIMIT_PER_MIN = 240;

/* GET cache TTLs by NFT v3 method (rough heuristic). */
const CACHE_TTL = {
  "getContractMetadata":     3600,   // collection metadata barely changes
  "getContractsForOwner":    300,    // wallet's holdings shift on transfer
  "getOwnersForContract":    180,    // shifts on every secondary trade
  "searchContractMetadata":  3600,   // name → contracts mapping is very stable
};
const CACHE_TTL_DEFAULT = 300;

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
  if (!env || !env.RL) return { ok: true, mode: "off" };
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:alch:${ip}:${minute}`;
  let cur;
  try { cur = parseInt((await env.RL.get(key, { cacheTtl: 30 })) || "0", 10); }
  catch { return { ok: true, mode: "kv-error" }; }
  if (cur >= RATE_LIMIT_PER_MIN) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    return { ok: false, retry, reason: "minute" };
  }
  // Fire-and-forget increment with TTL slightly past the window
  ctx.waitUntil(env.RL.put(key, String(cur + 1), { expirationTtl: 90 }).catch(() => {}));
  return { ok: true, mode: "kv" };
}

function ttlForGet(rest) {
  // rest = ["nft", "v3", "<method>", ...]
  const method = rest[2] || "";
  return CACHE_TTL[method] || CACHE_TTL_DEFAULT;
}

export const onRequest = async (ctx) => {
  const { request, env } = ctx;

  if (!env.ALCHEMY_API_KEY) {
    return json({ error: "ALCHEMY_API_KEY env var not set in Cloudflare Pages." }, 500);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — this proxy only serves the Snapsus frontend." }, 403);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "alchemy" || parts.length < 4) {
    return json({ error: "Bad request: /api/alchemy/{network}/{v2|nft/v3/...}" }, 400);
  }

  const network = parts[2];
  if (!ALLOWED_NETWORKS.has(network)) {
    return json({ error: `Unknown network "${network}"` }, 400);
  }

  const rest = parts.slice(3);
  let upstreamPath;
  let isV2 = false;
  if (rest[0] === "v2" && rest.length === 1) {
    upstreamPath = `v2/${env.ALCHEMY_API_KEY}`;
    isV2 = true;
  } else if (rest[0] === "nft" && rest[1] === "v3") {
    const method = rest.slice(2).join("/");
    upstreamPath = `nft/v3/${env.ALCHEMY_API_KEY}${method ? "/" + method : ""}`;
  } else {
    return json({ error: "Unsupported Alchemy endpoint" }, 400);
  }

  // Rate limit
  const rl = await checkRateLimit(env, request, ctx);
  if (!rl.ok) {
    return json(
      { error: "Rate limit exceeded — slow down.", retry_after: rl.retry },
      429,
      { "retry-after": String(rl.retry) }
    );
  }

  const isGet = request.method === "GET" && !isV2;

  // Edge cache: only GET requests on the NFT v3 path
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  if (isGet) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-snapsus-cache", "HIT");
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
  }

  // Build upstream URL
  let upstream = `https://${network}.g.alchemy.com/${upstreamPath}`;
  if (url.search) upstream += url.search;

  // Forward only safe headers
  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("accept", request.headers.get("accept") || "application/json");

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    // Validate RPC methods on v2 path
    if (isV2) {
      let body;
      try { body = JSON.parse(new TextDecoder().decode(buf)); }
      catch { return json({ error: "Invalid JSON body" }, 400); }
      const calls = Array.isArray(body) ? body : [body];
      for (const c of calls) {
        if (!c || !ALLOWED_RPC_METHODS.has(c.method)) {
          return json({ error: `Disallowed RPC method: ${c && c.method}` }, 403);
        }
      }
    }
    init.body = buf;
  }

  let upstreamResp;
  try { upstreamResp = await fetch(upstream, init); }
  catch (e) {
    return json({ error: "Upstream fetch failed", detail: String(e && e.message || e) }, 502);
  }

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete("set-cookie");

  if (isGet && upstreamResp.ok) {
    const ttl = ttlForGet(rest);
    respHeaders.set("cache-control", `public, max-age=${ttl}, s-maxage=${ttl}`);
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

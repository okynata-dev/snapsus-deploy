/**
 * Snapsus — OpenSea proxy
 *   /api/opensea/{path}  →  https://api.opensea.io/api/v2/{path}
 *
 * Hardening:
 *   - Origin/Referer allowlist
 *   - Path allowlist (only the endpoints we actually use)
 *   - Edge cache for GET (300s for /accounts and /collections, 60s for /nfts)
 *   - Optional per-IP rate limit when env.RL is bound
 *
 * Allowed paths:
 *   GET  chain/{chain}/account/{0xaddr}/nfts
 *   GET  accounts/{0xaddr}
 *   GET  collections                            (with ?creator_username=...&chain=...)
 *   GET  collections/{slug}
 */

const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

const ALLOWED_PATHS = [
  /^chain\/[a-z]+\/account\/0x[a-fA-F0-9]{40}\/nfts$/,
  /^accounts\/0x[a-fA-F0-9]{40}$/,
  /^collections$/,
  /^collections\/[a-zA-Z0-9_\-]+$/,
];

const RATE_LIMIT_PER_MIN = 60;

function pathTtl(rest) {
  if (/\/nfts$/.test(rest)) return 60;     // wallet's NFTs change often
  if (/^accounts\//.test(rest)) return 1800;
  if (/^collections\/[^/]+$/.test(rest)) return 1800;
  if (rest === "collections") return 600;
  return 300;
}

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

function pathAllowed(rest) {
  return ALLOWED_PATHS.some(re => re.test(rest));
}

async function checkRateLimit(env, request, ctx) {
  if (!env || !env.RL) return { ok: true, mode: "off" };
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:os:${ip}:${minute}`;
  let cur;
  try { cur = parseInt((await env.RL.get(key, { cacheTtl: 30 })) || "0", 10); }
  catch { return { ok: true, mode: "kv-error" }; }
  if (cur >= RATE_LIMIT_PER_MIN) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    return { ok: false, retry, reason: "minute" };
  }
  ctx.waitUntil(env.RL.put(key, String(cur + 1), { expirationTtl: 90 }).catch(() => {}));
  return { ok: true, mode: "kv" };
}

export const onRequest = async (ctx) => {
  const { request, env } = ctx;

  if (!env.OPENSEA_API_KEY) {
    return json({ error: "OPENSEA_API_KEY env var not set in Cloudflare Pages." }, 500);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — this proxy only serves the Snapsus frontend." }, 403);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "opensea" || parts.length < 3) {
    return json({ error: "Bad request: /api/opensea/{path}" }, 400);
  }

  const rest = parts.slice(2).join("/");
  if (!pathAllowed(rest)) {
    return json({ error: `Disallowed OpenSea path: ${rest}` }, 403);
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

  const isGet = request.method === "GET";

  // Edge cache for GET
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

  let upstream = `https://api.opensea.io/api/v2/${rest}`;
  if (url.search) upstream += url.search;

  const headers = new Headers();
  headers.set("X-API-KEY", env.OPENSEA_API_KEY);
  headers.set("accept", "application/json");
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstreamResp;
  try { upstreamResp = await fetch(upstream, init); }
  catch (e) {
    return json({ error: "Upstream fetch failed", detail: String(e && e.message || e) }, 502);
  }

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete("set-cookie");

  if (isGet && upstreamResp.ok) {
    const ttl = pathTtl(rest);
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

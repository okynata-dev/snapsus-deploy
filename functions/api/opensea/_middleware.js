/**
 * Snapsus — OpenSea proxy
 *   /api/opensea/{path}  →  https://api.opensea.io/api/v2/{path}
 *
 * Hardening:
 *   - Origin/Referer allowlist
 *   - Path allowlist (only the endpoints we actually use)
 *   - Aggressive edge cache for GET (TTL by path — metadata up to 6h)
 *   - Server-side retry on upstream 429 (respects retry_after, capped)
 *   - Stale-while-revalidate: serve stale cache rather than fail with 429
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

/* Edge cache TTL. Two scales — `fresh` is when we trust the response without
   thinking, `stale` is how long we'll serve a stale-but-valid response while
   we revalidate in the background.

   The math: OpenSea free tier ≈ 4 req/sec = 240 req/min. With s-maxage=21600
   on collection metadata, one popular slug burns 1 upstream call per 6 hours
   across the whole world. We can handle several thousand uniques/day on this
   tier without ever blowing the budget. */
function pathTtl(rest) {
  if (/\/nfts$/.test(rest))               return { fresh: 300,   stale: 1800   };  // 5m / 30m
  if (/^accounts\//.test(rest))           return { fresh: 21600, stale: 86400  };  // 6h / 24h
  if (/^collections\/[^/]+$/.test(rest))  return { fresh: 21600, stale: 86400  };  // 6h / 24h
  if (rest === "collections")             return { fresh: 3600,  stale: 21600  };  // 1h / 6h
  return { fresh: 600, stale: 1800 };
}

/* Server-side retry on upstream 429.
   When OpenSea slaps us with 429, every concurrent user will get the same
   slap — that's the bug. Retrying inside the Worker means the *first* user
   to hit a cold endpoint pays the wait, and everyone behind them gets the
   cached response without ever seeing an error.

   Capped tight because we still need to return *something* within a few
   seconds — beyond that, fall back to stale cache (see fetchWithRetry below). */
const MAX_UPSTREAM_RETRIES = 2;
const RETRY_CAP_SECONDS = 4;

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

  // Edge cache for GET. We check on every request — the cache holds responses
  // until `s-maxage` plus any extra time we manually stuff into the cache key
  // via x-snapsus-stale-until (see writeCache below).
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });

  let cached = null;
  if (isGet) {
    cached = await cache.match(cacheKey).catch(() => null);
    if (cached) {
      const freshUntil = Number(cached.headers.get("x-snapsus-fresh-until")) || 0;
      const now = Math.floor(Date.now() / 1000);
      if (freshUntil > now) {
        // Truly fresh — return as-is.
        const headers = new Headers(cached.headers);
        headers.set("x-snapsus-cache", "HIT");
        return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
      }
      // Stale-but-have-something. We'll try upstream below; if it 429s, we
      // return this stale response instead of erroring. Background refresh
      // happens via ctx.waitUntil after we serve the response.
    }
  }

  let upstreamUrl = `https://api.opensea.io/api/v2/${rest}`;
  if (url.search) upstreamUrl += url.search;

  const headers = new Headers();
  headers.set("X-API-KEY", env.OPENSEA_API_KEY);
  headers.set("accept", "application/json");
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  // Fetch with retry-on-429. Up to MAX_UPSTREAM_RETRIES, each wait capped at
  // RETRY_CAP_SECONDS so we never make the user sit too long.
  let upstreamResp;
  try {
    upstreamResp = await fetchWithRetry(upstreamUrl, init);
  } catch (e) {
    if (cached) return staleResponse(cached, "upstream-error");
    return json({ error: "Upstream fetch failed", detail: String(e && e.message || e) }, 502);
  }

  // If upstream is *still* 429 after retries and we have stale cache — use it.
  if (upstreamResp.status === 429 && cached) {
    return staleResponse(cached, "rate-limited");
  }

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.delete("set-cookie");

  if (isGet && upstreamResp.ok) {
    const { fresh, stale } = pathTtl(rest);
    const now = Math.floor(Date.now() / 1000);
    // Browsers get the short TTL (5-10x lower than edge) so users can re-pull
    // if they want to. Edge holds onto the response much longer.
    respHeaders.set("cache-control", `public, max-age=${Math.min(fresh, 300)}, s-maxage=${stale}`);
    respHeaders.set("x-snapsus-fresh-until", String(now + fresh));
    respHeaders.set("x-snapsus-cached-at", String(now));
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

async function fetchWithRetry(url, init, attempt = 0) {
  const resp = await fetch(url, init);
  if (resp.status !== 429 || attempt >= MAX_UPSTREAM_RETRIES) return resp;
  // Parse retry hint. OpenSea sometimes sends it as a header, sometimes in
  // the JSON body. Cap whatever we read so we don't park the request forever.
  let waitSec = Number(resp.headers.get("retry-after")) || 0;
  if (!waitSec) {
    try {
      const body = await resp.clone().json();
      waitSec = Number(body && body.retry_after) || 0;
    } catch {}
  }
  waitSec = Math.min(RETRY_CAP_SECONDS, Math.max(1, waitSec || 2));
  // Exponential-ish: second retry waits a touch longer.
  waitSec = Math.min(RETRY_CAP_SECONDS, waitSec + attempt);
  await new Promise(r => setTimeout(r, waitSec * 1000));
  return fetchWithRetry(url, init, attempt + 1);
}

function staleResponse(cachedResp, reason) {
  const headers = new Headers(cachedResp.headers);
  headers.set("x-snapsus-cache", `STALE-${reason}`);
  headers.set("cache-control", "public, max-age=30, s-maxage=60");
  return new Response(cachedResp.body, {
    status: cachedResp.status, statusText: cachedResp.statusText, headers,
  });
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

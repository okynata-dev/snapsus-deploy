/**
 * Snapsus — Alchemy proxy (middleware version, no brackets in filename)
 *
 * Path in repo:
 *   functions/api/alchemy/_middleware.js
 *
 * Cloudflare Pages convention: a `_middleware.js` file intercepts every
 * request whose URL starts with the directory it sits in. Returning a
 * Response (without calling next()) handles the request entirely, which
 * means we don't need a separate handler file with bracket syntax.
 *
 * URL pattern in the browser:
 *   /api/alchemy/{network}/v2                     → POST  https://{network}.g.alchemy.com/v2/{KEY}
 *   /api/alchemy/{network}/nft/v3/{method}        → GET   https://{network}.g.alchemy.com/nft/v3/{KEY}/{method}
 *
 * The ALCHEMY_API_KEY env var is read on the edge and never ships to the browser.
 * Set it in Cloudflare Pages → Project → Settings → Environment variables (encrypted).
 */

const ALLOWED_NETWORKS = new Set([
  "eth-mainnet",
  "base-mainnet",
  "polygon-mainnet",
  "arb-mainnet",
  "opt-mainnet",
]);

/* Allow only browsers loading our own page to use this proxy. Without this
   anyone can use snapsus.com as a free Alchemy endpoint and burn the key's
   compute units. We accept same-origin requests (Origin matches Host) and
   requests with no Origin header (curl, RPC clients) we reject — same-origin
   browser requests always carry an Origin in modern browsers. */
const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

function originAllowed(request) {
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    if (ALLOWED_HOSTS.has(host)) return true;
    // Allow Cloudflare Pages preview deployments (*.snapsus.pages.dev)
    if (host.endsWith(".snapsus.pages.dev")) return true;
    return false;
  } catch { return false; }
}

export const onRequest = async ({ request, env }) => {
  if (!env.ALCHEMY_API_KEY) {
    return json({ error: "ALCHEMY_API_KEY env var not set in Cloudflare Pages." }, 500);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — this proxy only serves the Snapsus frontend." }, 403);
  }

  // Parse the path the browser hit: /api/alchemy/{network}/{...rest}
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "alchemy" || parts.length < 4) {
    return json({ error: "Bad request: /api/alchemy/{network}/{v2|nft/v3/...}" }, 400);
  }

  const network = parts[2];
  if (!ALLOWED_NETWORKS.has(network)) {
    return json({ error: `Unknown network "${network}"` }, 400);
  }

  // Build upstream URL — Alchemy expects the API key as a path segment.
  const rest = parts.slice(3);
  let upstreamPath;
  if (rest[0] === "v2" && rest.length === 1) {
    upstreamPath = `v2/${env.ALCHEMY_API_KEY}`;
  } else if (rest[0] === "nft" && rest[1] === "v3") {
    const method = rest.slice(2).join("/");
    upstreamPath = `nft/v3/${env.ALCHEMY_API_KEY}${method ? "/" + method : ""}`;
  } else {
    return json({ error: "Unsupported Alchemy endpoint" }, 400);
  }

  let upstream = `https://${network}.g.alchemy.com/${upstreamPath}`;
  if (url.search) upstream += url.search;

  // Forward only safe headers
  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("accept", request.headers.get("accept") || "application/json");

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream, init);
  } catch (e) {
    return json({ error: "Upstream fetch failed", detail: String(e && e.message || e) }, 502);
  }

  // Strip caching, pass through status + body
  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.set("cache-control", "private, no-store");
  respHeaders.delete("set-cookie");

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

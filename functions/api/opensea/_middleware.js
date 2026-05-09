/**
 * Snapsus — OpenSea proxy
 *
 * Path in repo:
 *   functions/api/opensea/_middleware.js
 *
 * URL pattern in browser:
 *   /api/opensea/{anything}     → https://api.opensea.io/api/v2/{anything}
 *   The X-API-KEY header is added on the edge from env.OPENSEA_API_KEY.
 *
 * Set OPENSEA_API_KEY in Cloudflare Pages → Settings → Environment variables.
 */

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
    if (host.endsWith(".snapsus.pages.dev")) return true;
    return false;
  } catch { return false; }
}

export const onRequest = async ({ request, env }) => {
  if (!env.OPENSEA_API_KEY) {
    return json({ error: "OPENSEA_API_KEY env var not set in Cloudflare Pages." }, 500);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — this proxy only serves the Snapsus frontend." }, 403);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ['api','opensea',...rest]
  if (parts[0] !== "api" || parts[1] !== "opensea" || parts.length < 3) {
    return json({ error: "Bad request: /api/opensea/{path}" }, 400);
  }

  const rest = parts.slice(2).join("/");
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

  let resp;
  try { resp = await fetch(upstream, init); }
  catch (e) { return json({ error: "Upstream fetch failed", detail: String(e && e.message || e) }, 502); }

  const respHeaders = new Headers(resp.headers);
  respHeaders.set("cache-control", "private, no-store");
  respHeaders.delete("set-cookie");

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

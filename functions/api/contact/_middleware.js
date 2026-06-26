/**
 * Snapsus — contact form proxy
 *   POST /api/contact  → forwards to Resend, delivers to snapsusapp@gmail.com
 *
 * Env vars (Cloudflare Pages → Settings → Environment variables):
 *   RESEND_API_KEY    required — get from https://resend.com (free tier: 3k/mo)
 *   CONTACT_TO        optional — destination email; defaults to snapsusapp@gmail.com
 *   CONTACT_FROM      optional — sender name+address; defaults to onboarding@resend.dev
 *
 * Without RESEND_API_KEY the endpoint returns 503 with a clear hint —
 * the rest of the site keeps working.
 *
 * Hardening:
 *   - Origin allowlist (snapsus.com etc.)
 *   - Rate limit: 3 submissions / IP / hour via existing RL KV
 *   - Honeypot field (`company`) — bots fill every input; we silently
 *     swallow if filled so spammers don't learn they were caught
 *   - Validation: category allowlist, email regex, length bounds
 *   - Audit copy stored in KV for 90 days under contact:<uuid>
 */

const ALLOWED_HOSTS = new Set([
  "snapsus.com",
  "www.snapsus.com",
  "snapsus.pages.dev",
]);

const ALLOWED_CATEGORIES = new Set([
  "general", "support", "bug", "press", "partnership",
]);

const DEFAULT_TO   = "snapsusapp@gmail.com";
const DEFAULT_FROM = "Snapsus Contact <onboarding@resend.dev>";

const RATE_LIMIT_PER_HOUR = 3;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 5000;
const MAX_SUBJECT = 120;
const MAX_EMAIL   = 254;

/* In-memory burst tracker — atomic within this Worker instance. Caps drive-by
   spam at 2 submits per 10s per IP. Distributed instances each enforce their
   own copy, but the strict KV per-hour limit catches the rest. */
const burstHits = new Map();
function checkContactBurst(ip) {
  const now = Date.now();
  const cutoff = now - 10_000;
  let hits = (burstHits.get(ip) || []).filter(t => t > cutoff);
  if (hits.length >= 2) return false;
  hits.push(now);
  burstHits.set(ip, hits);
  if (burstHits.size > 512) {
    for (const [k, v] of burstHits) {
      if (!v.length || v[v.length - 1] < cutoff) burstHits.delete(k);
    }
  }
  return true;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export const onRequest = async (ctx) => {
  const { request, env } = ctx;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!originAllowed(request)) {
    return json({ error: "Forbidden — only the Snapsus frontend may use this endpoint." }, 403);
  }
  if (!env.RESEND_API_KEY) {
    return json({
      error: "Contact form is being set up. Email snapsusapp@gmail.com directly in the meantime.",
    }, 503);
  }

  /* ── Rate limit (3/hr KV + atomic in-instance burst) ── */
  const ip = request.headers.get("cf-connecting-ip") || "anon";

  // Layer 1 — in-memory burst: max 2 submits per 10s per IP, atomic within
  // this Worker instance. Stops drive-by spam bots that fire 50 forms in 1s.
  if (!checkContactBurst(ip)) {
    return json({ error: "Slow down — give it a few seconds between messages." }, 429);
  }

  if (env.RL) {
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `rl:contact:${ip}:${hour}`;
    let cur;
    try { cur = parseInt((await env.RL.get(key, { cacheTtl: 0 })) || "0", 10); }
    catch { cur = 0; }
    if (cur >= RATE_LIMIT_PER_HOUR) {
      return json({ error: "Too many submissions — try again in an hour." }, 429);
    }
    // Probabilistic rejection at >70% of limit to flatten burst load.
    const ratio = cur / RATE_LIMIT_PER_HOUR;
    if (ratio >= 0.7 && Math.random() < (ratio - 0.7) * 2) {
      return json({ error: "Approaching submission limit — please wait." }, 429);
    }
    ctx.waitUntil(env.RL.put(key, String(cur + 1), { expirationTtl: 3700 }).catch(() => {}));
  }

  /* ── Parse + validate ── */
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid request body" }, 400); }
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid request body" }, 400);
  }

  /* Honeypot — silent success on filled */
  if (body.company && String(body.company).trim()) {
    return json({ ok: true });
  }

  const category = String(body.category || "general").toLowerCase().trim();
  if (!ALLOWED_CATEGORIES.has(category)) {
    return json({ error: "Invalid topic" }, 400);
  }

  const email = String(body.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX_EMAIL) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  const subject = String(body.subject || "").trim();
  if (subject.length < 3 || subject.length > MAX_SUBJECT) {
    return json({ error: `Subject must be 3–${MAX_SUBJECT} characters.` }, 400);
  }

  const message = String(body.message || "").trim();
  if (message.length < MIN_MESSAGE || message.length > MAX_MESSAGE) {
    return json({ error: `Message must be ${MIN_MESSAGE}–${MAX_MESSAGE} characters.` }, 400);
  }

  /* ── Compose email ── */
  const to       = env.CONTACT_TO   || DEFAULT_TO;
  const from     = env.CONTACT_FROM || DEFAULT_FROM;
  const ua       = request.headers.get("user-agent") || "?";
  const ts       = new Date().toISOString();
  const catLabel = cap(category);
  const fullSub  = `[Snapsus / ${catLabel}] ${subject}`.slice(0, 200);

  const text = `Category: ${catLabel}
From: ${email}
Submitted: ${ts}
IP: ${ip}

────────────────────────────────────────

${message}

────────────────────────────────────────
Reply directly to this email to respond.`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0a0a0a;background:#fafaf7;">
<div style="border-left:4px solid #5b3bff;padding-left:16px;margin-bottom:24px;">
  <p style="margin:0 0 4px;font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.12em;font-weight:600;">Snapsus contact</p>
  <p style="margin:0;font-size:14px;color:#2a2a2a;"><strong>${escapeHtml(catLabel)}</strong> from <a href="mailto:${escapeHtml(email)}" style="color:#5b3bff;text-decoration:none;">${escapeHtml(email)}</a></p>
</div>
<h2 style="margin:0 0 14px;font-size:22px;letter-spacing:-0.01em;font-weight:600;">${escapeHtml(subject)}</h2>
<div style="white-space:pre-wrap;font-size:14px;line-height:1.65;color:#1a1a1a;background:white;padding:18px 20px;border-radius:10px;border:1px solid rgba(10,10,10,0.06);">${escapeHtml(message)}</div>
<hr style="border:0;border-top:1px solid rgba(10,10,10,0.08);margin:28px 0 14px;"/>
<p style="margin:0;font-size:11px;color:#9a9a9a;font-family:ui-monospace,Menlo,monospace;line-height:1.6;">
Submitted&nbsp;${ts}<br/>
IP&nbsp;${escapeHtml(ip)}<br/>
UA&nbsp;${escapeHtml(ua).slice(0, 200)}
</p>
<p style="margin:14px 0 0;font-size:12px;color:#6b6b6b;">Reply directly to respond.</p>
</body></html>`;

  /* ── Send via Resend ── */
  let resp;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: fullSub,
        text,
        html,
      }),
    });
  } catch (e) {
    return json({ error: "Email service unreachable", detail: String(e && e.message || e) }, 502);
  }

  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 200); } catch {}
    return json({ error: "Email service rejected the message", detail }, 502);
  }

  /* ── Audit copy in KV (90 days) ── */
  if (env.RL) {
    try {
      const id = crypto.randomUUID();
      const audit = JSON.stringify({
        ts, category, email,
        subject: subject.slice(0, 200),
        message: message.slice(0, 2000),
        ip,
      });
      ctx.waitUntil(env.RL.put(`contact:${id}`, audit, { expirationTtl: 60 * 60 * 24 * 90 }).catch(() => {}));
    } catch {}
  }

  return json({ ok: true });
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

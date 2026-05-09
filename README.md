# Snapsus — deploy bundle

Drop these files into a Git repo, connect it to Cloudflare Pages, set two
environment variables, and you're live.

## Files

```
.
├── index.html
└── functions/
    └── api/
        ├── alchemy/
        │   └── _middleware.js   ← proxies /api/alchemy/* to Alchemy
        └── opensea/
            └── _middleware.js   ← proxies /api/opensea/* to OpenSea
```

The keys never reach the browser — both proxies inject them server-side from
Cloudflare environment variables and forward the request.

## Cloudflare Pages setup

1. Push these files to GitHub (or any Git host Cloudflare Pages supports).
2. Cloudflare → Pages → Create project → connect the repo. Build settings stay empty (it's static).
3. After the first deploy, go to **Settings → Environment variables → Production**, then add:
   - `ALCHEMY_API_KEY` — your Alchemy app key (toggle **Encrypt** to make it a secret)
   - `OPENSEA_API_KEY` — your OpenSea API key (also encrypted)
4. Trigger a redeploy (Deployments → ⋯ → Retry deployment) or push any change.

## Local development

Plain `open index.html` won't work — the proxies need Cloudflare's runtime.
Use Cloudflare's dev server:

```
npm install -g wrangler
wrangler pages dev .
```

Then visit http://localhost:8788. Set local env vars in `.dev.vars` if you
want to test against real APIs:

```
ALCHEMY_API_KEY=alch_xxx
OPENSEA_API_KEY=os_xxx
```

## Origin protection

Both proxies only accept requests whose Origin/Referer matches `snapsus.com`,
`www.snapsus.com`, or any `*.snapsus.pages.dev`. If you point the site at a
different domain, edit `ALLOWED_HOSTS` in both `_middleware.js` files.

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

## Anti-abuse: rate limiting (recommended)

Origin checks block browser-side abuse, but anyone with `curl` can spoof the
`Referer` header. To enforce a real per-IP cap (default 240/min for Alchemy,
60/min for OpenSea), bind a KV namespace named `RL`:

```bash
# Create the namespace once
npx wrangler kv:namespace create snapsus_rl
# → returns an id like "abc123…"
```

Then in Cloudflare dashboard:

1. **Pages → snapsus → Settings → Functions → KV namespace bindings → Add**
2. Variable name: `RL`
3. KV namespace: pick `snapsus_rl`
4. Save and trigger a redeploy.

That's it — the proxies detect the binding automatically. Without it, the
proxies still work; they just don't rate-limit. Each request that hits the
limit returns HTTP 429 with a `Retry-After` header.

## Edge caching

Both proxies cache successful GET responses at the Cloudflare edge:

| Endpoint                                                  | TTL       |
|-----------------------------------------------------------|-----------|
| `getContractMetadata` (Alchemy)                           | 1 hour    |
| `getOwnersForContract`, `getContractsForOwner` (Alchemy)  | 3-5 min   |
| OpenSea `accounts/{addr}`, `collections/{slug}`           | 30 min    |
| OpenSea `collections` (creator listing)                   | 10 min    |
| OpenSea `chain/{c}/account/{addr}/nfts`                   | 1 min     |

Cache hits show `x-snapsus-cache: HIT` in response headers — easy to verify
in DevTools. POST requests (Alchemy RPC) are not cached.

## RPC method allowlist

The Alchemy v2 RPC proxy only accepts these methods:

- `eth_getCode` — used for smart-contract detection in the exclude filter
- `eth_getTransactionReceipt` — used to find contracts deployed by a creator
- `alchemy_getAssetTransfers` — used for historical snapshots

Any other RPC method returns 403. Adjust `ALLOWED_RPC_METHODS` in
`functions/api/alchemy/_middleware.js` if you need more.

## OpenSea path allowlist

The OpenSea proxy only forwards these paths:

- `chain/{chain}/account/{addr}/nfts`
- `accounts/{addr}`
- `collections` (with query strings)
- `collections/{slug}`

Anything else returns 403. Edit `ALLOWED_PATHS` in
`functions/api/opensea/_middleware.js` to extend.

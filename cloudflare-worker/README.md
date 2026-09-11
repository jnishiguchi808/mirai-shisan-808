# Cloudflare Worker CORS Proxy

A self-hosted replacement for the public CORS proxies the dashboard relies on.

## Why

Yahoo Finance, StockAnalysis and Macrotrends do not send an
`Access-Control-Allow-Origin` header, so the browser blocks direct requests from
`https://jnishiguchi808.github.io`. A proxy relays the request server-side,
where CORS does not apply, and adds the header.

The public proxies have proven unreliable. As of September 2026:

| Proxy | Status | Action taken |
| --- | --- | --- |
| `allorigins.hexlet.app` | working, but 403s on StockAnalysis | kept as route 2 backstop |
| `api.allorigins.win` | HTTP 522 | **removed** from `index.html` |
| `corsproxy.io` | HTTP 401, now requires an API key | **removed** from `index.html` |

That left every proxied column depending on a single third-party host. This
Worker removes that single point of failure and is now **route 1** for
StockAnalysis, Macrotrends and Yahoo.

## Status

Deployed and live at `https://mirai-proxy.jay-nishiguchi.workers.dev`, on a
Cloudflare free-tier account signed in with the same Google identity as the
GitHub account hosting the Pages site. No credentials live in this repo.

**This repo is not wired to Cloudflare.** Committing a change to `proxy.js` does
not redeploy anything — you must paste the new code into the dashboard and click
Deploy (step 5 below). Keep the two in sync by hand.

**Do not enable "Protect with Cloudflare Access"** on this Worker. It puts an
identity login wall in front of the URL, so the dashboard's `fetch` calls get an
auth redirect instead of data. The `ALLOWED_ORIGINS` allowlist is the right
protection for this use case.

## Deploy

1. Sign in at <https://dash.cloudflare.com> (free tier, no credit card).
2. **Compute** → **Workers & Pages**.
3. Click the blue **Create application** button (top right).
4. Choose **Workers** → **Start with Hello World!** (or the equivalent starter),
   name it e.g. `mirai-proxy`, then **Deploy** the placeholder.
5. Open **Edit code** (or **</> Edit code**), replace the entire contents with
   `proxy.js` from this folder, and **Deploy** again.
6. Copy the URL shown, which will look like
   `https://mirai-proxy.jay-nishiguchi.workers.dev`.

The dashboard UI is rearranged periodically. If the labels differ, the flow is
always: create an application of type Worker, deploy the starter, then replace
its code with `proxy.js`.

Then add it as the **first** entry in both route lists in `index.html`. Only
working proxies belong in these arrays — a dead route costs a full fetch timeout
per ticker before the chain advances:

```js
const STOCK_ANALYSIS_PROXIES = [
  target => `https://mirai-proxy.jay-nishiguchi.workers.dev/?url=${encodeURIComponent(target)}`,
  target => `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(target)}`
];
```

## Limits

Free tier allows 100,000 requests/day and 10ms CPU per request. A full refresh
of ~595 tickers uses a few thousand requests, so the ceiling is not a practical
constraint. Responses are edge-cached for 5 minutes, which cuts repeat traffic
further.

## Security

Two allowlists in `proxy.js` prevent this becoming an open proxy:

- `ALLOWED_ORIGINS` — who may call the Worker. Update this if the site moves.
- `ALLOWED_HOSTS` — where it may forward to. Add a host here before pointing a
  new data source at the Worker, or requests will return 403.

The Worker also sends a browser-like `User-Agent` upstream. This matters:
StockAnalysis returns 403 to unproxied non-browser requests, and the header is
what gets past it.

## Verify

`test-proxy.mjs` exercises the handler directly with Node's global
`Request`/`Response`, including live upstream calls:

```
node cloudflare-worker/test-proxy.mjs
```

It checks both allowlists, https-only enforcement, malformed and missing
parameters, method restriction, preflight handling, and live passthrough for all
three upstreams. It is kept out of `tests/` deliberately because it depends on
the network and would make the offline suite flaky.

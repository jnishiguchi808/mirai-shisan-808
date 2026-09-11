# Cloudflare Worker CORS Proxy

A self-hosted replacement for the public CORS proxies the dashboard relies on.

## Why

Yahoo Finance, StockAnalysis and Macrotrends do not send an
`Access-Control-Allow-Origin` header, so the browser blocks direct requests from
`https://jnishiguchi808.github.io`. A proxy relays the request server-side,
where CORS does not apply, and adds the header.

The public proxies have proven unreliable. As of September 2026:

| Proxy | Status |
| --- | --- |
| `allorigins.hexlet.app` | working |
| `api.allorigins.win` | HTTP 522 |
| `corsproxy.io` | HTTP 401, now requires an API key |

That leaves every proxied column depending on a single third-party host. This
Worker removes that single point of failure.

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

Then add it as the **first** entry in both route lists in `index.html`, keeping
the existing public proxies as fallbacks:

```js
const STOCK_ANALYSIS_PROXIES = [
  target => `https://mirai-proxy.jay-nishiguchi.workers.dev/?url=${encodeURIComponent(target)}`,
  target => `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(target)}`,
  // ...
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

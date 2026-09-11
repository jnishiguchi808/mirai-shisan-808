/**
 * CORS proxy for the mirai-shisan-808 dashboard.
 *
 * Deploy to Cloudflare Workers (free tier), then put the resulting
 * https://<name>.<subdomain>.workers.dev URL first in YAHOO_CHART_ROUTES
 * and STOCK_ANALYSIS_PROXIES in index.html.
 *
 * Usage:  https://<worker>/?url=<encoded target url>
 *
 * Why this exists: Yahoo, StockAnalysis and Macrotrends do not send an
 * Access-Control-Allow-Origin header, so the browser blocks direct requests
 * from the published GitHub Pages origin. This relays the request
 * server-side, where CORS does not apply, and adds the header.
 *
 * Two allowlists stop this becoming an open proxy that anyone can abuse:
 * ALLOWED_ORIGINS controls who may call it, ALLOWED_HOSTS controls where it
 * may forward to.
 */

const ALLOWED_ORIGINS = [
  'https://jnishiguchi808.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'stockanalysis.com',
  'www.macrotrends.net'
];

const CACHE_SECONDS = 300;

// Some upstreams reject requests that do not look like a browser.
const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':
      origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function deny(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return deny('Only GET is supported', 405, origin);
    }
    // A browser always sends Origin cross-origin. Absent means a non-browser
    // client, which the host allowlist below still constrains.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return deny(`Origin not allowed: ${origin}`, 403, origin);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return deny('Missing required ?url= parameter', 400, origin);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return deny('Malformed target URL', 400, origin);
    }
    if (targetUrl.protocol !== 'https:') {
      return deny('Only https targets are allowed', 400, origin);
    }
    if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
      return deny(`Target host not allowed: ${targetUrl.hostname}`, 403, origin);
    }

    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cached = new Response(hit.body, hit);
        cached.headers.set('X-Proxy-Cache', 'HIT');
        for (const [k, v] of Object.entries(corsHeaders(origin))) {
          cached.headers.set(k, v);
        }
        return cached;
      }
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': UPSTREAM_UA, 'Accept': '*/*' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
      });
    } catch (error) {
      return deny(`Upstream fetch failed: ${error.message}`, 502, origin);
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        'X-Proxy-Cache': 'MISS',
        ...corsHeaders(origin)
      }
    });

    if (cache && upstream.ok) {
      // Cache a clone so the streamed body stays available to the caller.
      await cache.put(cacheKey, response.clone());
    }
    return response;
  }
};

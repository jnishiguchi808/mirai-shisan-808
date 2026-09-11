// Temporary harness: exercises the Worker's fetch handler directly using
// Node's global Request/Response/fetch. Real network calls to the upstreams.
import worker from './proxy.js';

const WORKER = 'https://proxy.example.workers.dev/';
const GOOD_ORIGIN = 'https://jnishiguchi808.github.io';

const call = (targetUrl, { origin = GOOD_ORIGIN, method = 'GET' } = {}) => {
  const u = targetUrl === null ? WORKER : `${WORKER}?url=${encodeURIComponent(targetUrl)}`;
  const headers = origin ? { Origin: origin } : {};
  return worker.fetch(new Request(u, { method, headers }));
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

console.log('\n=== Security: allowlists ===');
let r = await call('https://evil.example.com/steal');
check('blocks disallowed target host', r.status === 403, `got ${r.status}`);

r = await call('https://query1.finance.yahoo.com/v8/finance/chart/AAPL', { origin: 'https://attacker.test' });
check('blocks disallowed origin', r.status === 403, `got ${r.status}`);

r = await call('http://stockanalysis.com/api/symbol/s/aapl/history');
check('blocks non-https target', r.status === 400, `got ${r.status}`);

r = await call(null);
check('rejects missing ?url=', r.status === 400, `got ${r.status}`);

r = await call('not-a-url');
check('rejects malformed url', r.status === 400, `got ${r.status}`);

r = await call('https://query1.finance.yahoo.com/v8/finance/chart/AAPL', { method: 'POST' });
check('rejects non-GET', r.status === 405, `got ${r.status}`);

console.log('\n=== CORS preflight ===');
r = await call('https://query1.finance.yahoo.com/v8/finance/chart/AAPL', { method: 'OPTIONS' });
check('OPTIONS returns 204', r.status === 204, `got ${r.status}`);
check('preflight sets ACAO', r.headers.get('Access-Control-Allow-Origin') === GOOD_ORIGIN,
  r.headers.get('Access-Control-Allow-Origin'));

console.log('\n=== Live upstream passthrough ===');
r = await call('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=2y');
check('Yahoo 200', r.status === 200, `got ${r.status}`);
check('Yahoo ACAO header present', r.headers.get('Access-Control-Allow-Origin') === GOOD_ORIGIN,
  String(r.headers.get('Access-Control-Allow-Origin')));
let j = await r.json();
check('Yahoo payload has 502 bars', j.chart?.result?.[0]?.timestamp?.length === 502,
  `got ${j.chart?.result?.[0]?.timestamp?.length}`);

r = await call('https://stockanalysis.com/api/symbol/s/rddt/history?range=5Y&period=Daily');
check('StockAnalysis 200 (bot protection bypassed)', r.status === 200, `got ${r.status}`);
j = await r.json();
check('StockAnalysis returns bars', Array.isArray(j.data) && j.data.length > 200, `got ${j.data?.length}`);

r = await call('https://www.macrotrends.net/stocks/charts/AAPL/x/pe-ratio');
check('Macrotrends reachable', r.status === 200, `got ${r.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

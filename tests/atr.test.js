const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);

function source(start, end) {
  const first = script.indexOf(start);
  const last = script.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return script.slice(first, last);
}

function context(overrides = {}) {
  const warnings = [];
  const ctx = vm.createContext({
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    warnings,
    ...overrides
  });
  vm.runInContext(source('function calculateATR(', 'function applyTickerData('), ctx);
  return ctx;
}

function bars(count = 15) {
  return Array.from({ length: count }, (_, i) => ({
    time: 1700000000 + i * 86400, high: 101, low: 99, close: 100, complete: true
  }));
}

test('Wilder ATR seeds 14 true ranges, includes gaps, and smooths subsequent ranges', () => {
  const ctx = context();
  const history = bars();
  const seed = ctx.calculateATR(history);
  assert.equal(seed.atr, 2);
  assert.equal(seed.atrPercent, 2);
  history.push({ time: 1702000000, high: 110, low: 108, close: 109 });
  const next = ctx.calculateATR(history);
  const expected = (2 * 13 + 10) / 14;
  assert.equal(next.atr, expected);
  assert.equal(next.atrPercent, expected / 109 * 100);
  assert.equal(next.atrClose, 109);
  assert.throws(() => ctx.calculateATR(bars(14)), /15 consecutive/);
});

test('unfinished sessions do not change ATR; missing OHLC restarts warm-up', () => {
  const ctx = context();
  const history = bars();
  history.push({ time: 1702000000, high: 120, low: 90, close: 110, complete: false });
  assert.equal(ctx.calculateATR(history).atr, 2);
  assert.equal(ctx.calculateATR(history).atrTime, history[14].time);
  for (const invalid of [
    { high: null }, { low: undefined }, { close: null },
    { high: 98 }, { low: 102 }, { close: 102 }
  ]) {
    const broken = bars();
    broken[7] = { ...broken[7], ...invalid };
    assert.throws(() => ctx.calculateATR(broken), /consecutive/);
    assert.equal(ctx.calculateATR([...broken, ...bars()]).atr, 2);
  }
  assert.equal(ctx.calculateATR(bars().map(bar => ({ ...bar, high: 100, low: 100 }))).atr, 0);
});

test('Yahoo retains OHLC and null rows, excluding the open session until regular close', async () => {
  const start = 1700000000;
  const end = start + 23400;
  let now = start + 1000;
  const payload = { chart: { result: [{
    timestamp: [start - 86400, start],
    meta: { currentTradingPeriod: { regular: { start, end } } },
    indicators: { quote: [{ high: [101, 110], low: [99, 90], close: [100, 105] }] }
  }] } };
  const ctx = context({
    Date: class extends Date { static now() { return now * 1000; } },
    fetchJsonWithRoutes: async () => payload,
    YAHOO_CHART_ROUTES: [],
    yahooTicker: ticker => ticker
  });
  vm.runInContext(source('async function fetchYahooChart(', '// Fallback price history.'), ctx);
  let points = await ctx.fetchYahooChart('MSFT');
  assert.equal(points[0].high, 101);
  assert.equal(points[0].complete, true);
  assert.equal(points[1].complete, false);
  now = end;
  points = await ctx.fetchYahooChart('MSFT');
  assert.equal(points[1].complete, true);
  delete payload.chart.result[0].meta;
  assert.equal((await ctx.fetchYahooChart('MSFT'))[1].complete, false);
  now = start + 86400;
  assert.equal((await ctx.fetchYahooChart('MSFT'))[1].complete, true);
  payload.chart.result[0].timestamp.push(start + 86400);
  for (const values of Object.values(payload.chart.result[0].indicators.quote[0])) values.push(null);
  assert.equal((await ctx.fetchYahooChart('MSFT')).length, 3);
});

test('ATR works for young listings; close-only fallback keeps the existing signal without inventing ATR', async () => {
  const ctx = context({ fetchPriceHistory: async () => bars() });
  const young = await ctx.fetchTechnicalSignal('NEW');
  assert.equal(young.atr, 2);
  assert.equal(young.ma200, undefined);
  ctx.fetchPriceHistory = async () => bars(201).map(({ time, close }) => ({ time, close }));
  const fallback = await ctx.fetchTechnicalSignal('MSFT');
  assert.equal(fallback.atr, null);
  assert.match(fallback.atrError, /high\/low\/close/);
  assert.equal(fallback.ma50, 100);
  assert.equal(fallback.ma200, 100);
  assert.ok(ctx.warnings.some(warning => warning.startsWith('ATR unavailable for MSFT:')));
});

test('all watchlists place ATR after Chg %, with numeric sorting and shifted date/volume handling', () => {
  const ctx = context({
    WATCHLIST: { stocks: ['MSFT'], etfs: ['SPY'] },
    saPath: () => 'stocks',
    fetchWatchlistData: () => {}
  });
  vm.runInContext(source('function renderWatchlist(', 'function sortWatchlist('), ctx);
  for (const category of ['stocks', 'etfs']) {
    const container = {};
    ctx.renderWatchlist(container, category, category);
    const headings = [...container.innerHTML.matchAll(/<th\b[^>]*>([^<]*)/g)].map(match => match[1]);
    assert.deepEqual(headings.slice(2, 8), ['Price', 'Chg $', 'Chg %', 'ATR(14) $', 'ATR(14) %', 'Beta']);
    assert.equal(headings.length, 24);
    const row = container.innerHTML.match(/<tr data-idx="0">([\s\S]*?)<\/tr>/)[1];
    assert.equal((row.match(/<td\b/g) || []).length, 24);
  }
  assert.equal(ctx.cellSortValue({ textContent: '$10.12' }, 5).n, 10.12);
  assert.equal(ctx.cellSortValue({ textContent: '2.34%' }, 6).n, 2.34);
  assert.equal(ctx.cellSortValue({ textContent: '—' }, 5).e, 1);
  assert.equal(ctx.cellSortValue({ textContent: '1.2M' }, 22).n, 1200000);
  assert.equal(ctx.cellSortValue({ textContent: '10/15/26' }, 14).n, new Date(2026, 9, 15).getTime());
  assert.equal(ctx.cellSortValue({ textContent: '10/16/26' }, 15).n, new Date(2026, 9, 16).getTime());
});

test('row enrichment renders ATR without overwriting shifted metrics, dates, valuation, or targets', () => {
  const ctx = context({
    FX_RATES: {},
    getValidatedPeg: () => ({ value: null }),
    getArchetype: () => 'etf'
  });
  vm.runInContext(source('function applyTickerData(', '// RENDER: PORTFOLIO'), ctx);
  const cells = Array.from({ length: 24 }, () => ({
    textContent: '—', innerHTML: '', title: ''
  }));
  const tbody = { querySelector: () => ({ cells }) };
  const main = [{ name: 1, exDividendDate: 2, earningsDate: 3 }, 'Example', '2020-01-02T12:00:00', '2020-02-03T12:00:00'];
  const forecast = [{ priceTargets: 1 }, { low: 2, median: 3, high: 4 }, 90, 110, 130];
  const data = {
    quote: { c: 105, pc: 100, v: 1200000 },
    metric: { beta: 1.2, bookValuePerShareAnnual: 50, peNormalizedAnnual: 20, '52WeekLow': 80, '52WeekHigh': 120 },
    saMain: { nodes: [null, null, { data: main }] },
    saForecast: { nodes: [null, null, { data: forecast }] },
    macrotrends: { median5Y: 18 },
    yahoo: ctx.calculateATR(bars())
  };
  ctx.applyTickerData(data, 0, tbody, 'SPY', false, true);
  assert.deepEqual(cells.slice(2, 8).map(cell => cell.textContent), ['$105.00', '+5.00', '+5.00%', '$2.00', '2.00%', '1.20']);
  assert.match(cells[5].title, /Yahoo Finance.*Wilder ATR\(14\).*closing price \$100\.00/);
  assert.match(cells[8].innerHTML, /2\.10/);
  assert.equal(cells[9].textContent, '20.0');
  assert.match(cells[10].innerHTML, /18\.0/);
  assert.equal(cells[14].textContent, '01/02/20');
  assert.equal(cells[15].textContent, '02/03/20');
  assert.equal(cells[16].textContent, '$80.00');
  assert.equal(cells[17].textContent, '$120.00');
  assert.match(cells[18].innerHTML, /FV not applicable for ETFs/);
  assert.deepEqual(cells.slice(19, 23).map(cell => cell.textContent), ['$90', '$110', '$130', '1.2M']);
  assert.equal(cells[1].innerHTML, '');
  data.yahoo = { atr: null, atrPercent: null, atrError: 'OHLC unavailable' };
  ctx.applyTickerData(data, 0, tbody, 'SPY', false, true);
  assert.equal(cells[5].textContent, '—');
  assert.equal(cells[6].title, 'OHLC unavailable');
});

test('legacy cached technical data is discarded and new ATR data survives caching', () => {
  const storage = new Map();
  const ctx = context({ localStorage: {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  } });
  vm.runInContext(source('const CACHE_TTL', '// --- Parallel fetch'), ctx);
  const data = { quote: { c: 100 }, metric: {}, yahoo: { atr: 2, atrPercent: 2 } };
  storage.set('ms808_MSFT', JSON.stringify({ data, ts: Date.now() }));
  assert.equal(ctx.cacheGet('MSFT'), null);
  assert.equal(storage.has('ms808_MSFT'), false);
  ctx.cacheSet('MSFT', data);
  assert.equal(ctx.cacheGet('MSFT').yahoo.atr, 2);
});

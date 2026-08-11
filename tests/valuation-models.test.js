const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.equal((html.match(/data-view="ai-robotics"/g) || []).length, 1);
assert.equal((html.match(/data-view="bdc"/g) || []).length, 1);
assert.match(html, /ai_robotics:\s*\[[^\]]*'CRDO'/);
assert.match(html, /semiconductors:\s*\[[^\]]*'CRDO'/);
assert.match(html, /advertising:\s*\[[^\]]*'RDDT'/);
assert.match(html, /ai_robotics:\s*\[[^\]]*'RDDT'/);
assert.match(html, /ai_robotics:\s*\[[^\]]*'ALMU'[^\]]*'QNT'[^\]]*'RGTI'/);
assert.match(html, /semiconductors:\s*\['ALMU'/);
assert.match(html, /quantum:\s*\['AMZN','GOOGL','HON','IBM','INFQ','INTC','IONQ','IQMX','MSFT','NVDA','QBTS','QNT','QTUM','QUBT','RGTI'\]/);
assert.match(html, /data-view="quantum"/);
assert.match(html, /drones:\s*\['ACHR','AIRO','AVAV','AVEX','BKSY','DPRO','DRNZ','EH','EVTL','JEDI','JOBY','KTOS','ONDS','PL','RCAT','RDW','SWMR','UAVS','UMAC','ZENA'\]/);
assert.match(html, /etfs:\s*\[[^\]]*'DRNZ'[^\]]*'JEDI'/);
assert.doesNotMatch(html, /s3\.tradingview\.com|new TradingView\.widget/);
assert.match(html, /function finnhubFetch\(/);
assert.match(html, /function renderPriceChart\(/);
assert.match(html, /s\.tradingview\.com\/widgetembed/);
assert.match(html, /if \(!data\?\.quote\?\.c \|\| !data\?\.metric\)/);
assert.match(html, /Render core quote\/metric fields immediately/);

function between(start, end) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `Missing marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing marker: ${end}`);
  return html.slice(startIndex + start.length, endIndex);
}

const valuationContext = {
  FRANCHISE_DCF_WEIGHT: 0.25,
  FRANCHISE_MULTIPLE_WEIGHT: 0.75,
  Math,
  Number
};
vm.createContext(valuationContext);
vm.runInContext(
  `${between('// BEGIN TESTABLE VALUATION HELPERS', '// END TESTABLE VALUATION HELPERS')}
   this.earningsDCF = earningsDCF;
   this.franchiseEarningsFV = franchiseEarningsFV;`,
  valuationContext
);

const mcdTrailing = valuationContext.franchiseEarningsFV(11.95, 8.3);
assert.ok(Math.abs(mcdTrailing.dcfFV - 219.70) < 0.01);
assert.equal(mcdTrailing.normalizedPE, 23.3);
assert.ok(Math.abs(mcdTrailing.multipleFV - 278.44) < 0.01);
assert.ok(Math.abs(mcdTrailing.fv - 263.75) < 0.01);

const mcdForward = valuationContext.franchiseEarningsFV(12.93, 8.2);
assert.ok(Math.abs(mcdForward.fv - 284.17) < 0.01);

const slowGrower = valuationContext.franchiseEarningsFV(10, -5);
assert.equal(slowGrower.normalizedPE, 18);
const fastGrower = valuationContext.franchiseEarningsFV(10, 50);
assert.equal(fastGrower.normalizedPE, 30);

assert.equal(valuationContext.franchiseEarningsFV(0, 8), null);
assert.equal(valuationContext.earningsDCF(10, 8, false).toFixed(2), '181.58');

const archetypeStart = html.indexOf('const ARCHETYPE_OVERRIDES');
const archetypeEnd = html.indexOf('// --- Fair-value tuning knobs', archetypeStart);
assert.notEqual(archetypeStart, -1);
assert.notEqual(archetypeEnd, -1);

const archetypeContext = {
  WATCHLIST: {
    reit: ['O'],
    bdc: ['ARCC'],
    banking: ['JPM'],
    rawmaterials: ['FCX']
  }
};
vm.createContext(archetypeContext);
vm.runInContext(
  `${html.slice(archetypeStart, archetypeEnd)}
   this.getArchetype = getArchetype;`,
  archetypeContext
);

assert.equal(archetypeContext.getArchetype('MCD', false, 'Hotels, Restaurants & Leisure'), 'franchise');
assert.equal(archetypeContext.getArchetype('YUM', false, 'Hotels, Restaurants & Leisure'), 'franchise');
assert.equal(archetypeContext.getArchetype('SBUX', false, 'Hotels, Restaurants & Leisure'), 'earnings');
assert.equal(archetypeContext.getArchetype('JPM', false, 'Banking'), 'book');
assert.equal(archetypeContext.getArchetype('O', false, 'Real Estate'), 'nav');
assert.equal(archetypeContext.getArchetype('XOM', false, 'Oil & Gas'), 'cyclical');
assert.equal(archetypeContext.getArchetype('SPY', true, 'Exchange Traded Fund'), 'etf');

console.log('valuation regression tests passed');

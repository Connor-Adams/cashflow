import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { FxLookup } from './unifyToCad';

// Parity + correctness suite for the vectorized buildSeries (issue #661).
// The contract: buildSeries must return byte-for-byte the same points as
// looping buildNetWorthAt over the same buckets, but with a handful of
// prefetch queries instead of thousands of per-bucket round-trips.
//
// The DB lifecycle + seed helpers mirror the sibling networth suites
// (networthAggregate.test.ts, balanceAtDate.test.ts, …) by design — each
// colocated suite is self-contained so it can run standalone.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-series-vectorized.sqlite');

let models: typeof import('../models/index.js');
let agg: typeof import('./aggregate.js');

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
  if (from === 'GBP' && to === 'CAD') return { rate: 1.7, ratedDate: asOf };
  return null;
};

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development', GH_PACKAGES_TOKEN: 'dummy' },
    stdio: 'pipe',
  });
  models = await import('../models/index.js');
  agg = await import('./aggregate.js');
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

beforeEach(async () => {
  await models.Transaction.destroy({ where: {}, force: true });
  await models.HoldingSnapshot.destroy({ where: {}, force: true });
  await models.SecurityPrice.destroy({ where: {}, force: true });
  await models.Security.destroy({ where: {}, force: true });
  await models.Account.destroy({ where: {}, force: true });
});

async function seedAcc(opts: {
  accountType: string;
  defaultCurrency?: string;
  opening?: number;
  openingBalanceDate?: string | null;
  closedAt?: string | null;
}) {
  return models.Account.create({
    name: 'A',
    owner: 'me',
    accountType: opts.accountType,
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    openingBalance: String(opts.opening ?? 0),
    openingBalanceDate: opts.openingBalanceDate ?? null,
    closedAt: opts.closedAt ?? null,
  } as never);
}

let fpCounter = 0;
async function seedTxn(accountId: number, date: string, amount: number, currency = 'CAD') {
  fpCounter += 1;
  const fp = `${accountId}-${date}-${amount}-${fpCounter}-${Math.random()}`;
  await models.Transaction.create({
    accountId,
    date,
    amount: String(amount),
    currency,
    merchantRaw: 't',
    merchantClean: 't',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

async function seedHolding(accountId: number, securityId: number, date: string, qty: number, currency = 'CAD') {
  fpCounter += 1;
  await models.HoldingSnapshot.create({
    accountId,
    securityId,
    statementDate: date,
    quantity: String(qty),
    currency,
    sourceRowFingerprint: `h-${accountId}-${securityId}-${date}-${fpCounter}`,
    importBatch: 'test',
  } as never);
}

async function seedPrice(securityId: number, pricedAt: string, price: number, currency = 'CAD') {
  await models.SecurityPrice.create({
    securityId,
    provider: 'test',
    symbol: 'X',
    pricedAt: new Date(pricedAt),
    price: String(price),
    currency,
    fetchedAt: new Date(pricedAt),
  } as never);
}

// Re-derive the per-bucket reference series by looping buildNetWorthAt — the
// pre-existing implementation we must match exactly.
async function referenceSeries(
  from: string,
  to: string,
  granularity: 'monthly' | 'daily',
  accountIds: number[],
) {
  const buckets =
    granularity === 'monthly' ? agg.monthEndDatesInRange(from, to) : agg.daysInRange(from, to);
  const points = [];
  const gaps = [];
  for (const date of buckets) {
    const snap = await agg.buildNetWorthAt(date, accountIds, stubFx);
    points.push({
      date,
      total: snap.total,
      assetsTotal: snap.assetsTotal,
      liabilitiesTotal: snap.liabilitiesTotal,
    });
    gaps.push(...snap.gaps);
  }
  return { points, partial: gaps.length > 0, gaps };
}

async function assertParity(
  from: string,
  to: string,
  granularity: 'monthly' | 'daily',
  accountIds: number[],
) {
  const expected = await referenceSeries(from, to, granularity, accountIds);
  const actual = await agg.buildSeries(from, to, granularity, accountIds, stubFx);
  assert.deepEqual(actual.points, expected.points, 'series points must match per-bucket reference');
  assert.equal(actual.partial, expected.partial, 'partial flag must match');
  // Gap set parity (order-independent).
  const norm = (g: unknown[]) => g.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(norm(actual.gaps), norm(expected.gaps), 'gaps must match the reference');
}

test('parity: single CAD checking, monthly', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000 });
  await seedTxn(acc.id, '2026-01-15', 100);
  await seedTxn(acc.id, '2026-02-15', -50);
  await seedTxn(acc.id, '2026-03-20', 300);
  await assertParity('2026-01-01', '2026-04-30', 'monthly', [acc.id]);
});

test('parity: single CAD checking, daily', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 500 });
  await seedTxn(acc.id, '2026-01-02', 100);
  await seedTxn(acc.id, '2026-01-03', -200);
  await seedTxn(acc.id, '2026-01-05', 50);
  await assertParity('2026-01-01', '2026-01-07', 'daily', [acc.id]);
});

test('parity: multi-currency (USD + GBP + EUR-missing-fx)', async () => {
  const acc = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
  await seedTxn(acc.id, '2026-01-10', 500, 'USD');
  await seedTxn(acc.id, '2026-02-10', 200, 'GBP');
  await seedTxn(acc.id, '2026-02-20', 75, 'EUR'); // no FX -> gap, excluded
  await seedTxn(acc.id, '2026-03-10', -50, 'CAD');
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [acc.id]);
});

test('parity: liability (credit_card) account', async () => {
  const chq = await seedAcc({ accountType: 'checking', opening: 5000 });
  const cc = await seedAcc({ accountType: 'credit_card', opening: 0 });
  await seedTxn(cc.id, '2026-01-05', -200);
  await seedTxn(cc.id, '2026-02-05', -300);
  await seedTxn(cc.id, '2026-02-20', 100);
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [chq.id, cc.id]);
});

test('parity: closed account drops out from closed_at onward', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000, closedAt: '2026-02-15' });
  await seedTxn(acc.id, '2026-01-10', 500);
  const open = await seedAcc({ accountType: 'checking', opening: 200 });
  await seedTxn(open.id, '2026-01-10', 50);
  await assertParity('2026-01-01', '2026-04-30', 'monthly', [acc.id, open.id]);
});

test('parity: implicit-zero opening with negative run is flagged/excluded', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 0 });
  await seedTxn(acc.id, '2026-01-10', -500);
  await seedTxn(acc.id, '2026-02-10', 100);
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [acc.id]);
});

test('parity: openingBalanceDate forward derivation', async () => {
  const acc = await seedAcc({
    accountType: 'checking',
    opening: 1000,
    openingBalanceDate: '2026-01-31',
  });
  await seedTxn(acc.id, '2026-01-15', -999); // pre-anchor: ignored forward
  await seedTxn(acc.id, '2026-02-15', 200);
  await seedTxn(acc.id, '2026-03-15', -50);
  await assertParity('2026-02-01', '2026-04-30', 'monthly', [acc.id]);
});

test('parity: openingBalanceDate backward derivation (buckets before anchor)', async () => {
  const acc = await seedAcc({
    accountType: 'checking',
    opening: 10000,
    openingBalanceDate: '2026-04-01',
  });
  await seedTxn(acc.id, '2026-02-15', -3000);
  await seedTxn(acc.id, '2026-03-10', -2000);
  await seedTxn(acc.id, '2026-04-15', 700); // after anchor
  await assertParity('2026-01-01', '2026-05-31', 'monthly', [acc.id]);
});

test('parity: anchor straddled — buckets both before and after openingBalanceDate', async () => {
  const acc = await seedAcc({
    accountType: 'checking',
    defaultCurrency: 'CAD',
    opening: 5000,
    openingBalanceDate: '2026-03-15',
  });
  await seedTxn(acc.id, '2026-01-10', 100, 'USD');
  await seedTxn(acc.id, '2026-02-10', -300);
  await seedTxn(acc.id, '2026-04-10', 250);
  await assertParity('2026-01-01', '2026-05-31', 'monthly', [acc.id]);
});

test('parity: portfolio investment account across buckets', async () => {
  const acc = await seedAcc({ accountType: 'investment' });
  const sec = await models.Security.create({ symbol: 'VFV', name: 'VFV', currency: 'CAD' } as never);
  await seedHolding(acc.id, sec.id, '2026-01-31', 10);
  await seedHolding(acc.id, sec.id, '2026-02-28', 15);
  await seedPrice(sec.id, '2026-01-15T16:00:00Z', 100);
  await seedPrice(sec.id, '2026-02-15T16:00:00Z', 110);
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [acc.id]);
});

test('parity: portfolio + cash + multi-currency mixed, daily', async () => {
  const chq = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 2000 });
  const inv = await seedAcc({ accountType: 'investment' });
  const usd = await seedAcc({ accountType: 'savings', defaultCurrency: 'USD', opening: 300 });
  await seedTxn(chq.id, '2026-01-02', 150);
  await seedTxn(chq.id, '2026-01-04', -75);
  await seedTxn(usd.id, '2026-01-03', 50, 'USD');
  const sec = await models.Security.create({ symbol: 'BTC', name: 'BTC', currency: 'CAD' } as never);
  await seedHolding(inv.id, sec.id, '2026-01-01', 2);
  await seedPrice(sec.id, '2026-01-01T16:00:00Z', 40000);
  await assertParity('2026-01-01', '2026-01-06', 'daily', [chq.id, inv.id, usd.id]);
});

test('parity: holdings on a mistyped non-investment account are not double counted', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000 });
  const sec = await models.Security.create({ symbol: 'VFV', name: 'VFV', currency: 'CAD' } as never);
  await seedHolding(acc.id, sec.id, '2026-01-01', 10);
  await seedPrice(sec.id, '2026-01-01T16:00:00Z', 100);
  await seedTxn(acc.id, '2026-01-15', 500);
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [acc.id]);
});

test('parity: price_unavailable gap propagates per bucket', async () => {
  const acc = await seedAcc({ accountType: 'investment' });
  const sec = await models.Security.create({ symbol: 'OBSCURE', name: 'O', currency: 'CAD' } as never);
  await seedHolding(acc.id, sec.id, '2026-01-31', 5); // no price, no marketValue
  await assertParity('2026-01-01', '2026-03-31', 'monthly', [acc.id]);
});

test('parity: empty accountIds', async () => {
  await assertParity('2026-01-01', '2026-03-31', 'monthly', []);
});

async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  let n = 0;
  const prev = models.sequelize.options.logging;
  models.sequelize.options.logging = () => {
    n += 1;
  };
  try {
    await fn();
  } finally {
    models.sequelize.options.logging = prev;
  }
  return n;
}

test('buildSeries: query count is bounded and independent of bucket count', async () => {
  // A mixed scope: cash + liability + foreign-currency + investment.
  const chq = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 1000 });
  const cc = await seedAcc({ accountType: 'credit_card', opening: 0 });
  const usd = await seedAcc({ accountType: 'savings', defaultCurrency: 'USD', opening: 100 });
  const inv = await seedAcc({ accountType: 'investment' });
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    await seedTxn(chq.id, `2026-${mm}-10`, 100);
    await seedTxn(cc.id, `2026-${mm}-12`, -40);
    await seedTxn(usd.id, `2026-${mm}-14`, 25, 'USD');
  }
  const sec = await models.Security.create({ symbol: 'VEQT', name: 'VEQT', currency: 'CAD' } as never);
  await seedHolding(inv.id, sec.id, '2026-01-31', 20);
  await seedPrice(sec.id, '2026-01-20T16:00:00Z', 30);
  const ids = [chq.id, cc.id, usd.id, inv.id];

  const q3 = await countQueries(() => agg.buildSeries('2026-01-01', '2026-03-31', 'monthly', ids, stubFx));
  const q12 = await countQueries(() => agg.buildSeries('2026-01-01', '2026-12-31', 'monthly', ids, stubFx));

  // The vectorized path issues a fixed handful of prefetch queries regardless
  // of how many buckets it produces. Pre-#661 this was ~queries × buckets.
  assert.equal(q3, q12, 'query count must not grow with bucket count');
  assert.ok(q12 <= 12, `expected low-double-digit query count, got ${q12}`);
});

test('parity: full breakdown values per bucket — all dimensions at once', async () => {
  // Larger fixture exercising every dimension at once over 6 monthly buckets.
  const chq = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 1000 });
  const cc = await seedAcc({ accountType: 'credit_card', opening: 0 });
  const usd = await seedAcc({ accountType: 'savings', defaultCurrency: 'USD', opening: 100 });
  const inv = await seedAcc({ accountType: 'investment' });
  const closed = await seedAcc({ accountType: 'checking', opening: 800, closedAt: '2026-03-10' });
  await seedTxn(chq.id, '2026-01-15', 200);
  await seedTxn(chq.id, '2026-03-15', -120);
  await seedTxn(cc.id, '2026-02-15', -350);
  await seedTxn(cc.id, '2026-04-15', 50);
  await seedTxn(usd.id, '2026-02-01', 250, 'USD');
  await seedTxn(closed.id, '2026-01-20', 40);
  const sec = await models.Security.create({ symbol: 'VEQT', name: 'VEQT', currency: 'CAD' } as never);
  await seedHolding(inv.id, sec.id, '2026-01-31', 20);
  await seedHolding(inv.id, sec.id, '2026-03-31', 25);
  await seedPrice(sec.id, '2026-01-20T16:00:00Z', 30);
  await seedPrice(sec.id, '2026-03-20T16:00:00Z', 33);
  await assertParity('2026-01-01', '2026-06-30', 'monthly', [chq.id, cc.id, usd.id, inv.id, closed.id]);
});

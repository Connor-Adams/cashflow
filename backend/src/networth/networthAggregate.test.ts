import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { FxLookup } from './unifyToCad';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-networth-aggregate.sqlite');

let models: typeof import('../models/index.js');
let agg: typeof import('./aggregate.js');

const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
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

async function seedAcc(opts: { accountType: string; defaultCurrency?: string; opening?: number }) {
  return models.Account.create({
    name: 'A', owner: 'me',
    accountType: opts.accountType,
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    openingBalance: String(opts.opening ?? 0),
  } as never);
}

async function seedTxn(accountId: number, date: string, amount: number, currency = 'CAD') {
  const fp = `${accountId}-${date}-${amount}-${Math.random()}`;
  await models.Transaction.create({
    accountId, date,
    amount: String(amount),
    currency,
    merchantRaw: 't',
    merchantClean: 't',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

test('buildNetWorthAt: single CAD checking account', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 5000 });
  await seedTxn(acc.id, '2026-01-01', -100);
  const result = await agg.buildNetWorthAt('2026-01-15', [acc.id], stubFx);
  assert.equal(result.total, 4900);
  assert.equal(result.assetsTotal, 4900);
  assert.equal(result.liabilitiesTotal, 0);
  assert.equal(result.partial, false);
});

test('buildNetWorthAt: subtracts credit_card debt from assets', async () => {
  const chq = await seedAcc({ accountType: 'checking', opening: 5000 });
  const cc = await seedAcc({ accountType: 'credit_card', opening: 0 });
  await seedTxn(cc.id, '2026-01-01', -200); // owe 200 on card
  const result = await agg.buildNetWorthAt('2026-01-15', [chq.id, cc.id], stubFx);
  assert.equal(result.assetsTotal, 5000);
  assert.equal(result.liabilitiesTotal, -200);
  assert.equal(result.total, 4800);
});

test('buildNetWorthAt: unifies multi-currency to CAD via fxLookup', async () => {
  const acc = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
  await seedTxn(acc.id, '2026-01-01', 500, 'USD');
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.ok(Math.abs(result.total - (100 + 500 * 1.36)) < 0.0001);
  assert.ok(result.fxRatesUsed.some((r) => r.from === 'USD' && r.to === 'CAD' && r.rate === 1.36));
});

test('buildNetWorthAt: marks partial=true when FX rate is missing', async () => {
  const acc = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
  await seedTxn(acc.id, '2026-01-01', 50, 'EUR');
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.partial, true);
  assert.ok(result.gaps.some((g) => g.currency === 'EUR' && g.reason === 'fx_rate_unavailable'));
  assert.equal(result.total, 100); // EUR excluded
});

test('buildNetWorthAt: empty accountIds returns zero', async () => {
  const result = await agg.buildNetWorthAt('2026-02-01', [], stubFx);
  assert.equal(result.total, 0);
  assert.deepEqual(result.breakdown.assets, []);
  assert.deepEqual(result.breakdown.liabilities, []);
});

test('buildNetWorthAt: includes portfolio market value as asset', async () => {
  const acc = await seedAcc({ accountType: 'investment' });
  const sec = await models.Security.create({ symbol: 'VFV', name: 'VFV', currency: 'CAD' } as never);
  await models.HoldingSnapshot.create({
    accountId: acc.id, securityId: sec.id,
    statementDate: '2026-01-01', quantity: '10', currency: 'CAD',
    sourceRowFingerprint: 'h1', importBatch: 'test',
  } as never);
  await models.SecurityPrice.create({
    securityId: sec.id, provider: 'test', symbol: 'VFV',
    pricedAt: new Date('2026-01-01T16:00:00Z'),
    price: '100', currency: 'CAD',
    fetchedAt: new Date('2026-01-01T16:00:00Z'),
  } as never);

  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 1000); // 10 × 100
  assert.equal(result.total, 1000);
});

test('buildNetWorthAt: investment accounts skip txn-stream balance', async () => {
  // Investment account with cash-flow txns (deposits, transfers, buys).
  // Pre-fix this would double-count: balanceAtDate(txns) + portfolio.
  // Post-fix only portfolio market value counts.
  const acc = await seedAcc({ accountType: 'investment', opening: 5000 });
  await seedTxn(acc.id, '2026-01-01', -1000); // e.g. security buy debit
  await seedTxn(acc.id, '2026-01-02', 50);    // e.g. dividend
  const sec = await models.Security.create({ symbol: 'X', name: 'X', currency: 'CAD' } as never);
  await models.HoldingSnapshot.create({
    accountId: acc.id, securityId: sec.id,
    statementDate: '2026-01-01', quantity: '5', currency: 'CAD',
    sourceRowFingerprint: 'h2', importBatch: 'test',
  } as never);
  await models.SecurityPrice.create({
    securityId: sec.id, provider: 'test', symbol: 'X',
    pricedAt: new Date('2026-01-01T16:00:00Z'),
    price: '200', currency: 'CAD',
    fetchedAt: new Date('2026-01-01T16:00:00Z'),
  } as never);

  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  // Portfolio = 5 × 200 = 1000. The opening 5000 and txns are ignored.
  assert.equal(result.assetsTotal, 1000);
  // No account-source row for investment accounts.
  assert.ok(!result.breakdown.assets.some((r) => r.source === 'account'));
  assert.ok(result.breakdown.assets.some((r) => r.source === 'portfolio'));
});

test('buildNetWorthAt: asset with negative balance is flagged and excluded from totals', async () => {
  // Checking account with no opening and a net-negative txn run — should
  // not poison the assetsTotal. Row surfaces with dataQualityWarning.
  const acc = await seedAcc({ accountType: 'checking', opening: 0 });
  await seedTxn(acc.id, '2026-01-01', -500);
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 0);
  assert.equal(result.total, 0);
  const flagged = result.breakdown.assets.find(
    (r) => r.source === 'account' && r.accountId === acc.id,
  );
  assert.ok(flagged, 'expected the account row to still appear in breakdown');
  assert.equal(flagged.dataQualityWarning, 'asset_balance_negative');
});

test('buildNetWorthAt: openingBalanceSet=false when implicit zero and txns exist', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 0 });
  await seedTxn(acc.id, '2026-01-01', 100);
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  const row = result.breakdown.assets.find((r) => r.source === 'account' && r.accountId === acc.id);
  assert.ok(row);
  assert.equal(row.openingBalanceSet, false);
});

test('buildNetWorthAt: skips closed account when closed_at <= asOf (cash account)', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000 });
  await seedTxn(acc.id, '2026-01-01', 500);
  acc.set('closedAt', '2026-01-15');
  await acc.save();
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 0);
  assert.equal(result.total, 0);
  assert.ok(
    !result.breakdown.assets.some((r) => r.accountId === acc.id),
    'closed account should not appear in breakdown'
  );
});

test('buildNetWorthAt: includes closed account in history before closed_at', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000 });
  await seedTxn(acc.id, '2026-01-01', 500);
  acc.set('closedAt', '2026-02-15');
  await acc.save();
  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 1500);
  assert.equal(result.total, 1500);
});

test('buildNetWorthAt: skips closed investment account from portfolio aggregation', async () => {
  const acc = await seedAcc({ accountType: 'investment' });
  const sec = await models.Security.create({ symbol: 'VFV', name: 'VFV', currency: 'CAD' } as never);
  await models.HoldingSnapshot.create({
    accountId: acc.id, securityId: sec.id,
    statementDate: '2026-01-01', quantity: '10', currency: 'CAD',
    sourceRowFingerprint: 'h-closed', importBatch: 'test',
  } as never);
  await models.SecurityPrice.create({
    securityId: sec.id, provider: 'test', symbol: 'VFV',
    pricedAt: new Date('2026-01-01T16:00:00Z'),
    price: '100', currency: 'CAD',
    fetchedAt: new Date('2026-01-01T16:00:00Z'),
  } as never);
  acc.set('closedAt', '2026-01-10');
  await acc.save();

  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 0);
  assert.equal(result.total, 0);
  assert.ok(!result.breakdown.assets.some((r) => r.source === 'portfolio'));
});

test('buildNetWorthAt: closed_at after asOf still includes portfolio market value', async () => {
  const acc = await seedAcc({ accountType: 'investment' });
  const sec = await models.Security.create({ symbol: 'X', name: 'X', currency: 'CAD' } as never);
  await models.HoldingSnapshot.create({
    accountId: acc.id, securityId: sec.id,
    statementDate: '2026-01-01', quantity: '5', currency: 'CAD',
    sourceRowFingerprint: 'h-future-close', importBatch: 'test',
  } as never);
  await models.SecurityPrice.create({
    securityId: sec.id, provider: 'test', symbol: 'X',
    pricedAt: new Date('2026-01-01T16:00:00Z'),
    price: '200', currency: 'CAD',
    fetchedAt: new Date('2026-01-01T16:00:00Z'),
  } as never);
  acc.set('closedAt', '2026-03-01');
  await acc.save();

  const result = await agg.buildNetWorthAt('2026-02-01', [acc.id], stubFx);
  assert.equal(result.assetsTotal, 1000);
});

test('buildNetWorthAt: openingBalanceSet=true when opening set or no txns', async () => {
  const accWithOpening = await seedAcc({ accountType: 'checking', opening: 1000 });
  await seedTxn(accWithOpening.id, '2026-01-01', 50);
  const accNoTxns = await seedAcc({ accountType: 'checking', opening: 0 });
  const result = await agg.buildNetWorthAt('2026-02-01', [accWithOpening.id, accNoTxns.id], stubFx);
  const row1 = result.breakdown.assets.find((r) => r.accountId === accWithOpening.id);
  const row2 = result.breakdown.assets.find((r) => r.accountId === accNoTxns.id);
  assert.equal(row1?.openingBalanceSet, true);
  assert.equal(row2?.openingBalanceSet, true);
});

test('monthEndDatesInRange: returns last day of each month in range, inclusive', () => {
  assert.deepEqual(
    agg.monthEndDatesInRange('2026-01-15', '2026-03-10'),
    ['2026-01-31', '2026-02-28']
  );
});

test('monthEndDatesInRange: includes the to-date month-end when to is exactly month-end', () => {
  assert.deepEqual(
    agg.monthEndDatesInRange('2026-01-01', '2026-03-31'),
    ['2026-01-31', '2026-02-28', '2026-03-31']
  );
});

test('daysInRange: returns every date inclusive', () => {
  assert.deepEqual(
    agg.daysInRange('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']
  );
});

test('buildSeries: emits one point per monthly bucket with expected totals', async () => {
  const acc = await seedAcc({ accountType: 'checking', opening: 1000 });
  await seedTxn(acc.id, '2026-01-15', 100);
  await seedTxn(acc.id, '2026-02-15', -50);
  const result = await agg.buildSeries('2026-01-01', '2026-02-28', 'monthly', [acc.id], stubFx);
  assert.deepEqual(result.points, [
    { date: '2026-01-31', total: 1100, assetsTotal: 1100, liabilitiesTotal: 0 },
    { date: '2026-02-28', total: 1050, assetsTotal: 1050, liabilitiesTotal: 0 },
  ]);
  assert.equal(result.partial, false);
});

test('buildSeries: marks partial=true when any bucket has FX gaps', async () => {
  const acc = await seedAcc({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
  await seedTxn(acc.id, '2026-01-15', 10, 'EUR');
  const result = await agg.buildSeries('2026-01-01', '2026-02-28', 'monthly', [acc.id], stubFx);
  assert.equal(result.partial, true);
  assert.ok(result.gaps.length > 0);
});

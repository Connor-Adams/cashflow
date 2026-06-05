import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-builder.sqlite');

let models: typeof import('../models');
let builder: typeof import('./dailySnapshotBuilder');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  models = await import('../models');
  builder = await import('./dailySnapshotBuilder');
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.SecurityDailyPrice.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.FxRate.destroy({ where: {}, truncate: true });
});

async function seedHousehold(id = 1) {
  return models.Household.create({ id, name: 'Test', benchmarkSymbol: 'SPY' });
}

async function seedAccount(args: { householdId: number; id?: number; currency?: string }) {
  return models.Account.create({
    id: args.id,
    householdId: args.householdId,
    name: 'Acct',
    owner: 'shared',
    accountType: 'investment',
    defaultCurrency: args.currency ?? 'CAD',
  });
}

async function seedSecurity(args: { id?: number; symbol?: string; currency?: string; householdId?: number }) {
  return models.Security.create({
    id: args.id,
    householdId: args.householdId ?? 1,
    symbol: args.symbol ?? 'VCN',
    name: 'Test Sec',
    assetType: 'etf',
    currency: args.currency ?? 'CAD',
  });
}

async function seedDailyPrice(args: { securityId: number; date: string; adjClose: number }) {
  return models.SecurityDailyPrice.create({
    securityId: args.securityId,
    date: args.date,
    open: String(args.adjClose),
    high: String(args.adjClose),
    low: String(args.adjClose),
    close: String(args.adjClose),
    adjClose: String(args.adjClose),
    volume: '0',
    source: 'test',
    fetchedAt: new Date(),
  });
}

async function seedFx(args: { fromCurrency: string; toCurrency?: string; ratedDate: string; rate: number }) {
  return models.FxRate.create({
    fromCurrency: args.fromCurrency,
    toCurrency: args.toCurrency ?? 'CAD',
    ratedDate: args.ratedDate,
    rate: String(args.rate),
    source: 'test',
    fetchedAt: new Date(),
  });
}

async function seedBuyActivity(args: { accountId: number; securityId: number; tradeDate: string; quantity: string; amount?: string }) {
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: args.securityId,
    activityType: 'buy',
    tradeDate: args.tradeDate,
    quantity: args.quantity,
    price: '100',
    amount: args.amount ?? '100',
    currency: 'CAD',
    description: 'Buy',
    sourceRowFingerprint: `buy-${args.tradeDate}-${args.securityId}`,
    importBatch: 'test',
  });
}

async function seedTransfer(args: { accountId: number; tradeDate: string; amount: string }) {
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: null,
    activityType: 'transfer',
    tradeDate: args.tradeDate,
    amount: args.amount,
    currency: 'CAD',
    description: 'Deposit',
    sourceRowFingerprint: `xfer-${args.tradeDate}-${args.accountId}`,
    importBatch: 'test',
  });
}

async function seedReinvestment(args: { accountId: number; securityId: number; tradeDate: string; quantity: string; amount?: string }) {
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: args.securityId,
    activityType: 'reinvestment',
    tradeDate: args.tradeDate,
    quantity: args.quantity,
    price: '100',
    amount: args.amount ?? '0',
    currency: 'CAD',
    description: 'Reinvest',
    sourceRowFingerprint: `reinv-${args.tradeDate}-${args.securityId}`,
    importBatch: 'test',
  });
}

async function seedHoldingSnapshot(args: {
  accountId: number;
  securityId: number;
  statementDate: string;
  quantity: string;
  marketValue: string;
  currency?: string;
}) {
  return models.HoldingSnapshot.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: args.securityId,
    statementDate: args.statementDate,
    quantity: args.quantity,
    price: null,
    marketValue: args.marketValue,
    currency: args.currency ?? 'CAD',
    sourceRowFingerprint: `hold-${args.statementDate}-${args.securityId}`,
    importBatch: 'test',
  });
}

test('greenfield: builds one snapshot per day for one account holding one security', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  for (let d = 1; d <= 5; d++) {
    await seedDailyPrice({ securityId: sec.id, date: `2026-01-0${d}`, adjClose: 100 });
  }

  const r = await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-05',
  });
  assert.equal(r.daysBuilt, 5);
  const rows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id }, order: [['date', 'ASC']] });
  assert.equal(rows.length, 5);
  assert.equal(Number(rows[0].marketValueNative), 1000);
  assert.equal(rows[0].currency, 'CAD');
  assert.equal(Number(rows[0].marketValueCad), 1000);
  assert.equal(rows[0].isPartial, false);
});

test('USD account: fx_rate_to_cad applied + market_value_cad correct', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id, currency: 'USD' });
  const sec = await seedSecurity({ currency: 'USD' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });
  await seedFx({ fromCurrency: 'USD', ratedDate: '2026-01-01', rate: 1.37 });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(Number(row!.marketValueNative), 1000);
  assert.equal(Number(row!.fxRateToCad), 1.37);
  assert.equal(Number(row!.marketValueCad), 1370);
});

test('missing daily price → is_partial=true + missing_data_reasons populated', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'MISSING' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  // No SecurityDailyPrice seeded.

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(row!.isPartial, true);
  assert.ok((row!.missingDataReasons ?? []).some((r: string) => r.includes('no_price:MISSING')));
});

test('missing FX → is_partial=true + reason populated', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id, currency: 'USD' });
  const sec = await seedSecurity({ currency: 'USD' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });
  // No FX seeded.

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(row!.isPartial, true);
  assert.ok((row!.missingDataReasons ?? []).some((r: string) => r.includes('no_fx:USD')));
});

test('transfer activity sets cash_flow_native + cash_flow_cad', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  await seedTransfer({ accountId: acct.id, tradeDate: '2026-01-01', amount: '500' });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(Number(row!.cashFlowNative), 500);
  assert.equal(Number(row!.cashFlowCad), 500);
});

test('idempotent: re-running same range produces same row count', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });

  await builder.buildDailySnapshotsForHousehold({ householdId: hh.id, fromDate: '2026-01-01', toDate: '2026-01-01' });
  await builder.buildDailySnapshotsForHousehold({ householdId: hh.id, fromDate: '2026-01-01', toDate: '2026-01-01' });
  const rows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
});

test('markDailySnapshotsStaleForHousehold deletes rows >= fromDate', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  await models.PortfolioDailySnapshot.bulkCreate([
    { householdId: hh.id, accountId: acct.id, date: '2026-01-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
    { householdId: hh.id, accountId: acct.id, date: '2026-06-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
    { householdId: hh.id, accountId: acct.id, date: '2026-12-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
  ]);
  await builder.markDailySnapshotsStaleForHousehold(hh.id, '2026-06-01');
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-01-01');
});

test('buildDailySnapshotsForAllHouseholds iterates households', async () => {
  await seedHousehold(1);
  await seedHousehold(2);
  const acct1 = await seedAccount({ householdId: 1, id: 10 });
  const acct2 = await seedAccount({ householdId: 2, id: 20 });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct1.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '5' });
  await seedBuyActivity({ accountId: acct2.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '7' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });

  const r = await builder.buildDailySnapshotsForAllHouseholds({ toDate: '2026-01-01' });
  assert.equal(r.households, 2);
  assert.ok(r.daysBuilt >= 2);
});

test('carry-forward within window: priced through D-3, held on D → MV = qty × price(D-3), is_partial stale reason', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'STALE' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  // Priced only through 2026-01-02 (= D-3 for D=2026-01-05), adjClose 50.
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 50 });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-02', adjClose: 50 });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-05',
    toDate: '2026-01-05',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id, date: '2026-01-05' } });
  assert.ok(row);
  // 10 units carried forward at the most recent price (50) within the staleness window.
  assert.equal(Number(row!.marketValueNative), 500);
  assert.equal(row!.isPartial, true);
  assert.ok(
    (row!.missingDataReasons ?? []).some((r: string) => r.includes('stale_price:STALE')),
    `expected stale_price reason, got ${JSON.stringify(row!.missingDataReasons)}`,
  );
});

test('carry-forward beyond window (last price D-30, window 10) → MV 0', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'OLD' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  // Last price 30 calendar days before the valued day → beyond the 10-day window.
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 50 });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-31',
    toDate: '2026-01-31',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id, date: '2026-01-31' } });
  assert.ok(row);
  assert.equal(Number(row!.marketValueNative), 0);
  assert.equal(row!.isPartial, true);
});

test('broker fallback: zero daily prices + holdings_snapshot market_value + only reinvestment activity → MV ≈ broker value, flagged broker_value', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'RBF459' });
  // Only a reinvestment activity — no buy/sell/transfer.
  await seedReinvestment({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '109.844' });
  // No SecurityDailyPrice rows at all for this security.
  await seedHoldingSnapshot({
    accountId: acct.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: '109.844',
    marketValue: '98503.94',
  });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-02',
    toDate: '2026-01-02',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id, date: '2026-01-02' } });
  assert.ok(row);
  assert.equal(Number(row!.marketValueNative), 98503.94);
  assert.equal(row!.isPartial, true);
  assert.ok(
    (row!.missingDataReasons ?? []).some((r: string) => r.includes('broker_value:RBF459')),
    `expected broker_value reason, got ${JSON.stringify(row!.missingDataReasons)}`,
  );
});

test('reinvestment increments running qty (priced day uses price × reinvested units)', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'DRIP' });
  await seedReinvestment({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '5' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 20 });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id, date: '2026-01-01' } });
  assert.ok(row);
  // 5 reinvested units × price 20 = 100.
  assert.equal(Number(row!.marketValueNative), 100);
  assert.equal(row!.isPartial, false);
});

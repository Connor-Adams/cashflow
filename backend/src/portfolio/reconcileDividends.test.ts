/**
 * Unit tests for the AV dividend reconciler — verifies it converts
 * `SecurityDividend` events into per-account `InvestmentActivity` rows
 * while dedupeing against broker-imported dividends and against its own
 * prior runs.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-reconcile-dividends.sqlite');

let models: typeof import('../models');
let reconcileDividendsForSecurity: typeof import('./reconcileDividends').reconcileDividendsForSecurity;
let sequelize: import('sequelize').Sequelize;

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
  sequelize = models.sequelize;
  const reconcileModule = await import('./reconcileDividends');
  reconcileDividendsForSecurity = reconcileModule.reconcileDividendsForSecurity;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.Household.create({ id: 1, name: 'Test Household' });
});

interface SetupArgs {
  symbol?: string;
  currency?: string;
  exDate?: string;
  paymentDate?: string | null;
  perShare?: string;
}

async function setupSecurityAndDividend(args: SetupArgs = {}) {
  const security = await models.Security.create({
    householdId: 1,
    symbol: args.symbol ?? 'TST',
    name: 'Test',
    assetType: 'EQUITY',
    currency: args.currency ?? 'USD',
  });
  await models.SecurityDividend.create({
    securityId: security.id,
    exDividendDate: args.exDate ?? '2026-03-14',
    declarationDate: null,
    recordDate: null,
    paymentDate: args.paymentDate ?? '2026-04-01',
    amount: args.perShare ?? '0.485',
    currency: args.currency ?? 'USD',
    source: 'alpha_vantage',
    fetchedAt: new Date(),
  });
  return security;
}

async function makeAccount(householdId = 1, name = 'Brokerage') {
  return models.Account.create({
    householdId,
    name,
    owner: 'shared',
    accountType: 'investment',
    currency: 'USD',
  });
}

async function seedHolding(args: {
  accountId: number;
  securityId: number;
  statementDate: string;
  quantity: string;
}) {
  return models.HoldingSnapshot.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: args.securityId,
    statementDate: args.statementDate,
    quantity: args.quantity,
    price: null,
    marketValue: null,
    costBasis: null,
    unrealizedGainLoss: null,
    currency: 'USD',
    sourceReference: 'seed',
    sourceRowFingerprint: `seed:${args.accountId}:${args.securityId}:${args.statementDate}`,
    importBatch: 'seed-test',
  });
}

test('reconcile: no holdings at-or-before ex-date → skippedNoHolding', async () => {
  const sec = await setupSecurityAndDividend();
  const acct = await makeAccount();
  // Snapshot is AFTER the ex-date — should be ignored.
  await seedHolding({
    accountId: acct.id,
    securityId: sec.id,
    statementDate: '2026-04-30',
    quantity: '10',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedNoHolding, 1);
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 0);
});

test('reconcile: single account holding qty>0 → 1 row with native currency', async () => {
  const sec = await setupSecurityAndDividend({ perShare: '0.50', currency: 'USD' });
  const acct = await makeAccount();
  await seedHolding({
    accountId: acct.id,
    securityId: sec.id,
    statementDate: '2026-02-28',
    quantity: '20',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 1);
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activityType, 'dividend');
  assert.equal(rows[0].accountId, acct.id);
  assert.equal(Number(rows[0].amount), 10); // 20 * 0.50
  assert.equal(rows[0].currency, 'USD');
  assert.equal(rows[0].importBatch, 'alpha_vantage:dividends');
  assert.equal(rows[0].tradeDate, '2026-03-14'); // ex-date as canonical trade date
  assert.equal(rows[0].settlementDate, '2026-04-01');
});

test('reconcile: multi-account writes per-account rows', async () => {
  const sec = await setupSecurityAndDividend();
  const a = await makeAccount(1, 'Brokerage A');
  const b = await makeAccount(1, 'Brokerage B');
  await seedHolding({ accountId: a.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '5' });
  await seedHolding({ accountId: b.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '15' });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 2);
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 2);
  const byAccount = new Map(rows.map((r) => [r.accountId, Number(r.amount)]));
  // Compare with toFixed(4) so float jitter (15 * 0.485 = 7.27499...) doesn't
  // matter — the DB stores as DECIMAL(14,4) rounded to 4dp anyway.
  assert.equal(byAccount.get(a.id)!.toFixed(4), (5 * 0.485).toFixed(4));
  assert.equal(byAccount.get(b.id)!.toFixed(4), (15 * 0.485).toFixed(4));
});

test('reconcile: broker-imported dividend within ±5 days blocks the AV row', async () => {
  const sec = await setupSecurityAndDividend({ exDate: '2026-03-14' });
  const acct = await makeAccount();
  await seedHolding({ accountId: acct.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '10' });
  // Broker landed the dividend 3 days after ex-date.
  await models.InvestmentActivity.create({
    accountId: acct.id,
    householdId: 1,
    securityId: sec.id,
    activityType: 'dividend',
    tradeDate: '2026-03-17',
    settlementDate: '2026-03-17',
    description: 'Broker DIV',
    quantity: null,
    price: null,
    amount: '4.85',
    fees: null,
    splitRatio: null,
    currency: 'USD',
    sourceReference: 'broker-feed',
    sourceRowFingerprint: 'broker:1',
    importBatch: 'broker:wealthsimple',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedExistingBroker, 1);
  const rows = await models.InvestmentActivity.findAll({ where: { activityType: 'dividend' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].importBatch, 'broker:wealthsimple');
});

test('reconcile: broker-imported dividend OUTSIDE ±5 days does not block', async () => {
  const sec = await setupSecurityAndDividend({ exDate: '2026-03-14' });
  const acct = await makeAccount();
  await seedHolding({ accountId: acct.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '10' });
  // Different quarter's broker dividend.
  await models.InvestmentActivity.create({
    accountId: acct.id,
    householdId: 1,
    securityId: sec.id,
    activityType: 'dividend',
    tradeDate: '2025-12-15',
    settlementDate: null,
    description: 'Older broker DIV',
    quantity: null,
    price: null,
    amount: '4.85',
    fees: null,
    splitRatio: null,
    currency: 'USD',
    sourceReference: 'broker-feed',
    sourceRowFingerprint: 'broker:old',
    importBatch: 'broker:wealthsimple',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 1);
});

test('reconcile: idempotent — second run inserts no new rows', async () => {
  const sec = await setupSecurityAndDividend();
  const acct = await makeAccount();
  await seedHolding({ accountId: acct.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '10' });

  const first = await reconcileDividendsForSecurity(sec.id);
  assert.equal(first.inserted, 1);
  const second = await reconcileDividendsForSecurity(sec.id);
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedExistingBroker, 1, 'detects its own prior insert via the window');
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 1);
});

test('reconcile: snapshot far older than the ex-date is too stale to fabricate a dividend', async () => {
  const sec = await setupSecurityAndDividend({ exDate: '2026-03-14' });
  const acct = await makeAccount();
  // Only snapshot is ~14 months before the ex-date — the quantity is far too
  // stale (the position may have been fully sold long ago). Don't fabricate a
  // synthetic dividend from it; treat it as no usable holding.
  await seedHolding({
    accountId: acct.id,
    securityId: sec.id,
    statementDate: '2025-01-01',
    quantity: '10',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedNoHolding, 1);
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 0);
});

test('reconcile: snapshot within the staleness window still fabricates a dividend', async () => {
  const sec = await setupSecurityAndDividend({ exDate: '2026-03-14', perShare: '0.50' });
  const acct = await makeAccount();
  // ~2.5 months before the ex-date — a typical monthly/quarterly statement
  // cadence — is fresh enough to trust.
  await seedHolding({
    accountId: acct.id,
    securityId: sec.id,
    statementDate: '2025-12-31',
    quantity: '20',
  });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 1);
  const rows = await models.InvestmentActivity.findAll();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 10); // 20 * 0.50
});

test('reconcile: zero-quantity holding is skipped', async () => {
  const sec = await setupSecurityAndDividend();
  const acct = await makeAccount();
  await seedHolding({ accountId: acct.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '0' });

  const result = await reconcileDividendsForSecurity(sec.id);
  assert.equal(result.inserted, 0);
  assert.equal(result.skippedZeroQuantity, 1);
});

test('reconcile: respects custom dedupDays override', async () => {
  const sec = await setupSecurityAndDividend({ exDate: '2026-03-14' });
  const acct = await makeAccount();
  await seedHolding({ accountId: acct.id, securityId: sec.id, statementDate: '2026-02-28', quantity: '10' });
  // Broker landed 10 days after ex-date — outside default ±5 but inside ±14.
  await models.InvestmentActivity.create({
    accountId: acct.id,
    householdId: 1,
    securityId: sec.id,
    activityType: 'dividend',
    tradeDate: '2026-03-24',
    settlementDate: null,
    description: 'Broker DIV (late post)',
    quantity: null,
    price: null,
    amount: '4.85',
    fees: null,
    splitRatio: null,
    currency: 'USD',
    sourceReference: 'broker-feed',
    sourceRowFingerprint: 'broker:late',
    importBatch: 'broker:wealthsimple',
  });

  // Default window — should insert.
  const defaultRun = await reconcileDividendsForSecurity(sec.id, { dedupDays: 5 });
  assert.equal(defaultRun.inserted, 1);
  await models.InvestmentActivity.destroy({
    where: { importBatch: 'alpha_vantage:dividends' },
    truncate: false,
  });
  // Widened window — should skip.
  const widerRun = await reconcileDividendsForSecurity(sec.id, { dedupDays: 14 });
  assert.equal(widerRun.inserted, 0);
  assert.equal(widerRun.skippedExistingBroker, 1);
});

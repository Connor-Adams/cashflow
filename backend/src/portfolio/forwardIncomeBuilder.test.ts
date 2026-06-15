/**
 * Integration tests for `rebuildForwardProjectionsForHousehold` and related helpers.
 *
 * Pattern: per-file sqlite DB, sequelize-cli migrate in before(), truncate in beforeEach(),
 * inline factory helpers only — no shared testUtils.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-forward-income-builder.sqlite');

let models: typeof import('../models');
let rebuildForwardProjectionsForHousehold: typeof import('./forwardIncomeBuilder').rebuildForwardProjectionsForHousehold;
let rebuildForwardProjectionsForAllHouseholds: typeof import('./forwardIncomeBuilder').rebuildForwardProjectionsForAllHouseholds;
let markStaleForHousehold: typeof import('./forwardIncomeBuilder').markStaleForHousehold;
let markStaleForAllHoldersOfSecurity: typeof import('./forwardIncomeBuilder').markStaleForAllHoldersOfSecurity;
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
  const builderModule = await import('./forwardIncomeBuilder');
  rebuildForwardProjectionsForHousehold = builderModule.rebuildForwardProjectionsForHousehold;
  rebuildForwardProjectionsForAllHouseholds = builderModule.rebuildForwardProjectionsForAllHouseholds;
  markStaleForHousehold = builderModule.markStaleForHousehold;
  markStaleForAllHoldersOfSecurity = builderModule.markStaleForAllHoldersOfSecurity;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.PortfolioForwardProjection.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.SecurityDividend.destroy({ where: {}, truncate: true });
  await models.HoldingSnapshot.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

// -------------------------
// Inline factory helpers
// -------------------------

async function makeHousehold(name = 'Test Household') {
  return models.Household.create({ name });
}

async function makeAccount(
  householdId: number,
  opts: { name?: string; type?: string; closedAt?: string | null } = {},
) {
  return models.Account.create({
    householdId,
    name: opts.name ?? 'Brokerage',
    owner: 'shared',
    accountType: opts.type ?? 'investment',
    currency: 'USD',
    closedAt: opts.closedAt ?? null,
  });
}

async function makeSecurity(householdId: number | null, opts: { symbol?: string; currency?: string } = {}) {
  return models.Security.create({
    householdId,
    symbol: opts.symbol ?? 'TST',
    name: opts.symbol ?? 'Test Security',
    assetType: 'EQUITY',
    currency: opts.currency ?? 'USD',
  });
}

async function makeHolding(args: {
  accountId: number;
  householdId: number;
  securityId: number;
  statementDate: string;
  quantity: string;
  currency?: string;
}) {
  const fp = `test:${args.accountId}:${args.securityId}:${args.statementDate}:${args.quantity}`;
  return models.HoldingSnapshot.create({
    accountId: args.accountId,
    householdId: args.householdId,
    securityId: args.securityId,
    statementDate: args.statementDate,
    quantity: args.quantity,
    price: null,
    marketValue: null,
    costBasis: null,
    unrealizedGainLoss: null,
    currency: args.currency ?? 'USD',
    sourceReference: 'test',
    sourceRowFingerprint: fp,
    importBatch: 'test',
  });
}

async function makeDividend(args: {
  securityId: number;
  exDate: string;
  amount: string;
  currency?: string;
}) {
  return models.SecurityDividend.create({
    securityId: args.securityId,
    exDividendDate: args.exDate,
    declarationDate: null,
    recordDate: null,
    paymentDate: null,
    amount: args.amount,
    currency: args.currency ?? 'USD',
    source: 'alpha_vantage',
    fetchedAt: new Date(),
  });
}

async function makeInterestActivity(args: {
  accountId: number;
  householdId: number;
  securityId: number;
  tradeDate: string;
  amount: string;
  currency?: string;
}) {
  const fp = `test-interest:${args.accountId}:${args.securityId}:${args.tradeDate}:${args.amount}`;
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: args.householdId,
    securityId: args.securityId,
    activityType: 'interest',
    tradeDate: args.tradeDate,
    settlementDate: null,
    description: 'Test interest',
    quantity: null,
    price: null,
    amount: args.amount,
    fees: null,
    splitRatio: null,
    currency: args.currency ?? 'USD',
    sourceReference: 'test',
    sourceRowFingerprint: fp,
    importBatch: 'test',
  });
}

// -------------------------
// Tests
// -------------------------

test('builder: creates one row per held security on first build', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const secA = await makeSecurity(hh.id, { symbol: 'AAPL' });
  const secB = await makeSecurity(hh.id, { symbol: 'MSFT' });

  // secA: 100 shares, 4 quarterly dividends ($0.25 each = $1.00/year)
  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: secA.id, statementDate: '2025-05-01', quantity: '100' });
  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await makeDividend({ securityId: secA.id, exDate: '2025-05-15', amount: '0.25' });
  await makeDividend({ securityId: secA.id, exDate: '2025-08-15', amount: '0.25' });
  await makeDividend({ securityId: secA.id, exDate: '2025-11-15', amount: '0.25' });
  await makeDividend({ securityId: secA.id, exDate: '2026-02-15', amount: '0.25' });

  // secB: 50 shares, no dividends
  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: secB.id, statementDate: '2025-05-01', quantity: '50' });

  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 2, 'should create 2 rows');
  assert.equal(result.deleted, 0);

  const rows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 2);

  const rowA = rows.find((r) => r.securityId === secA.id)!;
  assert.ok(rowA, 'row for secA should exist');
  assert.ok(
    Math.abs(Number(rowA.annualDividendPerShare) - 1.0) < 0.01,
    `annualDividendPerShare should be ~1.0, got ${rowA.annualDividendPerShare}`,
  );
  assert.ok(
    Math.abs(Number(rowA.projectedAnnualIncomeNative) - 100) < 1,
    `projectedAnnualIncomeNative should be ~100, got ${rowA.projectedAnnualIncomeNative}`,
  );
  assert.equal(rowA.cadenceLabel, 'quarterly');
  assert.equal(rowA.staleAt, null);
});

test('builder: updates existing row and clears stale_at', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'VTI' });

  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '200' });
  const asOf = new Date('2026-05-01T00:00:00.000Z');

  // Pre-insert a stale row
  await models.PortfolioForwardProjection.create({
    householdId: hh.id,
    securityId: sec.id,
    qtyBasis: '100',
    annualDividendPerShare: '0',
    annualInterestPerShare: '0',
    projectedAnnualIncomeNative: '0',
    currency: 'USD',
    cadenceLabel: 'none',
    medianSpacingDays: null,
    cvPct: null,
    unreliable: false,
    nextExDivDates: [],
    computedAt: new Date('2026-01-01'),
    staleAt: new Date('2026-04-01'),
  });

  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 1);

  const rows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staleAt, null, 'staleAt should be cleared');
  assert.equal(Number(rows[0].qtyBasis), 200, 'qtyBasis should be updated to 200');
});

test('builder: deletes rows for securities no longer held', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'OLD' });

  // No holding for sec — pre-insert a projection row for it
  await models.PortfolioForwardProjection.create({
    householdId: hh.id,
    securityId: sec.id,
    qtyBasis: '50',
    annualDividendPerShare: '1',
    annualInterestPerShare: '0',
    projectedAnnualIncomeNative: '50',
    currency: 'USD',
    cadenceLabel: 'quarterly',
    medianSpacingDays: 91,
    cvPct: null,
    unreliable: false,
    nextExDivDates: [],
    computedAt: new Date('2026-01-01'),
    staleAt: null,
  });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 0, 'no current holdings → nothing to rebuild');
  assert.equal(result.deleted, 1, 'old row for no-longer-held security should be deleted');

  const rows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('builder: isolates households — rebuilding A does not touch B rows', async () => {
  const hhA = await makeHousehold('Household A');
  const hhB = await makeHousehold('Household B');
  const acctA = await makeAccount(hhA.id);
  const secA = await makeSecurity(hhA.id, { symbol: 'AAA' });
  const secB = await makeSecurity(hhB.id, { symbol: 'BBB' });

  await makeHolding({ accountId: acctA.id, householdId: hhA.id, securityId: secA.id, statementDate: '2025-05-01', quantity: '10' });

  // Pre-insert a row for household B
  await models.PortfolioForwardProjection.create({
    householdId: hhB.id,
    securityId: secB.id,
    qtyBasis: '20',
    annualDividendPerShare: '0',
    annualInterestPerShare: '0',
    projectedAnnualIncomeNative: '0',
    currency: 'USD',
    cadenceLabel: 'none',
    medianSpacingDays: null,
    cvPct: null,
    unreliable: false,
    nextExDivDates: [],
    computedAt: new Date('2026-01-01'),
    staleAt: null,
  });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await rebuildForwardProjectionsForHousehold(hhA.id, asOf);

  // B's row should be untouched
  const bRows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hhB.id } });
  assert.equal(bRows.length, 1, "household B's row should be untouched");
  assert.equal(bRows[0].securityId, secB.id);
});

test('builder: rebuildForwardProjectionsForAllHouseholds iterates all households', async () => {
  const hhA = await makeHousehold('All A');
  const hhB = await makeHousehold('All B');
  const acctA = await makeAccount(hhA.id);
  const acctB = await makeAccount(hhB.id);
  const secA = await makeSecurity(hhA.id, { symbol: 'ALFA' });
  const secB = await makeSecurity(hhB.id, { symbol: 'BETA' });

  await makeHolding({ accountId: acctA.id, householdId: hhA.id, securityId: secA.id, statementDate: '2025-05-01', quantity: '30' });
  await makeHolding({ accountId: acctB.id, householdId: hhB.id, securityId: secB.id, statementDate: '2025-05-01', quantity: '40' });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  const result = await rebuildForwardProjectionsForAllHouseholds(asOf);

  assert.equal(result.households, 2, 'should iterate 2 households');
  assert.equal(result.rebuilt, 2, 'should rebuild 1 row per household');
  assert.equal(result.deleted, 0);

  const totalRows = await models.PortfolioForwardProjection.findAll();
  assert.equal(totalRows.length, 2);
});

test('builder: counts interest activity in projection', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'BOND' });

  // 1000 bond shares, 2 semiannual interest payments of $25 each
  // perShare = $25 / 1000 = $0.025, annual = $0.05/share, projected = $50
  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '1000' });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await makeInterestActivity({ accountId: acct.id, householdId: hh.id, securityId: sec.id, tradeDate: '2025-06-01', amount: '25' });
  await makeInterestActivity({ accountId: acct.id, householdId: hh.id, securityId: sec.id, tradeDate: '2025-12-01', amount: '25' });

  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 1);

  const row = await models.PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
  assert.ok(row, 'projection row should exist');
  assert.ok(
    Math.abs(Number(row.annualInterestPerShare) - 0.05) < 0.001,
    `annualInterestPerShare should be ~0.05, got ${row.annualInterestPerShare}`,
  );
  assert.ok(
    Math.abs(Number(row.projectedAnnualIncomeNative) - 50) < 1,
    `projectedAnnualIncomeNative should be ~50, got ${row.projectedAnnualIncomeNative}`,
  );
  assert.equal(row.cadenceLabel, 'semiannual');
});

test('markStaleForHousehold: sets stale_at for all household rows', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const secA = await makeSecurity(hh.id, { symbol: 'SA' });
  const secB = await makeSecurity(hh.id, { symbol: 'SB' });

  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: secA.id, statementDate: '2025-05-01', quantity: '10' });
  await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: secB.id, statementDate: '2025-05-01', quantity: '20' });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await rebuildForwardProjectionsForHousehold(hh.id, asOf);

  await markStaleForHousehold(hh.id);

  const rows = await models.PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.staleAt !== null, `row for security ${row.securityId} should have staleAt set`);
  }
});

test('markStaleForAllHoldersOfSecurity: marks rows across households', async () => {
  const hhA = await makeHousehold('Stale A');
  const hhB = await makeHousehold('Stale B');
  const acctA = await makeAccount(hhA.id);
  const acctB = await makeAccount(hhB.id);
  const sec = await makeSecurity(null, { symbol: 'SHARED' });

  await makeHolding({ accountId: acctA.id, householdId: hhA.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '10' });
  await makeHolding({ accountId: acctB.id, householdId: hhB.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '20' });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await rebuildForwardProjectionsForHousehold(hhA.id, asOf);
  await rebuildForwardProjectionsForHousehold(hhB.id, asOf);

  await markStaleForAllHoldersOfSecurity(sec.id);

  const rows = await models.PortfolioForwardProjection.findAll({ where: { securityId: sec.id } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.staleAt !== null, `staleAt should be set for household ${row.householdId}`);
  }
});

test('builder: excludes holdings from closed investment accounts', async () => {
  const hh = await makeHousehold();
  const openAcct = await makeAccount(hh.id, { name: 'Open Brokerage' });
  // Closed before asOf — its holdings must NOT count toward the projection.
  const closedAcct = await makeAccount(hh.id, { name: 'Closed Margin', closedAt: '2024-12-19' });
  const sec = await makeSecurity(hh.id, { symbol: 'CADIV', currency: 'CAD' });

  // Open account: 100 shares. Closed account: 225 shares of the SAME security.
  await makeHolding({ accountId: openAcct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '100', currency: 'CAD' });
  await makeHolding({ accountId: closedAcct.id, householdId: hh.id, securityId: sec.id, statementDate: '2024-12-01', quantity: '225', currency: 'CAD' });

  // 4 quarterly dividends of $0.19 → $0.76/yr per share.
  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await makeDividend({ securityId: sec.id, exDate: '2025-05-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2025-08-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2025-11-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2026-02-15', amount: '0.19', currency: 'CAD' });

  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 1);

  const row = await models.PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
  assert.ok(row, 'projection row should exist');
  assert.equal(Number(row.qtyBasis), 100, `qtyBasis should be 100 (open account only), got ${row.qtyBasis}`);
  assert.ok(
    Math.abs(Number(row.projectedAnnualIncomeNative) - 76) < 1,
    `projectedAnnualIncomeNative should be ~76 (100 sh × $0.76), got ${row.projectedAnnualIncomeNative}`,
  );
});

test('builder: same-date duplicate snapshots resolve to the newest id (deterministic)', async () => {
  const hh = await makeHousehold();
  const acct = await makeAccount(hh.id);
  const sec = await makeSecurity(hh.id, { symbol: 'DUP' });

  // Two snapshots for the SAME (account, security, statementDate) — a
  // corrected re-import. By convention the newest row (highest id) is the
  // authoritative correction and must win. We insert the stale '250' first
  // (lower id) and the corrected '100' last (higher id). Without an explicit
  // ['id','DESC'] tiebreaker the 'statementDate DESC'-only order is
  // nondeterministic; SQLite's incidental rowid-asc ordering returns the
  // stale '250' first, so 'first seen wins' picks the wrong row.
  const stale = await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '250' });
  const corrected = await makeHolding({ accountId: acct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '100' });
  assert.ok(corrected.id > stale.id, 'precondition: corrected row has the higher id');

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 1);

  const row = await models.PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
  assert.ok(row, 'projection row should exist');
  assert.equal(Number(row.qtyBasis), 100, `qtyBasis should be 100 (newest id wins), got ${row.qtyBasis}`);
});

test('builder: counts accounts whose closedAt is after asOf (future close)', async () => {
  const hh = await makeHousehold();
  // closedAt is AFTER asOf → account is still open as of the projection date.
  const futureClosedAcct = await makeAccount(hh.id, { name: 'Future Close', closedAt: '2026-12-31' });
  const sec = await makeSecurity(hh.id, { symbol: 'CADIV', currency: 'CAD' });

  await makeHolding({ accountId: futureClosedAcct.id, householdId: hh.id, securityId: sec.id, statementDate: '2025-05-01', quantity: '100', currency: 'CAD' });

  const asOf = new Date('2026-05-01T00:00:00.000Z');
  await makeDividend({ securityId: sec.id, exDate: '2025-05-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2025-08-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2025-11-15', amount: '0.19', currency: 'CAD' });
  await makeDividend({ securityId: sec.id, exDate: '2026-02-15', amount: '0.19', currency: 'CAD' });

  const result = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
  assert.equal(result.rebuilt, 1);

  const row = await models.PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
  assert.ok(row, 'projection row should exist');
  assert.equal(Number(row.qtyBasis), 100, `future-closed account should still count, got qtyBasis ${row.qtyBasis}`);
});

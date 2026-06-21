/**
 * Fuzzy investment dedup — consumed-candidate tracking (sqlite-backed).
 *
 * Bug: the fuzzy-window matcher ran per-row inside the commit loop with no
 * tracking of already-matched existing rows, so two legitimate identical
 * activities within the ±5-day window (recurring buys of pinned-price assets,
 * equal staking rewards, equal interest postings) both "single-matched" the
 * SAME existing row and the second one was silently dropped as a duplicate:
 *   (a) intra-file: row 1 inserts, row 2 matches row 1 (visible inside the
 *       same SQL transaction) and is skipped → one real trade lost;
 *   (b) cross-period: DB holds lot 1 only, the export carries lots 1 and 2 —
 *       both rows match the DB copy of lot 1 and lot 2 is never inserted.
 *
 * The fix tracks consumed candidate ids (matched existing rows AND rows
 * inserted by this same commit) and excludes them from subsequent fuzzy
 * lookups, so each existing row absorbs at most one incoming row.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedInvestmentActivity, StatementPreview } from './statementTypes';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Fuzzy Dedup HH' } as never);
  const acc = await models.Account.create({
    name: `WS Invest ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'investment',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function buyRow(opts: {
  tradeDate: string;
  fingerprint: string;
  settlementDate?: string | null;
}): NormalizedInvestmentActivity {
  return {
    activityType: 'buy',
    tradeDate: opts.tradeDate,
    settlementDate: opts.settlementDate ?? null,
    description: `Bought 1 XEQT on ${opts.tradeDate}`,
    security: { symbol: 'XEQT', name: 'iShares XEQT', assetType: null, currency: 'CAD' },
    quantity: 1,
    price: 100,
    amount: -100,
    fees: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: opts.fingerprint,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  rows: NormalizedInvestmentActivity[],
): StatementPreview {
  return {
    previewToken: 'tok',
    fileName: 'activities-export.csv',
    contentHash: `hash-${Date.now()}-${Math.random()}`,
    accountId,
    householdId,
    importBatch: `batch-${Date.now()}-${Math.random()}`,
    usedParser: 'csv',
    transactions: [],
    investmentActivities: rows,
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    crossSourceDedup: 'fuzzy-window-5d',
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

test('cross-period: two identical lots in the export, one already in the DB → second lot is inserted', async () => {
  const { householdId, accountId } = await seedAccount();
  const security = await models.Security.create({
    householdId,
    symbol: 'XEQT',
    currency: 'CAD',
    name: 'iShares XEQT',
    assetType: null,
  } as never);
  // DB holds only the May-statement copy of lot 1.
  await models.InvestmentActivity.create({
    accountId,
    householdId,
    securityId: security.id,
    activityType: 'buy',
    tradeDate: '2026-05-10',
    settlementDate: null,
    description: 'Bought 1 XEQT',
    quantity: '1',
    price: '100',
    amount: '-100',
    fees: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: 'monthly-statement-lot-1',
    importBatch: 'monthly-may',
  } as never);

  // The activities export carries lots 1 (05-10) and 2 (05-12) — identical
  // type/symbol/qty/amount, two days apart (recurring buy of a pinned-price
  // asset). Both fall inside the ±5d window of the existing row.
  const preview = makePreview(accountId, householdId, [
    buyRow({ tradeDate: '2026-05-10', fingerprint: 'export-lot-1' }),
    buyRow({ tradeDate: '2026-05-12', fingerprint: 'export-lot-2' }),
  ]);
  const result = await commitStatementImport(preview, null, householdId);

  assert.equal(result.skippedDuplicates, 1, 'lot 1 must dedup against the existing DB row');
  assert.equal(
    result.insertedInvestmentActivities,
    1,
    'lot 2 must be inserted — it cannot consume the same candidate as lot 1',
  );
  const count = await models.InvestmentActivity.count({ where: { accountId } });
  assert.equal(count, 2, 'both real lots must exist after the import');
});

test('intra-file: two identical lots two days apart in one export → both inserted', async () => {
  const { householdId, accountId } = await seedAccount();

  const preview = makePreview(accountId, householdId, [
    buyRow({ tradeDate: '2026-05-10', fingerprint: 'export-lot-1' }),
    buyRow({ tradeDate: '2026-05-12', fingerprint: 'export-lot-2' }),
  ]);
  const result = await commitStatementImport(preview, null, householdId);

  assert.equal(
    result.insertedInvestmentActivities,
    2,
    'a row inserted by this same commit must not absorb a later row of the file',
  );
  assert.equal(result.skippedDuplicates, 0);
  const count = await models.InvestmentActivity.count({ where: { accountId } });
  assert.equal(count, 2);
});

test('re-running the same logical import still dedups (no regression)', async () => {
  const { householdId, accountId } = await seedAccount();

  const first = makePreview(accountId, householdId, [
    buyRow({ tradeDate: '2026-05-10', fingerprint: 'export-lot-1' }),
  ]);
  const r1 = await commitStatementImport(first, null, householdId);
  assert.equal(r1.insertedInvestmentActivities, 1);

  // Same logical event re-presented with a drifted date (monthly statement
  // vs export) and a different audit fingerprint → fuzzy match must absorb it.
  const second = makePreview(accountId, householdId, [
    buyRow({ tradeDate: '2026-05-11', fingerprint: 'statement-lot-1' }),
  ]);
  const r2 = await commitStatementImport(second, null, householdId);
  assert.equal(r2.insertedInvestmentActivities, 0);
  assert.equal(r2.skippedDuplicates, 1);
  const count = await models.InvestmentActivity.count({ where: { accountId } });
  assert.equal(count, 1);
});

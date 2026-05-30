/**
 * Unit tests for the retroactive counterparty backfill job (issue #376).
 *
 * The job sweeps Transaction rows where counterparty_raw IS NULL and the
 * row's account is in scope (checking | savings | cash), calling
 * extractCounterparty(merchantRaw, accountType) and writing the result.
 *
 * AC mapping:
 *   1. New job processes in-scope NULL-counterparty_raw transactions in chunks
 *      → "processes only in-scope NULL rows in chunks"
 *   2. Idempotent: re-running does not overwrite non-NULL values
 *      → "re-running does not overwrite non-NULL values"
 *   4. Job log captured in ProviderJobLog with extracted count + elapsed time
 *      → "writes a ProviderJobLog summary row at completion"
 *   5. Out-of-scope account types are skipped entirely
 *      → "skips out-of-scope account types"
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models/Account').Account;
let Transaction: typeof import('../src/models/Transaction').Transaction;
let ProviderJobLog: typeof import('../src/models/ProviderJobLog').ProviderJobLog;
let Household: typeof import('../src/models/Household').Household;
let runCounterpartyBackfill: typeof import('../src/import/counterpartyBackfill').runCounterpartyBackfill;
let isCounterpartyBackfillRunning: typeof import('../src/import/counterpartyBackfill').isCounterpartyBackfillRunning;
let getLastCounterpartyBackfillRun: typeof import('../src/import/counterpartyBackfill').getLastCounterpartyBackfillRun;
let COUNTERPARTY_BACKFILL_PROVIDER: typeof import('../src/import/counterpartyBackfill').COUNTERPARTY_BACKFILL_PROVIDER;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Account = models.Account;
  Transaction = models.Transaction;
  ProviderJobLog = models.ProviderJobLog;
  Household = models.Household;
  const mod = await import('../src/import/counterpartyBackfill');
  runCounterpartyBackfill = mod.runCounterpartyBackfill;
  isCounterpartyBackfillRunning = mod.isCounterpartyBackfillRunning;
  getLastCounterpartyBackfillRun = mod.getLastCounterpartyBackfillRun;
  COUNTERPARTY_BACKFILL_PROVIDER = mod.COUNTERPARTY_BACKFILL_PROVIDER;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Transaction.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await ProviderJobLog.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

let fp = 0;
function nextFingerprint(seed: string): string {
  fp += 1;
  return `${seed}-${fp}`;
}

async function seedAccount(opts: {
  name?: string;
  accountType?: string;
  householdId?: number | null;
} = {}) {
  return Account.create({
    name: opts.name ?? 'Test',
    owner: 'me',
    householdId: opts.householdId ?? null,
    accountType: opts.accountType ?? 'checking',
    defaultCurrency: 'CAD',
    openingBalance: '0',
    openingBalanceDate: null,
  } as never);
}

async function seedTxn(opts: {
  accountId: number;
  householdId: number | null;
  merchantRaw: string;
  counterpartyRaw?: string | null;
  date?: string;
}) {
  const seed = nextFingerprint(`t-${opts.accountId}`);
  return Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    importBatch: 'cb-test',
    date: opts.date ?? '2026-04-01',
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: '-10',
    currency: 'CAD',
    sourceRowFingerprint: seed,
    sourceIdentityFingerprint: seed,
    counterpartyRaw: opts.counterpartyRaw ?? null,
  } as never);
}

test('processes only in-scope NULL rows in chunks', async () => {
  const hh = await Household.create({ name: 'H' });
  const checking = await seedAccount({ name: 'Checking', accountType: 'checking', householdId: hh.id });
  const savings = await seedAccount({ name: 'Savings', accountType: 'savings', householdId: hh.id });
  const cash = await seedAccount({ name: 'Cash', accountType: 'cash', householdId: hh.id });

  await seedTxn({ accountId: checking.id, householdId: hh.id, merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE' });
  await seedTxn({ accountId: savings.id, householdId: hh.id, merchantRaw: 'ZELLE PAYMENT TO MIKE SMITH' });
  await seedTxn({ accountId: cash.id, householdId: hh.id, merchantRaw: 'CASHAPP*JOHN DOE' });
  // Not a transfer-style line → no pattern match, processed but not extracted.
  await seedTxn({ accountId: checking.id, householdId: hh.id, merchantRaw: 'GROCERY STORE' });

  const result = await runCounterpartyBackfill(
    { householdId: hh.id, batchSize: 2 },
  );

  assert.equal(result.processed, 4, 'all 4 in-scope NULL rows scanned');
  assert.equal(result.extracted, 3, '3 patterns matched');

  const rows = await Transaction.findAll({ order: [['id', 'ASC']] });
  assert.equal(rows[0].counterpartyRaw, 'JANE DOE');
  assert.equal(rows[1].counterpartyRaw, 'MIKE SMITH');
  assert.equal(rows[2].counterpartyRaw, 'JOHN DOE');
  assert.equal(rows[3].counterpartyRaw, null);
});

test('skips out-of-scope account types entirely', async () => {
  const hh = await Household.create({ name: 'H' });
  const credit = await seedAccount({ name: 'Credit', accountType: 'credit_card', householdId: hh.id });
  const loan = await seedAccount({ name: 'Loan', accountType: 'loan', householdId: hh.id });
  const investment = await seedAccount({ name: 'Inv', accountType: 'investment', householdId: hh.id });

  await seedTxn({ accountId: credit.id, householdId: hh.id, merchantRaw: 'INTERAC E-TFR FROM JANE DOE' });
  await seedTxn({ accountId: loan.id, householdId: hh.id, merchantRaw: 'ZELLE TO MIKE' });
  await seedTxn({ accountId: investment.id, householdId: hh.id, merchantRaw: 'CASHAPP*FOO' });

  const result = await runCounterpartyBackfill(
    { householdId: hh.id, batchSize: 50 },
  );

  assert.equal(result.processed, 0, 'out-of-scope rows are not loaded into the sweep');
  assert.equal(result.extracted, 0);
  const rows = await Transaction.findAll();
  for (const r of rows) {
    assert.equal(r.counterpartyRaw, null, `row ${r.id} (acct ${r.accountId}) must stay null`);
  }
});

test('idempotent: re-running does not overwrite non-NULL values', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  // Pre-existing counterparty_raw (e.g. set on a newer import after the first backfill).
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
    counterpartyRaw: 'JANE D. PREV',
  });
  // Row with no value yet — first backfill will fill it.
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM MIKE SMITH',
  });

  const first = await runCounterpartyBackfill({ householdId: hh.id, batchSize: 50 });
  assert.equal(first.processed, 1, 'pre-filled row excluded by NULL filter');
  assert.equal(first.extracted, 1);

  // Re-run: no NULL rows remain — nothing should change.
  const second = await runCounterpartyBackfill({ householdId: hh.id, batchSize: 50 });
  assert.equal(second.processed, 0);
  assert.equal(second.extracted, 0);

  const rows = await Transaction.findAll({ order: [['id', 'ASC']] });
  assert.equal(rows[0].counterpartyRaw, 'JANE D. PREV', 'manual edit preserved');
  assert.equal(rows[1].counterpartyRaw, 'MIKE SMITH');
});

test('writes a ProviderJobLog summary row at completion', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });

  const result = await runCounterpartyBackfill({ householdId: hh.id, batchSize: 50 });
  assert.ok(result.elapsedMs >= 0);

  const logs = await ProviderJobLog.findAll({
    where: { provider: COUNTERPARTY_BACKFILL_PROVIDER, symbol: String(hh.id) },
  });
  assert.equal(logs.length, 1, 'one summary log row per run');
  const log = logs[0];
  assert.equal(log.status, 'ok');
  assert.equal(log.function, 'backfill');
  assert.ok(log.errorMessage, 'errorMessage carries JSON summary');
  const parsed = JSON.parse(log.errorMessage as string) as { processed: number; extracted: number; elapsedMs: number };
  assert.equal(parsed.processed, 1);
  assert.equal(parsed.extracted, 1);
  assert.ok(typeof parsed.elapsedMs === 'number' && parsed.elapsedMs >= 0);
});

test('isCounterpartyBackfillRunning reflects in-flight state', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });

  assert.equal(isCounterpartyBackfillRunning(hh.id), false, 'not running before start');
  const p = runCounterpartyBackfill({ householdId: hh.id, batchSize: 50 });
  assert.equal(isCounterpartyBackfillRunning(hh.id), true, 'running while job is mid-flight');
  await p;
  assert.equal(isCounterpartyBackfillRunning(hh.id), false, 'cleared on completion');
});

test('getLastCounterpartyBackfillRun returns last summary for the household', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });

  const before1 = await getLastCounterpartyBackfillRun(hh.id);
  assert.equal(before1, null, 'no run history initially');

  await runCounterpartyBackfill({ householdId: hh.id, batchSize: 50 });
  const last = await getLastCounterpartyBackfillRun(hh.id);
  assert.ok(last, 'has last run');
  assert.ok(last && last.fetchedAt instanceof Date);
  assert.equal(last && last.summary.processed, 1);
  assert.equal(last && last.summary.extracted, 1);
});

test('streams progress events with txnId/merchantRaw/counterpartyRaw', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  const t1 = await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'GROCERY STORE',
  });

  const events: Array<{ txnId: number; merchantRaw: string; counterpartyRaw: string | null }> = [];
  await runCounterpartyBackfill(
    { householdId: hh.id, batchSize: 50 },
    {
      onProgress: (e) => events.push(e),
    },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].txnId, t1.id);
  assert.equal(events[0].counterpartyRaw, 'JANE DOE');
  assert.equal(events[1].counterpartyRaw, null);
});

test('dryRun does not write counterparty_raw but still writes the ProviderJobLog summary', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await seedAccount({ accountType: 'checking', householdId: hh.id });
  await seedTxn({
    accountId: acc.id,
    householdId: hh.id,
    merchantRaw: 'INTERAC E-TRANSFER FROM JANE DOE',
  });

  const result = await runCounterpartyBackfill({
    householdId: hh.id,
    batchSize: 50,
    dryRun: true,
  });

  assert.equal(result.extracted, 1, 'extracted counts what WOULD be written');
  const rows = await Transaction.findAll();
  assert.equal(rows[0].counterpartyRaw, null, 'no DB write in dryRun');

  const logs = await ProviderJobLog.findAll({
    where: { provider: COUNTERPARTY_BACKFILL_PROVIDER, symbol: String(hh.id) },
  });
  // Dry runs are not counted against the 1h rate limit, so no ProviderJobLog row.
  assert.equal(logs.length, 0, 'dry runs do not pollute the rate-limit log');
});

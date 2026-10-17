/**
 * Reconciliation gate — `commitStatementImport` must refuse a statement whose
 * own arithmetic does not add up.
 *
 * Background: several PDF statement parsers recompute the closing balance from
 * the opening balance plus the rows they parsed, and push a `parseError` when
 * the result disagrees with the printed closing balance. That error is the
 * parser saying "I misread this document". Before this gate, nothing acted on
 * it: every row was inserted anyway and the run was merely labelled `partial`.
 * A real RBC Royal Credit Line statement booked a +6,400 payment as a -6,400
 * withdrawal and leaked an interest row into principal; the gate caught it, the
 * import proceeded, and the account was wrong by 12,817.24 until found by hand.
 *
 * Contract proved here:
 *  - a blocking (reconciliation) parseError refuses the commit and inserts
 *    NOTHING — not one transaction, not an ImportHistory row;
 *  - `acceptUnreconciled: true` imports anyway and stamps the override on the
 *    ImportHistory row so it is auditable later;
 *  - an ordinary (non-blocking) parseError still imports exactly as before —
 *    one unreadable row is not the same class of problem;
 *  - a clean statement is untouched by any of this.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';

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
  const hh = await models.Household.create({ name: 'Recon HH' } as never);
  const acc = await models.Account.create({
    name: `RBC Credit Line ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'loan',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

let seq = 0;
function cashRow(amount: number): NormalizedCashTransaction {
  seq += 1;
  return {
    date: '2026-03-15',
    merchantRaw: `ROW ${seq}`,
    merchantClean: `Row ${seq}`,
    amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `recon-fp-${seq}-${Math.random()}`,
  };
}

function preview(opts: {
  householdId: number;
  accountId: number;
  transactions: NormalizedCashTransaction[];
  parseErrors?: StatementPreview['parseErrors'];
  rowErrors?: number;
}): StatementPreview {
  return {
    previewToken: `tok-${Math.random()}`,
    fileName: 'statement.pdf',
    contentHash: `hash-${Math.random()}`,
    accountId: opts.accountId,
    householdId: opts.householdId,
    importBatch: `batch-${Math.random()}`,
    usedParser: 'pdf',
    transactions: opts.transactions,
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: opts.rowErrors ?? 0,
    parseErrors: opts.parseErrors ?? [],
  };
}

const RECON_MESSAGE =
  'statement does not reconcile: opening 100.00 + sum -6400.00 = -6300.00, expected closing 6500.00';

test('a blocking reconciliation error refuses the commit and inserts nothing', async () => {
  const { householdId, accountId } = await seedAccount();
  const p = preview({
    householdId,
    accountId,
    transactions: [cashRow(-6400), cashRow(-12.5)],
    parseErrors: [{ rowIndex: -1, message: RECON_MESSAGE, blocking: true }],
  });

  await assert.rejects(
    () => commitStatementImport(p, null, householdId),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 422);
      assert.match(e.message, /does not reconcile/);
      assert.match(e.message, /acceptUnreconciled/);
      return true;
    },
  );

  assert.equal(await models.Transaction.count(), 0, 'no transactions may be inserted');
  assert.equal(await models.ImportHistory.count(), 0, 'no ImportHistory row may be written');
});

test('acceptUnreconciled imports anyway and records the override on ImportHistory', async () => {
  const { householdId, accountId } = await seedAccount();
  const p = preview({
    householdId,
    accountId,
    transactions: [cashRow(-6400), cashRow(-12.5)],
    parseErrors: [{ rowIndex: -1, message: RECON_MESSAGE, blocking: true }],
  });

  const result = await commitStatementImport(p, null, householdId, {
    acceptUnreconciled: true,
  });

  assert.equal(result.insertedTransactions, 2);
  assert.equal(result.acceptedUnreconciled, true);
  assert.equal(await models.Transaction.count(), 2);

  const history = await models.ImportHistory.findOne({ where: { contentHash: p.contentHash } });
  assert.ok(history, 'ImportHistory row written');
  assert.equal(history.acceptedUnreconciled, true);
  assert.match(String(history.errorMessage), /acceptUnreconciled/);
  assert.match(String(history.errorMessage), /does not reconcile/);
  // A statement imported over a failed reconciliation is never "success".
  assert.equal(history.status, 'partial');
});

test('a non-blocking parse error still imports exactly as before', async () => {
  const { householdId, accountId } = await seedAccount();
  const p = preview({
    householdId,
    accountId,
    transactions: [cashRow(-40)],
    parseErrors: [{ rowIndex: 7, message: 'Bad txn date: 31/31/2026' }],
    rowErrors: 1,
  });

  const result = await commitStatementImport(p, null, householdId);

  assert.equal(result.insertedTransactions, 1);
  assert.equal(result.acceptedUnreconciled, false);
  assert.equal(await models.Transaction.count(), 1);

  const history = await models.ImportHistory.findOne({ where: { contentHash: p.contentHash } });
  assert.ok(history);
  assert.equal(history.status, 'partial');
  assert.equal(history.acceptedUnreconciled, false);
  assert.match(String(history.errorMessage), /1 row\(s\) could not be parsed/);
});

test('a clean statement is unaffected by the gate', async () => {
  const { householdId, accountId } = await seedAccount();
  const p = preview({ householdId, accountId, transactions: [cashRow(-40), cashRow(120)] });

  const result = await commitStatementImport(p, null, householdId);

  assert.equal(result.insertedTransactions, 2);
  assert.equal(result.acceptedUnreconciled, false);

  const history = await models.ImportHistory.findOne({ where: { contentHash: p.contentHash } });
  assert.ok(history);
  assert.equal(history.status, 'success');
  assert.equal(history.acceptedUnreconciled, false);
  assert.equal(history.errorMessage, null);
});

test('acceptUnreconciled is inert on a statement that has no blocking error', async () => {
  const { householdId, accountId } = await seedAccount();
  const p = preview({ householdId, accountId, transactions: [cashRow(-40)] });

  const result = await commitStatementImport(p, null, householdId, {
    acceptUnreconciled: true,
  });

  assert.equal(result.acceptedUnreconciled, false, 'override only counts when it was needed');
  const history = await models.ImportHistory.findOne({ where: { contentHash: p.contentHash } });
  assert.equal(history?.status, 'success');
  assert.equal(history?.acceptedUnreconciled, false);
});

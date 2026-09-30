/**
 * Narrative-rename dedup — consumed-candidate tracking on the CASH ledger
 * (sqlite-backed).
 *
 * The narrative-rename tier in `findExistingForDedup` matches on
 * (account, date, amount, currency) with the merchant text deliberately
 * excluded, because the two Wealthsimple exports word the same cash event
 * differently. That key is not unique, so the commit loop must track which
 * existing rows earlier incoming rows already absorbed — exactly as it already
 * does for investment activities (see commitStatementImport.test.ts). Without
 * it, two incoming rows sharing the key both "match" the SAME existing row and
 * the second one is silently dropped: a real cash event lost.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;
let stableIdentityFingerprint: typeof import('./fingerprint.js').stableIdentityFingerprint;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
  stableIdentityFingerprint = (await import('./fingerprint.js')).stableIdentityFingerprint;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Rename Dedup HH' } as never);
  const acc = await models.Account.create({
    name: `WS Chequing ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
    shortCode: 'WK3DD9X35CAD',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function cashRow(opts: { date: string; amount: number; merchantRaw: string }): NormalizedCashTransaction {
  return {
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: opts.amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `row-${opts.merchantRaw}-${opts.date}-${opts.amount}`,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  rows: NormalizedCashTransaction[],
): StatementPreview {
  return {
    previewToken: 'tok',
    fileName: '2026-06 statement.pdf',
    contentHash: `hash-${Date.now()}-${Math.random()}`,
    accountId,
    householdId,
    importBatch: '2026-06 WK3DD9X35CAD',
    usedParser: 'pdf',
    transactions: rows,
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

async function seedExisting(opts: {
  accountId: number;
  householdId: number;
  date: string;
  amount: number;
  merchantRaw: string;
}): Promise<number> {
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: '2026-05 WK3DD9X35CAD',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    status: 'posted',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `existing-${Math.random()}`,
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency: 'CAD',
      merchantRaw: opts.merchantRaw,
    }),
    txnType: 'transfer',
    reviewFlag: false,
    isRecurring: false,
  } as never);
  return row.id as number;
}

test('two incoming rows sharing (date, amount) cannot both absorb the one existing row', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedExisting({
    accountId,
    householdId,
    date: '2026-02-05',
    amount: -40,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  // The 2026-06 re-import carries the already-imported charge under a generic
  // narrative AND a second, genuinely distinct -40 movement on the same day.
  const preview = makePreview(accountId, householdId, [
    cashRow({ date: '2026-02-05', amount: -40, merchantRaw: 'Cash correction (executed at 2026-02-05)' }),
    cashRow({ date: '2026-02-05', amount: -40, merchantRaw: 'Withdrawal' }),
  ]);
  const result = await commitStatementImport(preview, null, householdId);

  assert.equal(result.skippedDuplicates, 1, 'row 1 dedups against the existing row');
  assert.equal(
    result.insertedTransactions,
    1,
    'row 2 must insert — it cannot consume the same existing row as row 1',
  );
  assert.equal(await models.Transaction.count({ where: { accountId } }), 2);
});

test('a date-shifted near-duplicate is inserted but warned about', async () => {
  const { householdId, accountId } = await seedAccount();
  const existingId = await seedExisting({
    accountId, householdId, date: '2026-03-13', amount: -1000, merchantRaw: 'Withdrawal',
  });

  const preview = makePreview(accountId, householdId, [
    cashRow({ date: '2026-03-14', amount: -1000, merchantRaw: 'Cash correction (executed at 2026-03-14)' }),
  ]);
  const result = await commitStatementImport(preview, null, householdId);

  assert.equal(result.insertedTransactions, 1, 'the row still imports — dedup declined it');
  const warning = result.warnings.find((w) => w.includes('adjacent date'));
  assert.ok(warning, `expected an adjacent-date warning, got ${JSON.stringify(result.warnings)}`);
  assert.match(warning!, new RegExp(String(existingId)));
});

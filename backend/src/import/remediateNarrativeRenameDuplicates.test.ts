/**
 * Remediation of the narrative-rename duplicate rows already in the ledger
 * (sqlite-backed).
 *
 * The importer fix (tier 5 in dedupExisting.ts) stops NEW duplicates. It cannot
 * remove the ones already written: prod holds 40 confirmed pairs under an exact
 * date match and 64 under ±1 day, inflating Feb–Mar 2026 spend ~$19k and inflow
 * ~$79k. This module classifies them and, only on an explicit apply, deletes the
 * later-written side.
 *
 * Which side to drop is settled by evidence, not preference: in every confirmed
 * prod pair the duplicate is the LATER-written row, and it carries worse
 * metadata (import_confidence 'needs_review', txn_type flattened to 'transfer',
 * category reset to 'Uncategorized'). So rows are ordered by (created_at, id)
 * and the earliest is kept.
 *
 * The classifier is deliberately more permissive than live dedup — it runs once,
 * over a bounded set, against a pairing table a human reads before anything is
 * deleted. That is the same posture wsDepositActivityMigration took, and it is
 * why the ±1-day cluster is remediated here rather than by loosening live dedup.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let classifyNarrativeRenameDuplicates:
  typeof import('./remediateNarrativeRenameDuplicates.js').classifyNarrativeRenameDuplicates;
let applyNarrativeRenameRemediation:
  typeof import('./remediateNarrativeRenameDuplicates.js').applyNarrativeRenameRemediation;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  const mod = await import('./remediateNarrativeRenameDuplicates.js');
  classifyNarrativeRenameDuplicates = mod.classifyNarrativeRenameDuplicates;
  applyNarrativeRenameRemediation = mod.applyNarrativeRenameRemediation;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

let householdId: number;

async function makeAccount(name = 'WS Chequing'): Promise<number> {
  const hh = await models.Household.create({ name: 'Remediation HH' } as never);
  householdId = hh.id as number;
  const acc = await models.Account.create({
    name: `${name} ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  return acc.id as number;
}

async function seedTxn(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  importBatch: string;
  currency?: string;
  linkedTransactionId?: number | null;
  categoryOverrideId?: number | null;
}): Promise<number> {
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: opts.importBatch,
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: opts.currency ?? 'CAD',
    status: 'posted',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `fp-${Math.random()}`,
    sourceIdentityFingerprint: `idfp-${Math.random()}`,
    txnType: 'transfer',
    reviewFlag: false,
    isRecurring: false,
    linkedTransactionId: opts.linkedTransactionId ?? null,
    categoryOverrideId: opts.categoryOverrideId ?? null,
  } as never);
  return row.id as number;
}

test('a generic-narrative pair on the same date: keep the earlier row, drop the later', async () => {
  const accountId = await makeAccount();
  const keepId = await seedTxn({
    accountId, date: '2026-02-17', amount: -3548.34,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-02-17', amount: -3548.34,
    merchantRaw: 'Cash correction (executed at 2026-02-17)',
    importBatch: '2026-06 WK3DD9X35CAD',
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 0 });

  assert.equal(report.ambiguous.length, 0);
  assert.equal(report.blocked.length, 0);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].keepId, keepId);
  assert.equal(report.pairs[0].dropId, dropId);
  assert.equal(report.pairs[0].dateShiftDays, 0);
  assert.equal(report.pairs[0].matchReason, 'generic-narrative');
});

test('three rows within the window are ambiguous and nothing is paired', async () => {
  const accountId = await makeAccount();
  // The real prod shape: id 12123 at -200 sits one day from BOTH 1427 and 1430.
  const a = await seedTxn({
    accountId, date: '2026-10-22', amount: -200, merchantRaw: 'Transfer out',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const b = await seedTxn({
    accountId, date: '2026-10-23', amount: -200,
    merchantRaw: 'Money transfer out of the account (executed at 2026-10-23)',
    importBatch: 'WS deposit ledger cleanup',
  });
  const c = await seedTxn({
    accountId, date: '2026-10-24', amount: -200, merchantRaw: 'Transfer out',
    importBatch: '2026-05 WK3DD9X35CAD',
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 1 });

  assert.equal(report.pairs.length, 0, 'must not guess which of the three is the duplicate');
  assert.equal(report.ambiguous.length, 1);
  assert.deepEqual([...report.ambiguous[0].ids].sort((x, y) => x - y), [a, b, c]);
});

test('a one-day-apart pair is remediated at windowDays 1 and untouched at 0', async () => {
  const accountId = await makeAccount();
  const keepId = await seedTxn({
    accountId, date: '2026-07-09', amount: 3000,
    merchantRaw: 'Interac e-Transfer® Received', importBatch: '2026-05 WK3DD9X35CAD',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-07-10', amount: 3000,
    merchantRaw: 'Contribution (executed at 2026-07-10)',
    importBatch: 'WS deposit ledger cleanup',
  });

  const strict = await classifyNarrativeRenameDuplicates({ windowDays: 0 });
  assert.equal(strict.pairs.length, 0, 'exact-date sweep must not reach a shifted pair');

  const loose = await classifyNarrativeRenameDuplicates({ windowDays: 1 });
  assert.equal(loose.pairs.length, 1);
  assert.equal(loose.pairs[0].keepId, keepId);
  assert.equal(loose.pairs[0].dropId, dropId);
  assert.equal(loose.pairs[0].dateShiftDays, 1);
});

test('two rows from the SAME batch are one file, never a re-import pair', async () => {
  const accountId = await makeAccount();
  await seedTxn({
    accountId, date: '2026-03-16', amount: -2.5, merchantRaw: 'Withdrawal',
    importBatch: '2026-06 WK3DD9X35CAD',
  });
  await seedTxn({
    accountId, date: '2026-03-16', amount: -2.5, merchantRaw: 'Sh Vending',
    importBatch: '2026-06 WK3DD9X35CAD',
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 0 });
  assert.equal(report.pairs.length, 0);
  assert.equal(report.ambiguous.length, 0);
});

test('two specific merchants are not a pair even across batches', async () => {
  const accountId = await makeAccount();
  await seedTxn({
    accountId, date: '2026-03-16', amount: -5, merchantRaw: 'STARBUCKS #123',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  await seedTxn({
    accountId, date: '2026-03-16', amount: -5, merchantRaw: 'MCDONALDS #99',
    importBatch: '2026-06 WK3DD9X35CAD',
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 0 });
  assert.equal(report.pairs.length, 0);
});

test('whitespace-only merchant drift is paired and labelled as such', async () => {
  const accountId = await makeAccount('Amex Reserve');
  const keepId = await seedTxn({
    accountId, date: '2026-12-08', amount: -25,
    merchantRaw: 'STARBUCKS 8007827282   800-782-7282', importBatch: '2026-06 701001',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-12-08', amount: -25,
    merchantRaw: 'STARBUCKS 8007827282    800-782-7282', importBatch: '2026-05 Reserve',
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 0 });
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].matchReason, 'whitespace-drift');
  assert.equal(report.pairs[0].keepId, keepId);
  assert.equal(report.pairs[0].dropId, dropId);
});

test('a human-edited duplicate is blocked, not deleted', async () => {
  const accountId = await makeAccount();
  const keepId = await seedTxn({
    accountId, date: '2026-02-17', amount: -508.7,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-02-17', amount: -508.7,
    merchantRaw: 'Cash correction (executed at 2026-02-17)',
    importBatch: '2026-06 WK3DD9X35CAD',
    categoryOverrideId: 42,
  });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 0 });
  assert.equal(report.pairs.length, 0);
  assert.deepEqual(report.blocked, [
    { dropId, keepId, reason: 'category_override_id is set' },
  ]);
});

test('apply deletes only the paired duplicates and leaves ambiguous + blocked rows alone', async () => {
  const accountId = await makeAccount();
  // A clean pair.
  const keepId = await seedTxn({
    accountId, date: '2026-02-05', amount: 2525, merchantRaw: 'Cash received',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-02-05', amount: 2525,
    merchantRaw: 'Cash correction (executed at 2026-02-05)',
    importBatch: '2026-06 WK3DD9X35CAD',
  });
  // A blocked duplicate (human-edited).
  const blockedKeep = await seedTxn({
    accountId, date: '2026-02-06', amount: -99, merchantRaw: 'Bar Burrito',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const blockedDrop = await seedTxn({
    accountId, date: '2026-02-06', amount: -99, merchantRaw: 'Withdrawal',
    importBatch: '2026-06 WK3DD9X35CAD', categoryOverrideId: 7,
  });
  // An ambiguous trio.
  const amb = [
    await seedTxn({ accountId, date: '2026-02-08', amount: -12, merchantRaw: 'Withdrawal', importBatch: '2026-05 X' }),
    await seedTxn({ accountId, date: '2026-02-08', amount: -12, merchantRaw: 'Tim Hortons', importBatch: '2026-06 X' }),
    await seedTxn({ accountId, date: '2026-02-08', amount: -12, merchantRaw: 'Withdrawal', importBatch: '2026-06 X' }),
  ];

  const result = await applyNarrativeRenameRemediation({ windowDays: 0 });

  assert.equal(result.deletedTransactions, 1);
  assert.deepEqual(result.deletedIds, [dropId]);
  assert.equal(result.report.blocked.length, 1);
  assert.equal(result.report.ambiguous.length, 1);

  assert.equal(await models.Transaction.findByPk(dropId), null, 'the duplicate is gone');
  assert.ok(await models.Transaction.findByPk(keepId), 'the original survives');
  for (const id of [blockedKeep, blockedDrop, ...amb]) {
    assert.ok(await models.Transaction.findByPk(id), `row ${id} must be untouched`);
  }
});

test('apply unwinds transfer links on both sides before deleting', async () => {
  const accountId = await makeAccount();
  const partner = await seedTxn({
    accountId, date: '2026-03-18', amount: 10960.52, merchantRaw: 'PAYMENT RECEIVED',
    importBatch: 'amex-side',
  });
  const keepId = await seedTxn({
    accountId, date: '2026-03-18', amount: -10960.52,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    importBatch: '2026-05 WK3DD9X35CAD',
  });
  const dropId = await seedTxn({
    accountId, date: '2026-03-18', amount: -10960.52,
    merchantRaw: 'Withdrawal (executed at 2026-03-18)',
    importBatch: '2026-06 WK3DD9X35CAD',
    // The transfer-linker already wired the duplicate to the Amex leg: 18 of
    // the 40 prod duplicates carry a linked_transaction_id.
    linkedTransactionId: partner,
  });
  // …and the partner points back at the duplicate.
  await models.Transaction.update(
    { linkedTransactionId: dropId },
    { where: { id: partner } },
  );

  const result = await applyNarrativeRenameRemediation({ windowDays: 0 });

  assert.deepEqual(result.deletedIds, [dropId]);
  assert.equal(result.unlinkedTransactions, 1, 'the inbound link must be nulled');
  const partnerRow = await models.Transaction.findByPk(partner);
  assert.equal(partnerRow!.linkedTransactionId, null, 'no dangling pointer to a deleted row');
  assert.ok(await models.Transaction.findByPk(keepId));
});

/**
 * A cluster confined to ONE import batch cannot contain a re-import of itself,
 * so it is not a remediation question and must not be reported. Prod has
 * hundreds of these at windowDays 1 — recurring weekly "TO FIND & SAVE"
 * transfers of equal size on consecutive days — and reporting them buried the
 * 61 real pairs under 94 irrelevant clusters.
 */
test('a same-batch cluster is not reported as ambiguous', async () => {
  const accountId = await makeAccount();
  for (const date of ['2026-04-06', '2026-04-07', '2026-04-08']) {
    await seedTxn({
      accountId, date, amount: -50, merchantRaw: 'TO FIND & SAVE',
      importBatch: '2026-06 6985',
    });
  }

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 1 });
  assert.deepEqual(report, { pairs: [], ambiguous: [], blocked: [] });
});

test('a cross-batch cluster with no plausible rename is not reported as ambiguous', async () => {
  const accountId = await makeAccount();
  await seedTxn({ accountId, date: '2026-04-06', amount: -50, merchantRaw: 'STARBUCKS #1', importBatch: 'a' });
  await seedTxn({ accountId, date: '2026-04-07', amount: -50, merchantRaw: 'MCDONALDS #2', importBatch: 'b' });
  await seedTxn({ accountId, date: '2026-04-08', amount: -50, merchantRaw: 'WENDYS #3', importBatch: 'c' });

  const report = await classifyNarrativeRenameDuplicates({ windowDays: 1 });
  assert.deepEqual(report, { pairs: [], ambiguous: [], blocked: [] });
});

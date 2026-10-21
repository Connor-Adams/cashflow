import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Household, Transaction, TransactionRevision, sequelize } from '../models';
import {
  RetypeAborted,
  applyFindAndSaveRetype,
  isFindAndSaveSweep,
  needsFindAndSaveFix,
  scanFindAndSave,
  spendImpactByYear,
} from './retypeFindAndSave';

// ─── Predicates ─────────────────────────────────────────────────────────────

const sweep = { merchantRaw: 'TO FIND & SAVE', merchantClean: 'TO FIND & SAVE', amount: -17 };

test('the prod sweep narrative is a Find & Save transfer', () => {
  assert.equal(isFindAndSaveSweep({ ...sweep, txnType: 'purchase' }), true);
});

test('a grocer with "save" in its name is not', () => {
  assert.equal(
    isFindAndSaveSweep({ merchantRaw: 'SAVE ON FOODS #2231', merchantClean: 'SAVE ON FOODS', amount: -54, txnType: 'purchase' }),
    false,
  );
});

test('needs the fix when the type or the category is wrong, not when both are right', () => {
  assert.equal(needsFindAndSaveFix({ ...sweep, txnType: 'purchase', finalCategory: 'Groceries' }), true);
  assert.equal(needsFindAndSaveFix({ ...sweep, txnType: 'transfer', finalCategory: 'Groceries' }), true);
  assert.equal(needsFindAndSaveFix({ ...sweep, txnType: 'transfer', finalCategory: 'Transfer' }), false);
});

test('spend impact sums only rows leaving purchase, by year', () => {
  const row = (id: number, date: string, amount: string, fromType: string) => ({
    id, accountId: 19, date, amount, merchantRaw: 'TO FIND & SAVE', fromType, fromCategory: 'Groceries',
  });
  assert.deepEqual(
    spendImpactByYear([
      row(1, '2019-06-04', '-17.00', 'purchase'),
      row(2, '2019-06-05', '-16.00', 'purchase'),
      row(3, '2020-01-02', '-5.10', 'purchase'),
      row(4, '2020-01-03', '-75.00', 'transfer'),
    ]),
    [
      { year: '2019', count: 2, total: -33 },
      { year: '2020', count: 1, total: -5.1 },
    ],
  );
});

// ─── DB-backed ──────────────────────────────────────────────────────────────

let HH: number;
let chequing: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  chequing = (await Account.create({ name: 'RBC', householdId: HH, accountType: 'checking' } as never)).id;
});

async function txn(
  merchantRaw: string,
  amount: string,
  txnType: string,
  extra: Record<string, unknown> = {},
): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    sourceRowFingerprint: `row-${seq}`,
    sourceIdentityFingerprint: `identity-${seq}`,
    householdId: HH,
    accountId: chequing,
    importBatch: 'rbc-6985',
    visibility: 'private',
    ownershipType: 'me',
    date: '2023-09-25',
    merchantRaw,
    merchantClean: merchantRaw,
    amount,
    currency: 'CAD',
    reviewFlag: true,
    txnType,
    autoCategory: 'Groceries',
    finalCategory: 'Groceries',
    autoSource: 'ai',
    autoConfidence: 'medium',
    ...extra,
  } as never);
}

async function seed() {
  const a = await txn('TO FIND & SAVE', '-17.00', 'purchase');
  const b = await txn('TO FIND & SAVE', '-16.00', 'purchase', { date: '2024-01-03' });
  const linked = await txn('TO FIND & SAVE', '-75.00', 'transfer');
  const reviewed = await txn('TO FIND & SAVE', '-12.00', 'purchase', { reviewedAt: new Date() });
  const overridden = await txn('TO FIND & SAVE', '-11.00', 'purchase', { categoryOverride: 'Savings' });
  const edited = await txn('TO FIND & SAVE', '-10.00', 'purchase');
  await TransactionRevision.create({
    transactionId: edited.id,
    householdId: HH,
    changedByUserId: null,
    aiSuggestionId: null,
    source: 'user_edit',
    changes: JSON.stringify([{ field: 'notes', before: null, after: 'hmm' }]),
  });
  const grocer = await txn('SAVE ON FOODS #2231', '-54.00', 'purchase');
  const done = await txn('AUTO TRANSFER FROM FIND & SAVE', '120.00', 'transfer', {
    autoCategory: 'Transfer',
    finalCategory: 'Transfer',
  });
  return { a, b, linked, reviewed, overridden, edited, grocer, done };
}

test('scan: splits re-type, category-only, and person-touched rows; grocer and fixed row ignored', async () => {
  const s = await seed();
  const scan = await scanFindAndSave();
  assert.deepEqual(scan.retype.map((r) => r.id), [s.a.id, s.b.id]);
  assert.deepEqual(scan.recategorise.map((r) => r.id), [s.linked.id]);
  assert.deepEqual(
    scan.skipped.map((r) => [r.id, r.reasons]),
    [
      [s.reviewed.id, ['reviewed']],
      [s.overridden.id, ['category_override']],
      [s.edited.id, ['user_edited']],
    ],
  );
});

test('apply: writes transfer / Transfer row by row with a revision each; skipped rows untouched', async () => {
  const s = await seed();
  const revisionsBefore = await TransactionRevision.count();
  const { written } = await applyFindAndSaveRetype({ expect: 3 });
  assert.equal(written, 3);

  for (const t of [s.a, s.b, s.linked]) {
    const row = (await Transaction.findByPk(t.id))!;
    assert.equal(row.txnType, 'transfer');
    assert.equal(row.autoCategory, 'Transfer');
    assert.equal(row.finalCategory, 'Transfer');
    assert.equal(row.autoSource, 'type-detect');
    assert.equal(row.reviewFlag, false);
    const revisions = await TransactionRevision.findAll({ where: { transactionId: t.id } });
    assert.equal(revisions.length, 1, `row ${t.id} has a revision`);
  }
  assert.equal(await TransactionRevision.count(), revisionsBefore + 3);

  for (const t of [s.reviewed, s.overridden, s.edited, s.grocer]) {
    const row = (await Transaction.findByPk(t.id))!;
    assert.equal(row.txnType, 'purchase', `row ${t.id} untouched`);
  }
  assert.equal((await Transaction.findByPk(s.overridden.id))!.finalCategory, 'Groceries');
});

test('apply: a count that differs from --expect writes nothing', async () => {
  const s = await seed();
  const revisionsBefore = await TransactionRevision.count();
  await assert.rejects(applyFindAndSaveRetype({ expect: 2 }), RetypeAborted);
  assert.equal((await Transaction.findByPk(s.a.id))!.txnType, 'purchase');
  assert.equal(await TransactionRevision.count(), revisionsBefore);
});

test('apply: a second run finds nothing left to do', async () => {
  await seed();
  await applyFindAndSaveRetype({ expect: 3 });
  const scan = await scanFindAndSave();
  assert.equal(scan.retype.length + scan.recategorise.length, 0);
  assert.equal(scan.skipped.length, 3);
});

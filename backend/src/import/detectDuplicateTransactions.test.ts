/**
 * The period-bounded duplicate detector.
 *
 * Detect and report only: it changes no row. Part 3 calls it per T1 request as a
 * completeness gap, and part 4 runs it once to produce Connor's worklist. Neither
 * needs supersession state, which is why this part was scoped back from
 * "detect, supersede and exclude".
 *
 * Bounded to a period because of part 3: an unbounded whole-ledger scan on every
 * T1 request is a latency problem, and there is no reason to look at 2023 to tell
 * Connor what 2026 overstates.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account, Category, Entity, Household, Receipt, Transaction } from '../models';
import { detectDuplicateTransactions } from './detectDuplicateTransactions';

let householdId: number;
let entityId: number;
let accountId: number;
let otherAccountId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const household = await Household.create({ name: 'Dup HH' });
  householdId = household.id;
  const entity = await Entity.create({
    householdId, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  entityId = entity.id;
  const account = await Account.create({
    name: 'WS Chequing', householdId, accountType: 'checking',
    entityId, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
  const other = await Account.create({
    name: 'Amex', householdId, accountType: 'credit',
    entityId, taxStatus: 'n_a', defaultCurrency: 'CAD',
  } as never);
  otherAccountId = other.id;
});

let fp = 0;
async function txn(over: Record<string, unknown>) {
  fp += 1;
  return Transaction.create({
    accountId, householdId, entityId,
    date: '2026-02-11', amount: '-2000', currency: 'CAD',
    merchantRaw: 'M', merchantClean: 'M',
    importBatch: 'b', sourceRowFingerprint: `fp${fp}`, sourceIdentityFingerprint: `sif${fp}`,
    ...over,
  } as never);
}

const period = () => ({ householdId, startDate: '2026-01-01', endDate: '2026-12-31' });

test('two legs sharing one counterpart are reported certain', async () => {
  const counterpart = await txn({ date: '2026-02-11', amount: '2000' });
  await txn({ linkedTransactionId: counterpart.id });
  await txn({ linkedTransactionId: counterpart.id });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.certain.length, 1);
  assert.equal(report.review.length, 0);
  assert.equal(report.certain[0].rows.length, 2);
});

test('two unlinked identical rows are reported for review', async () => {
  // The recurring-fee shape: same account, date and amount, no link.
  await txn({ amount: '-6.00' });
  await txn({ amount: '-6.00' });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.certain.length, 0);
  assert.equal(report.review.length, 1);
});

test('it changes no row', async () => {
  await txn({ amount: '-6.00' });
  await txn({ amount: '-6.00' });
  const before = await Transaction.findAll({ order: [['id', 'ASC']] });
  const snapshot = before.map((t) => JSON.stringify(t.toJSON()));
  await detectDuplicateTransactions(period());
  const after = await Transaction.findAll({ order: [['id', 'ASC']] });
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((t) => JSON.stringify(t.toJSON())), snapshot);
});

test('the detector is period-bounded: a 2026 call does not scan 2023', async () => {
  await txn({ date: '2023-05-05', amount: '-99' });
  await txn({ date: '2023-05-05', amount: '-99' });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.groups.length, 0);
  const wide = await detectDuplicateTransactions({
    householdId, startDate: '2023-01-01', endDate: '2026-12-31',
  });
  assert.equal(wide.groups.length, 1);
});

test('the period bounds are inclusive on both ends', async () => {
  await txn({ date: '2026-01-01', amount: '-1' });
  await txn({ date: '2026-01-01', amount: '-1' });
  await txn({ date: '2026-12-31', amount: '-2' });
  await txn({ date: '2026-12-31', amount: '-2' });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.groups.length, 2);
});

test('a differing amount, date or account is not a group', async () => {
  await txn({ amount: '-2000' });
  await txn({ amount: '-2000.01' });
  await txn({ date: '2026-02-12' });
  await txn({ accountId: otherAccountId });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.groups.length, 0, JSON.stringify(report.groups));
});

test('amounts are compared by value, not by string form', async () => {
  // Sequelize hands DECIMAL back as a string whose form depends on the dialect;
  // '-2000' and '-2000.00' are one amount and must group.
  await txn({ amount: '-2000' });
  await txn({ amount: '-2000.00' });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.groups.length, 1);
});

test('an inherited category treatment pushes a certain group to review', async () => {
  // The route the obvious shortcut misses: parent classifies, child is 'none',
  // the per-transaction override is null.
  const parent = await Category.create({
    householdId, name: 'Medical', taxTreatment: 'medical_expense', parentId: null,
  } as never);
  const child = await Category.create({
    householdId, name: 'Dentist', taxTreatment: 'none', parentId: parent.id,
  } as never);
  const counterpart = await txn({ amount: '2000' });
  await txn({ linkedTransactionId: counterpart.id, finalCategoryId: child.id });
  await txn({ linkedTransactionId: counterpart.id });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.certain.length, 0);
  assert.equal(report.review.length, 1);
  assert.ok(report.review[0].reasons.some((r) => /classif/i.test(r)), report.review[0].reasons.join('; '));
});

test('an attached receipt pushes a certain group to review', async () => {
  const counterpart = await txn({ amount: '2000' });
  const a = await txn({ linkedTransactionId: counterpart.id });
  await txn({ linkedTransactionId: counterpart.id });
  await Receipt.create({
    transactionId: a.id, householdId,
    storedFilename: 'r.pdf', originalName: 'r.pdf',
    mimeType: 'application/pdf', sizeBytes: 1024,
  } as never);
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.review.length, 1);
  assert.ok(report.review[0].reasons.some((r) => /receipt/i.test(r)), report.review[0].reasons.join('; '));
});

test('the report totals the overstatement, counting surplus rows only', async () => {
  // Three rows at -2,000 overstate by -4,000, not -6,000. Part 3's dollar figures
  // depend on this distinction.
  const counterpart = await txn({ amount: '2000' });
  await txn({ linkedTransactionId: counterpart.id });
  await txn({ linkedTransactionId: counterpart.id });
  await txn({ linkedTransactionId: counterpart.id });
  const report = await detectDuplicateTransactions(period());
  assert.equal(report.certain.length, 1);
  assert.equal(report.totalDuplicatedAmount, '-4000.00');
});

test('accountIds narrows the scan', async () => {
  await txn({ accountId: otherAccountId, amount: '-20.73' });
  await txn({ accountId: otherAccountId, amount: '-20.73' });
  await txn({ amount: '-6.00' });
  await txn({ amount: '-6.00' });
  const only = await detectDuplicateTransactions({ ...period(), accountIds: [otherAccountId] });
  assert.equal(only.groups.length, 1);
  assert.equal(only.groups[0].accountId, otherAccountId);
});

test('entityId narrows the scan', async () => {
  // Part 3 calls it per entity: a corp duplicate is not a personal T1 gap.
  const corp = await Entity.create({
    householdId, kind: 'corp', legalName: 'CDG',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  await txn({ entityId: corp.id, amount: '-7500' });
  await txn({ entityId: corp.id, amount: '-7500' });
  await txn({ amount: '-6.00' });
  await txn({ amount: '-6.00' });
  const personal = await detectDuplicateTransactions({ ...period(), entityId });
  assert.equal(personal.groups.length, 1);
  assert.equal(personal.groups[0].amount, '-6.00');
});

test('a scope is required — an unbounded whole-ledger scan is refused', async () => {
  await assert.rejects(
    () => detectDuplicateTransactions({ startDate: '2026-01-01', endDate: '2026-12-31' } as never),
    /scope/i,
  );
});

test('groups are ordered by date then account, so the worklist is stable', async () => {
  await txn({ date: '2026-03-01', amount: '-5' });
  await txn({ date: '2026-03-01', amount: '-5' });
  await txn({ date: '2026-01-15', amount: '-7' });
  await txn({ date: '2026-01-15', amount: '-7' });
  const report = await detectDuplicateTransactions(period());
  assert.deepEqual(report.groups.map((g) => g.date), ['2026-01-15', '2026-03-01']);
});

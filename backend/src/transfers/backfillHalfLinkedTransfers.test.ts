import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Household, Transaction, TransactionRevision, sequelize } from '../models';
import { BackfillAborted } from './backfillHalfLinkedCsvTransfers';
import {
  applyHalfLinkedTransferBackfill,
  classifyHalfLinkedTransfers,
  summarizeByClass,
} from './backfillHalfLinkedTransfers';

let HH: number;
let chequing: number;
let savings: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  chequing = (await Account.create({ name: 'RBC', householdId: HH, accountType: 'checking' } as never)).id;
  savings = (await Account.create({ name: 'WS', householdId: HH, accountType: 'savings' } as never)).id;
});

async function txn(over: Record<string, unknown>): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    householdId: HH,
    visibility: 'private',
    ownershipType: 'me',
    importBatch: 'b',
    date: '2026-05-15',
    merchantRaw: 'X',
    merchantClean: 'X',
    currency: 'CAD',
    reviewFlag: false,
    sourceRowFingerprint: `row-${seq}`,
    sourceIdentityFingerprint: `identity-${seq}`,
    ...over,
  } as never);
}

/** A (chequing, out) points at B (savings, in); B does not point back. */
async function halfLink(bOver: Record<string, unknown> = {}, amount = 100) {
  const b = await txn({ accountId: savings, amount: String(amount), txnType: 'unknown', ...bOver });
  const a = await txn({ accountId: chequing, amount: String(-amount), txnType: 'transfer', linkedTransactionId: b.id });
  return { a, b };
}

/** What the pre-guard enrichment backfill left behind: B's pointer at A cleared by `system`. */
async function clearedByJob(type = 'unknown') {
  const { a, b } = await halfLink({ txnType: type });
  await TransactionRevision.create({
    transactionId: b.id,
    householdId: HH,
    source: 'system',
    changes: JSON.stringify([
      { field: 'linkedTransactionId', before: a.id, after: null },
      { field: 'txnType', before: 'transfer', after: type },
    ]),
  } as never);
  return { a, b };
}

async function seedAllClasses() {
  const safe = await halfLink();
  const cleared = await clearedByJob();
  const reviewed = await halfLink({ reviewedAt: new Date() });
  const income = await clearedByJob('income');
  const shared = await halfLink();
  await txn({ accountId: chequing, amount: '-100', txnType: 'payment', linkedTransactionId: shared.b.id });
  // Whole pair: not a half-link at all.
  const whole = await halfLink();
  await whole.b.update({ linkedTransactionId: whole.a.id });
  return { safe, cleared, reviewed, income, shared, whole };
}

test('classify: one class per half-link, ambiguous with its reason', async () => {
  const s = await seedAllClasses();
  const rows = await classifyHalfLinkedTransfers();
  const clsOf = (aId: number) => rows.find((r) => r.aId === aId);
  assert.equal(clsOf(s.safe.a.id)?.cls, 'safe');
  assert.equal(clsOf(s.cleared.a.id)?.cls, 'cleared_by_job');
  assert.deepEqual([clsOf(s.reviewed.a.id)?.cls, clsOf(s.reviewed.a.id)?.reason], ['ambiguous', 'sibling_reviewed']);
  assert.deepEqual(
    [clsOf(s.income.a.id)?.cls, clsOf(s.income.a.id)?.reason],
    ['ambiguous', 'sibling_type_conflict'],
    'an income sibling is not closed as a transfer leg, whoever typed it',
  );
  assert.equal(clsOf(s.shared.a.id)?.reason, 'sibling_claimed_twice');
  assert.equal(clsOf(s.whole.a.id), undefined, 'a whole pair is not listed');

  const summary = Object.fromEntries(summarizeByClass(rows).map((c) => [c.cls, c]));
  assert.equal(summary.safe.pairs, 1);
  assert.equal(summary.cleared_by_job.pairs, 1);
  assert.equal(summary.ambiguous.pairs, 4);
  assert.deepEqual(summary.ambiguous.reasons, {
    sibling_reviewed: 1,
    sibling_type_conflict: 1,
    sibling_claimed_twice: 2,
  });
});

test('apply: closes only the chosen classes and never ambiguous', async () => {
  const s = await seedAllClasses();
  const now = new Date('2026-10-20T20:00:00Z');
  const { fixed } = await applyHalfLinkedTransferBackfill({ classes: ['safe'], expectPairs: 1, now });
  assert.equal(fixed, 1);

  const b = (await Transaction.findByPk(s.safe.b.id))!;
  assert.equal(b.linkedTransactionId, s.safe.a.id);
  assert.equal(b.transferLinkedAt?.getTime(), now.getTime());
  assert.equal(b.txnType, 'transfer', 'a guessed sibling becomes transfer');
  assert.equal((await Transaction.findByPk(s.safe.a.id))!.transferLinkedAt?.getTime(), now.getTime());

  assert.equal((await Transaction.findByPk(s.cleared.b.id))!.linkedTransactionId, null, 'not chosen');
  assert.equal((await Transaction.findByPk(s.reviewed.b.id))!.linkedTransactionId, null, 'ambiguous untouched');
  assert.equal((await Transaction.findByPk(s.income.b.id))!.txnType, 'income');
});

test('apply: cleared_by_job is closable when asked for', async () => {
  const s = await seedAllClasses();
  const { fixed } = await applyHalfLinkedTransferBackfill({ classes: ['safe', 'cleared_by_job'], expectPairs: 2 });
  assert.equal(fixed, 2);
  assert.equal((await Transaction.findByPk(s.cleared.b.id))!.linkedTransactionId, s.cleared.a.id);
  const rows = await classifyHalfLinkedTransfers();
  assert.deepEqual([...new Set(rows.map((r) => r.cls))], ['ambiguous'], 'only ambiguous remain');
});

test('apply: an --expect mismatch writes nothing', async () => {
  const s = await seedAllClasses();
  await assert.rejects(applyHalfLinkedTransferBackfill({ classes: ['safe'], expectPairs: 79 }), BackfillAborted);
  assert.equal((await Transaction.findByPk(s.safe.b.id))!.linkedTransactionId, null);
});

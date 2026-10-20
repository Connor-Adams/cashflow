/**
 * The enrichment backfill must never break an established transfer link.
 *
 * It wrote whatever the matcher returned straight into `linked_transaction_id`.
 * Prod txn 992's revision history flips 2895 → 2954 → 2895 across reruns, and two
 * rows (5456, 2895) ended up pointing at 992. A link is established — and left
 * alone — when it is reciprocal, was set by a person (`POST /api/transfers/link`
 * stamps `transfer_linked_at`) or sits on a reviewed row.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Transaction, TransactionSignal, Household } from '../models';
import { runBackfill, type BackfillFlags } from './runEnrichmentBackfill';

let HH: number;
let out: number;
let into: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'Links' } as never);
  HH = hh.id;
  out = (await Account.create({ name: 'Chequing', householdId: HH } as never)).id;
  into = (await Account.create({ name: 'Savings', householdId: HH } as never)).id;
});

beforeEach(async () => {
  await TransactionSignal.destroy({ where: {} });
  await Transaction.destroy({ where: {} });
});

async function leg(accountId: number, date: string, amount: string): Promise<Transaction> {
  fp += 1;
  const merchant = amount.startsWith('-') ? 'Online transfer sent' : 'Online transfer received';
  return Transaction.create({
    accountId, householdId: HH, importBatch: 'links', date,
    merchantRaw: merchant, merchantClean: merchant, amount, currency: 'CAD',
    txnType: 'transfer',
    sourceRowFingerprint: `fp-links-${fp}`, sourceIdentityFingerprint: `sif-links-${fp}`,
  } as never);
}

function flags(): BackfillFlags {
  return {
    dryRun: false, noReviewFlag: false, reviewOnly: false, verbose: false,
    accountId: null, householdId: HH, limit: null, batchSize: 100, dateFrom: null, dateTo: null,
  };
}

async function linkOf(id: number): Promise<number | null> {
  return (await Transaction.findByPk(id))?.linkedTransactionId ?? null;
}

/**
 * X (out) is linked to Y (in, a day later). Z (in, same day as X) is the
 * matcher's closer pick — the decoy that would steal X.
 */
async function seedPairWithDecoy() {
  const x = await leg(out, '2026-03-04', '-100.00');
  const y = await leg(into, '2026-03-05', '100.00');
  const z = await leg(into, '2026-03-04', '100.00');
  return { x, y, z };
}

test('a manual link (transfer_linked_at set) survives a backfill rerun', async () => {
  const { x, y, z } = await seedPairWithDecoy();
  const linkedAt = new Date();
  await x.update({ linkedTransactionId: y.id, transferLinkedAt: linkedAt });
  await y.update({ linkedTransactionId: x.id, transferLinkedAt: linkedAt });

  await runBackfill(flags());

  assert.equal(await linkOf(x.id), y.id, 'X keeps its manual partner');
  assert.equal(await linkOf(y.id), x.id, 'Y keeps its manual partner');
  assert.equal(await linkOf(z.id), null, 'the decoy must not latch onto a taken leg');
});

test('a reciprocal auto link survives a backfill rerun', async () => {
  const { x, y, z } = await seedPairWithDecoy();
  await x.update({ linkedTransactionId: y.id });
  await y.update({ linkedTransactionId: x.id });

  await runBackfill(flags());

  assert.equal(await linkOf(x.id), y.id);
  assert.equal(await linkOf(y.id), x.id);
  assert.equal(await linkOf(z.id), null);
});

test('an unlinked pair is still linked by the backfill', async () => {
  const x = await leg(out, '2026-03-10', '-250.00');
  const y = await leg(into, '2026-03-10', '250.00');

  await runBackfill(flags());

  assert.equal(await linkOf(x.id), y.id);
});

// ─── every link the backfill writes is two-way ──────────────────────────────

async function row(id: number): Promise<Transaction> {
  return (await Transaction.findByPk(id))!;
}

test('a link the backfill creates is two-way, with transfer_linked_at on both legs', async () => {
  const x = await leg(out, '2026-03-12', '-75.00');
  const y = await leg(into, '2026-03-12', '75.00');

  await runBackfill(flags());

  const [xa, ya] = [await row(x.id), await row(y.id)];
  assert.equal(xa.linkedTransactionId, y.id);
  assert.equal(ya.linkedTransactionId, x.id, 'the sibling points back');
  assert.ok(xa.transferLinkedAt, 'forward leg stamped');
  assert.ok(ya.transferLinkedAt, 'sibling stamped');
  assert.equal(xa.transferLinkedAt!.getTime(), ya.transferLinkedAt!.getTime(), 'one link, one moment');
});

test('a guessed sibling is re-typed transfer when the backfill links it', async () => {
  const x = await leg(out, '2026-03-13', '-80.00');
  fp += 1;
  const y = await Transaction.create({
    accountId: into, householdId: HH, importBatch: 'links', date: '2026-03-13',
    merchantRaw: 'Contribution', merchantClean: 'Contribution', amount: '80.00', currency: 'CAD',
    txnType: 'unknown',
    sourceRowFingerprint: `fp-links-${fp}`, sourceIdentityFingerprint: `sif-links-${fp}`,
  } as never);

  await runBackfill(flags());

  const ya = await row(y.id);
  assert.equal(ya.linkedTransactionId, x.id);
  assert.equal(ya.txnType, 'transfer');
});

test('a half-link the matcher only re-derives is left for an explicit repair', async () => {
  const x = await leg(out, '2026-03-14', '-90.00');
  fp += 1;
  // The far leg reads as a guess, so its own pass never hunts for a sibling.
  const y = await Transaction.create({
    accountId: into, householdId: HH, importBatch: 'links', date: '2026-03-14',
    merchantRaw: 'Contribution', merchantClean: 'Contribution', amount: '90.00', currency: 'CAD',
    txnType: 'unknown',
    sourceRowFingerprint: `fp-links-${fp}`, sourceIdentityFingerprint: `sif-links-${fp}`,
  } as never);
  await x.update({ linkedTransactionId: y.id }); // one-sided, unstamped: an older run's output

  await runBackfill(flags());

  assert.equal(await linkOf(x.id), y.id);
  assert.equal(await linkOf(y.id), null, 'no reverse pointer written for a pre-existing half-link');
  assert.equal((await row(y.id)).transferLinkedAt, null);
});

test('a leg that already points at the matched row is completed two-way', async () => {
  const x = await leg(out, '2026-03-15', '-95.00');
  const y = await leg(into, '2026-03-15', '95.00');
  await x.update({ linkedTransactionId: y.id }); // one-sided; y's own pass re-finds x

  await runBackfill(flags());

  const [xa, ya] = [await row(x.id), await row(y.id)];
  assert.equal(xa.linkedTransactionId, y.id);
  assert.equal(ya.linkedTransactionId, x.id, 'the pair is whole, as it was before this change');
  assert.ok(xa.transferLinkedAt && ya.transferLinkedAt, 'and now stamped');
});

test('a two-way linked row keeps transfer/payment when re-enrichment can only guess', async () => {
  for (const kept of ['transfer', 'payment'] as const) {
    await Transaction.destroy({ where: {} });
    const x = await leg(out, '2026-03-16', '-120.00');
    fp += 1;
    const y = await Transaction.create({
      accountId: into, householdId: HH, importBatch: 'links', date: '2026-03-16',
      merchantRaw: 'Contribution', merchantClean: 'Contribution', amount: '120.00', currency: 'CAD',
      txnType: kept,
      sourceRowFingerprint: `fp-links-${fp}`, sourceIdentityFingerprint: `sif-links-${fp}`,
    } as never);
    const linkedAt = new Date();
    await x.update({ linkedTransactionId: y.id, transferLinkedAt: linkedAt });
    await y.update({ linkedTransactionId: x.id, transferLinkedAt: linkedAt });

    await runBackfill(flags());

    assert.equal((await row(y.id)).txnType, kept, `'Contribution' reads as unknown, but the link says ${kept}`);
  }
});

test('an unlinked row still gets its re-derived guess', async () => {
  fp += 1;
  const y = await Transaction.create({
    accountId: into, householdId: HH, importBatch: 'links', date: '2026-03-17',
    merchantRaw: 'Contribution', merchantClean: 'Contribution', amount: '33.00', currency: 'CAD',
    txnType: 'transfer',
    sourceRowFingerprint: `fp-links-${fp}`, sourceIdentityFingerprint: `sif-links-${fp}`,
  } as never);

  await runBackfill(flags());

  assert.equal((await row(y.id)).txnType, 'unknown', 'no link, so nothing vouches for transfer');
});

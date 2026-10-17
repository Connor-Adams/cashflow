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

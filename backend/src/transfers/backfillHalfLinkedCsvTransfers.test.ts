import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Account,
  Household,
  ImportHistory,
  Transaction,
  TransactionRevision,
  sequelize,
} from '../models';
import {
  BackfillAborted,
  applyHalfLinkedCsvTransferBackfill,
  classifyImportSource,
  pickImportHistory,
  scanHalfLinkedCsvTransfers,
  summarizeByHousehold,
} from './backfillHalfLinkedCsvTransfers';

const HOUR = 3600_000;

function history(fileName: string, startedAt: Date, finishedAt: Date | null = startedAt) {
  return { fileName, profileId: null, startedAt, finishedAt };
}

test('classifyImportSource: direct CSV vs WS bundle vs PDF vs SimpleFIN', () => {
  const june = new Date('2026-06-03T12:00:00Z');
  assert.equal(classifyImportSource(history('download-transactions.csv', june)), 'csv_direct');
  assert.equal(classifyImportSource(history('WS-statement-transactions.csv', june)), 'csv_wsbundle');
  assert.equal(
    classifyImportSource(history('WS-statement-transactions.csv', new Date('2026-05-01T00:00:00Z'))),
    'csv_direct',
    'before the bundle importer existed, a statement-transactions CSV went through importCsvFile',
  );
  assert.equal(classifyImportSource(history('Statement.PDF', june)), 'pdf');
  assert.equal(classifyImportSource({ ...history('feed', june), profileId: 'simplefin' }), 'simplefin');
  assert.equal(classifyImportSource(history('ledger-cleanup', june)), 'other');
  assert.equal(classifyImportSource(null), 'unmatched');
});

test('pickImportHistory: the run window containing createdAt beats a nearer start', () => {
  const at = new Date('2026-06-03T12:00:30Z');
  const pdf = history('a.pdf', new Date('2026-06-03T12:00:40Z'));
  const csv = history('a.csv', new Date('2026-06-03T11:59:00Z'), new Date('2026-06-03T12:01:00Z'));
  assert.equal(pickImportHistory(at, [pdf, csv]), csv);
});

test('pickImportHistory: nearest start when no window matches; null when none', () => {
  const at = new Date('2026-06-03T12:00:00Z');
  const near = history('near.csv', new Date('2026-06-03T12:10:00Z'));
  const far = history('far.pdf', new Date('2026-06-03T09:00:00Z'));
  assert.equal(pickImportHistory(at, [far, near]), near);
  assert.equal(pickImportHistory(at, []), null);
});

// ─── DB-backed ──────────────────────────────────────────────────────────────

let HH: number;
let chequing: number;
let amex: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  chequing = (await Account.create({ name: 'RBC', householdId: HH, accountType: 'checking' } as never)).id;
  amex = (await Account.create({ name: 'Amex', householdId: HH, accountType: 'credit_card' } as never)).id;
});

let seq = 0;

async function txn(over: Partial<Record<string, unknown>>): Promise<Transaction> {
  seq += 1;
  return Transaction.create({
    sourceRowFingerprint: `row-${seq}`,
    sourceIdentityFingerprint: `identity-${seq}`,
    householdId: HH,
    visibility: 'private',
    ownershipType: 'me',
    date: '2026-05-15',
    merchantClean: 'X',
    currency: 'CAD',
    reviewFlag: false,
    ...over,
  } as never);
}

async function importRun(batchLabel: string, fileName: string, startedAt: Date, finishedAt: Date) {
  await ImportHistory.create({
    batchLabel,
    fileName,
    filePathSafe: fileName,
    contentHash: `${batchLabel}-${fileName}`,
    status: 'success',
    startedAt,
    finishedAt,
    householdId: HH,
  } as never);
}

/** A CSV-imported card payment pointing at a card leg that does not point back. */
async function halfLinkedPair(batch: string, bType = 'unknown') {
  const b = await txn({
    accountId: amex,
    importBatch: 'amex-pdf',
    merchantRaw: 'PAYMENT RECEIVED - THANK YOU',
    amount: '250.00',
    txnType: bType,
  });
  const a = await txn({
    accountId: chequing,
    importBatch: batch,
    merchantRaw: 'MISC PAYMENT AMEX BILL PYMT',
    amount: '-250.00',
    txnType: 'payment',
    linkedTransactionId: b.id,
  });
  return { a, b };
}

async function seedScenario() {
  const now = Date.now();
  // One batch label holds a PDF and a CSV run, as `<month> <account>` labels do in prod.
  await importRun('2026-06 6985', 'chequing.pdf', new Date(now - 2 * HOUR), new Date(now - 2 * HOUR + 1000));
  await importRun('2026-06 6985', 'download-transactions.csv', new Date(now - 60_000), new Date(now + 60_000));
  await importRun('pdf-only', 'chequing.pdf', new Date(now - 60_000), new Date(now + 60_000));

  const target = await halfLinkedPair('2026-06 6985');
  const fromPdf = await halfLinkedPair('pdf-only');

  // Two CSV rows claim the same sibling: no single right reverse pointer.
  const contested = await halfLinkedPair('2026-06 6985', 'payment');
  await txn({
    accountId: chequing,
    importBatch: '2026-06 6985',
    merchantRaw: 'MISC PAYMENT AMEX BILL PYMT',
    amount: '-250.00',
    txnType: 'payment',
    linkedTransactionId: contested.b.id,
  });

  // Already whole: both legs point at each other.
  const whole = await halfLinkedPair('2026-06 6985', 'payment');
  await whole.b.update({ linkedTransactionId: whole.a.id });

  return { target, fromPdf, contested, whole };
}

test('scan: finds only the direct-CSV half-link, with skip reasons for the rest', async () => {
  const { target } = await seedScenario();
  const { pairs, skipped } = await scanHalfLinkedCsvTransfers();
  assert.deepEqual(pairs, [
    { householdId: HH, aId: target.a.id, bId: target.b.id, aNeedsStamp: true, bRetype: true },
  ]);
  assert.equal(skipped.not_csv_direct, 1);
  assert.equal(skipped.sibling_claimed_twice, 2);
  assert.deepEqual(summarizeByHousehold(pairs), [
    { householdId: HH, pairs: 1, aStamped: 1, bRetyped: 1, examples: [[target.a.id, target.b.id]] },
  ]);
});

test('scan: amount mismatch and same-account links are skipped', async () => {
  const now = Date.now();
  await importRun('csv', 'x.csv', new Date(now - 60_000), new Date(now + 60_000));
  const off = await halfLinkedPair('csv');
  await off.b.update({ amount: '249.00' });
  const b = await txn({ accountId: chequing, importBatch: 'csv', merchantRaw: 'IN', amount: '10', txnType: 'unknown' });
  await txn({
    accountId: chequing,
    importBatch: 'csv',
    merchantRaw: 'OUT',
    amount: '-10',
    txnType: 'transfer',
    linkedTransactionId: b.id,
  });
  const { pairs, skipped } = await scanHalfLinkedCsvTransfers();
  assert.equal(pairs.length, 0);
  assert.equal(skipped.amount_mismatch, 1);
  assert.equal(skipped.same_account, 1);
});

test('apply: links both ways, stamps, re-types only a guessed sibling, records revisions', async () => {
  const { target, fromPdf, contested } = await seedScenario();
  const now = new Date('2026-10-20T12:00:00Z');
  const { fixed } = await applyHalfLinkedCsvTransferBackfill({ expectPairs: 1, now });
  assert.equal(fixed, 1);

  const a = await Transaction.findByPk(target.a.id);
  const b = await Transaction.findByPk(target.b.id);
  assert.equal(b!.linkedTransactionId, a!.id);
  assert.equal(b!.transferLinkedAt?.getTime(), now.getTime());
  assert.equal(a!.transferLinkedAt?.getTime(), now.getTime());
  assert.equal(b!.txnType, 'transfer', "an 'unknown' sibling is a guess and becomes transfer");
  assert.equal(a!.txnType, 'payment', 'the forward leg keeps its type');

  const revisions = await TransactionRevision.findAll({ where: { transactionId: b!.id } });
  assert.equal(revisions.length, 1, 'the sibling write is audited');

  // Out-of-scope rows are untouched.
  assert.equal((await Transaction.findByPk(fromPdf.b.id))!.linkedTransactionId, null);
  assert.equal((await Transaction.findByPk(contested.b.id))!.linkedTransactionId, null);

  // Idempotent: nothing left to do.
  assert.equal((await scanHalfLinkedCsvTransfers()).pairs.length, 0);
  assert.equal((await applyHalfLinkedCsvTransferBackfill()).fixed, 0);
});

test('apply: a sibling with a narrative type keeps it', async () => {
  const now = Date.now();
  await importRun('csv', 'x.csv', new Date(now - 60_000), new Date(now + 60_000));
  const { b } = await halfLinkedPair('csv', 'payment');
  await applyHalfLinkedCsvTransferBackfill();
  assert.equal((await Transaction.findByPk(b.id))!.txnType, 'payment');
});

test('apply: an --expect mismatch writes nothing', async () => {
  const { target } = await seedScenario();
  await assert.rejects(applyHalfLinkedCsvTransferBackfill({ expectPairs: 33 }), BackfillAborted);
  const b = await Transaction.findByPk(target.b.id);
  assert.equal(b!.linkedTransactionId, null);
  assert.equal(b!.transferLinkedAt, null);
});

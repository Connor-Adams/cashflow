/**
 * CSV import and statement import must write the same Transaction for the same
 * row. They used to build it in two drifted copies; the CSV copy never stamped
 * `transferLinkedAt`, never wrote the reverse pointer onto the matched leg, never
 * extracted a counterparty and never normalized the source reference, so a
 * CSV-imported transfer stayed half-linked in the Transfers unmatched queue.
 *
 * Each scenario resets the DB and seeds identically, so ids line up and the two
 * importers' rows can be compared column for column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  sequelize,
  Account,
  Household,
  HouseholdMember,
  Transaction,
  User,
} from '../models';
import { importCsvFile } from './runImport';
import { commitStatementImport } from './commitStatementImport';
import { rowFingerprint } from './fingerprint';
import type { StatementPreview } from './statementTypes';
import { normalizeMerchant } from './normalizeMerchant';
import { resetTestDb } from '../../test/helpers/resetTestDb';

type Row = { date: string; merchantRaw: string; amount: number; reference?: string };
type Importer = 'csv' | 'statement';

const WS_ROWS: Row[] = [
  // Quoted reference: both importers must store it as bare AT26.
  { date: '2026-05-15', merchantRaw: 'Online transfer received - 6113 Connor Adams', amount: 500, reference: "'AT26'" },
];
const CHEQUING_ROWS: Row[] = [
  { date: '2026-05-10', merchantRaw: 'BOTTLE RETURN DEPOT', amount: -40 },
  { date: '2026-05-12', merchantRaw: 'INTERAC E-TFR FROM JANE DOE', amount: 250 },
  { date: '2026-05-14', merchantRaw: 'BOTTLE RETURN DEPOT', amount: 40 },
  { date: '2026-05-15', merchantRaw: 'Online transfer sent - 6113 Connor Adams', amount: -500 },
];

async function seed(): Promise<{ householdId: number; userId: number; wsId: number; chequingId: number }> {
  await resetTestDb(sequelize);
  const household = await Household.create({ name: 'Parity' });
  const user = await User.create({
    email: 'owner@example.com',
    displayName: 'Connor Adams',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  } as never);
  await HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' } as never);
  const ws = await Account.create({
    name: 'WS Cash',
    householdId: household.id,
    ownerUserId: user.id,
    accountType: 'checking',
    defaultCurrency: 'CAD',
  } as never);
  const chequing = await Account.create({
    name: 'RBC Chequing',
    householdId: household.id,
    ownerUserId: user.id,
    accountType: 'checking',
    defaultCurrency: 'CAD',
  } as never);
  return { householdId: household.id, userId: user.id, wsId: ws.id, chequingId: chequing.id };
}

function preview(accountId: number, householdId: number, batch: string, rows: Row[]): StatementPreview {
  return {
    previewToken: crypto.randomBytes(8).toString('hex'),
    fileName: `${batch}.csv`,
    contentHash: crypto.randomBytes(16).toString('hex'),
    accountId,
    householdId,
    importBatch: batch,
    usedParser: 'csv',
    usedProfileId: 'generic_passthrough',
    profileInferred: false,
    transactions: rows.map((r) => ({
      date: r.date,
      merchantRaw: r.merchantRaw,
      merchantClean: normalizeMerchant(r.merchantRaw),
      amount: r.amount,
      currency: 'CAD',
      sourceReference: r.reference ?? null,
      sourceRowFingerprint: rowFingerprint({
        accountId,
        date: r.date,
        amount: r.amount,
        currency: 'CAD',
        merchantRaw: r.merchantRaw,
        sourceReference: r.reference ?? null,
      }),
    })),
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  } as StatementPreview;
}

function csv(rows: Row[]): Buffer {
  const lines = ['Date,Description,Amount,Reference'];
  for (const r of rows) {
    const ref = r.reference ?? '';
    lines.push(`${r.date},"${r.merchantRaw}",${r.amount},${ref}`);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function importRows(
  importer: Importer,
  ctx: Awaited<ReturnType<typeof seed>>,
  accountId: number,
  batch: string,
  rows: Row[],
): Promise<void> {
  if (importer === 'csv') {
    const r = await importCsvFile({
      buffer: csv(rows),
      fileName: `${batch}.csv`,
      profileId: 'generic_passthrough',
      accountId,
      batchLabel: batch,
      householdId: ctx.householdId,
      userId: ctx.userId,
    });
    assert.equal((r as { inserted?: number }).inserted, rows.length, JSON.stringify(r));
  } else {
    const r = await commitStatementImport(preview(accountId, ctx.householdId, batch, rows), ctx.userId, ctx.householdId);
    assert.equal(r.insertedTransactions, rows.length, JSON.stringify(r));
  }
}

/** Every column, with wall-clock values reduced to "set or not". */
async function snapshot(): Promise<Record<string, unknown>[]> {
  const rows = await Transaction.findAll({ order: [['id', 'ASC']], raw: true });
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...(r as unknown as Record<string, unknown>) };
    delete out.createdAt;
    delete out.updatedAt;
    out.transferLinkedAt = out.transferLinkedAt != null;
    return out;
  });
}

async function runScenario(importer: Importer): Promise<Record<string, unknown>[]> {
  const ctx = await seed();
  await importRows(importer, ctx, ctx.wsId, 'ws-may', WS_ROWS);
  await importRows(importer, ctx, ctx.chequingId, 'chq-may', CHEQUING_ROWS);
  return snapshot();
}

function byMerchant(rows: Record<string, unknown>[], merchantRaw: string, amount: number): Record<string, unknown> {
  const hit = rows.find((r) => r.merchantRaw === merchantRaw && Number(r.amount) === amount);
  assert.ok(hit, `row ${merchantRaw} ${amount} present`);
  return hit!;
}

test('CSV and statement import write identical Transaction rows for equivalent input', async () => {
  const fromCsv = await runScenario('csv');
  const fromStatement = await runScenario('statement');
  assert.equal(fromCsv.length, 5);
  assert.deepEqual(fromCsv, fromStatement);
});

for (const importer of ['csv', 'statement'] as const) {
  test(`${importer} import: transfer legs link both ways`, async () => {
    const rows = await runScenario(importer);
    const received = byMerchant(rows, 'Online transfer received - 6113 Connor Adams', 500);
    const sent = byMerchant(rows, 'Online transfer sent - 6113 Connor Adams', -500);
    assert.equal(sent.linkedTransactionId, received.id, 'new leg points at the sibling');
    assert.equal(received.linkedTransactionId, sent.id, 'sibling points back');
    assert.equal(sent.transferLinkedAt, true);
    assert.equal(received.transferLinkedAt, true);
    assert.equal(sent.txnType, 'transfer');
    assert.equal(received.txnType, 'transfer');
  });

  test(`${importer} import: shared builder columns are populated`, async () => {
    const rows = await runScenario(importer);
    const received = byMerchant(rows, 'Online transfer received - 6113 Connor Adams', 500);
    assert.equal(received.sourceReference, 'AT26', 'surrounding quotes stripped');
    for (const r of rows) {
      assert.equal(r.status, 'posted');
      assert.equal(r.sourceTier, 'authoritative');
    }
    const interac = byMerchant(rows, 'INTERAC E-TFR FROM JANE DOE', 250);
    assert.equal(interac.counterpartyRaw, 'JANE DOE');
    assert.ok(interac.counterpartyContactId != null, 'counterparty resolved to a contact');
  });

  test(`${importer} import: a refund link is not treated as a transfer link`, async () => {
    const rows = await runScenario(importer);
    const purchase = byMerchant(rows, 'BOTTLE RETURN DEPOT', -40);
    const refund = byMerchant(rows, 'BOTTLE RETURN DEPOT', 40);
    assert.equal(refund.txnType, 'refund');
    assert.equal(refund.linkedTransactionId, purchase.id, 'refund points at its original');
    assert.equal(refund.transferLinkedAt, false);
    assert.equal(purchase.linkedTransactionId, null, 'no reverse pointer onto the purchase');
    assert.equal(purchase.transferLinkedAt, false);
    assert.equal(purchase.txnType, 'purchase', 'purchase not re-typed transfer');
  });
}

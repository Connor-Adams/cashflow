/**
 * Integration tests for POST /api/external-orders/import-pdf.
 * Runs in isolation (`yarn test:integration`) so DATABASE_URL is set before
 * any Sequelize import.
 *
 * The receipt-import scenarios run twice: once against SYNTHETIC receipts
 * rendered to PDFs at test time (made-up values, always runs, including CI),
 * and once against Connor's REAL receipts (gitignored under
 * backend/test/fixtures/pdf/; LOCAL-ONLY, loud skip in CI).
 */
// Test boilerplate (setup, login, teardown) is acceptably duplicated across integration tests.
// fallow-ignore-file code-duplication
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import { skipUnlessPrivateFixtures } from '../helpers/privateFixtures.js';
import { synthPdf } from '../helpers/syntheticPdf.js';
import { SYN_COSTCO_R1, SYN_COSTCO_R2 } from '../helpers/syntheticStatements.js';
let models: typeof import('../../src/models/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const fixturesDir = path.join(backendRoot, 'test', 'fixtures', 'pdf');
const r1Path = path.join(fixturesDir, 'costco-till-2025-12-13.pdf');
const r2Path = path.join(fixturesDir, 'costco-till-2025-12-26.pdf');

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  testDb = await setupPgTestDb('pdf-receipt');

  models = await import('../../src/models/index.js');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'pdf-receipt@example.com',
    displayName: 'Receipt User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /import-pdf: rejects non-PDF mime', async () => {
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', Buffer.from('not a pdf', 'utf8'), {
      filename: 'fake.txt',
      contentType: 'text/plain',
    });
  assert.equal(res.status, 400);
});

test('POST /import-pdf: rejects missing file', async () => {
  const res = await authed.post('/api/external-orders/import-pdf');
  assert.equal(res.status, 400);
});

test('POST /import-pdf-bulk: rejects an upload with no files', async () => {
  const res = await authed.post('/api/external-orders/import-pdf-bulk');
  assert.equal(res.status, 400);
});

test('POST /import-pdf-bulk: a non-PDF fails only its own entry', async () => {
  const res = await authed
    .post('/api/external-orders/import-pdf-bulk')
    .attach('files', Buffer.from('not a pdf', 'utf8'), {
      filename: 'fake.txt',
      contentType: 'text/plain',
    });

  // The batch itself succeeds; the file is reported as failed.
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.results[0].filename, 'fake.txt');
  assert.equal(res.body.results[0].status, 'failed');
});

// ---------------------------------------------------------------------------
// Receipt-import scenarios, parametrised over the fixture set. The tests in one
// set are ORDERED: later ones rely on the orders the earlier ones created.
// ---------------------------------------------------------------------------

type Tender = { paymentLast4: string | null; network: string; amount: number };
type ReceiptFixtures = {
  /** Appended to each test name ('' keeps the original private-fixture names). */
  suffix: string;
  /** Unique per set: keeps seeded fingerprints from colliding across sets. */
  key: string;
  skip?: string;
  r1: () => Buffer;
  r2: () => Buffer;
  r1Expected: {
    orderId: string; total: number; subtotal: number; tax: number; itemCount: number; tender: Tender;
  };
  r2Expected: {
    orderId: string; date: string; total: number; tenders: [Tender, Tender];
    merchantRaw: string; cardAccountName: string; cardNotes: string;
  };
};

function registerReceiptImportTests(f: ReceiptFixtures): void {
  const opts = { skip: f.skip };

  test(`POST /import-pdf: R1 (single-tender Costco) persists order + 1 tender + items${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r1(), { filename: 'r1.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, true);
    assert.equal(res.body.parserId, 'costco_till_receipt');
    assert.deepEqual(res.body.warnings, []);
    assert.equal(res.body.extracted.vendor, 'costco');
    assert.equal(res.body.extracted.orderId, f.r1Expected.orderId);
    assert.equal(res.body.extracted.total, f.r1Expected.total);
    assert.equal(res.body.extracted.tenders.length, 1);

    // DB-level checks: 1 tender row, every catalog + TPD line as an item
    const orderId = res.body.order.id as number;
    const tenders = await models.ExternalOrderTender.findAll({ where: { externalOrderId: orderId } });
    assert.equal(tenders.length, 1);
    assert.equal(tenders[0].paymentLast4, f.r1Expected.tender.paymentLast4);
    assert.equal(tenders[0].network, f.r1Expected.tender.network);
    assert.equal(Number(tenders[0].amount), f.r1Expected.tender.amount);

    const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: orderId } });
    assert.equal(items.length, f.r1Expected.itemCount);

    const order = await models.ExternalOrder.findByPk(orderId);
    assert.equal(Number(order!.subtotal), f.r1Expected.subtotal);
    assert.equal(Number(order!.tax), f.r1Expected.tax);
    assert.equal(order!.currency, 'CAD');
  });

  test(`POST /import-pdf: re-uploading R1 is idempotent (created=false, no duplicate tenders)${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r1(), { filename: 'r1-again.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200);
    assert.equal(res.body.created, false);

    // Confirm exactly one ExternalOrder for that orderId, one tender row.
    const orders = await models.ExternalOrder.findAll({
      where: { vendorOrderId: f.r1Expected.orderId },
    });
    assert.equal(orders.length, 1);
    const tenders = await models.ExternalOrderTender.findAll({
      where: { externalOrderId: orders[0].id },
    });
    assert.equal(tenders.length, 1);
  });

  test(`POST /import-pdf: R2 (split-tender) persists order + 2 tenders ordered by sequence${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r2(), { filename: 'r2.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, true);
    assert.equal(res.body.extracted.tenders.length, 2);

    const orderId = res.body.order.id as number;
    const tenders = await models.ExternalOrderTender.findAll({
      where: { externalOrderId: orderId },
      order: [['sequence', 'ASC']],
    });
    assert.deepEqual(
      tenders.map((t) => ({ paymentLast4: t.paymentLast4, network: t.network, amount: Number(t.amount) })),
      f.r2Expected.tenders,
    );

    const order = await models.ExternalOrder.findByPk(orderId);
    assert.equal(Number(order!.total), f.r2Expected.total);
    assert.equal(order!.paymentLast4, null); // multi-tender → no single last4
  });

  test(`POST /import-pdf: split-tender receipt auto-links to both card transactions${f.suffix}`, opts, async () => {
    const [bigTender, smallTender] = f.r2Expected.tenders;
    // Seed two Costco transactions matching R2's two tenders.
    const acc1 = await authed.post('/api/accounts').send({
      name: f.r2Expected.cardAccountName,
      owner: 'me',
      defaultCurrency: 'CAD',
    });
    const acc2 = await authed.post('/api/accounts').send({
      name: `Costco Mastercard${f.suffix}`,
      owner: 'me',
      defaultCurrency: 'CAD',
    });
    assert.equal(acc1.status, 201);
    assert.equal(acc2.status, 201);

    const t1 = await models.Transaction.create({
      accountId: acc1.body.id,
      householdId: 1,
      date: f.r2Expected.date,
      amount: (-bigTender.amount).toFixed(2),
      merchantRaw: f.r2Expected.merchantRaw,
      merchantClean: 'Costco',
      notes: f.r2Expected.cardNotes,
      sourceReference: null,
      currency: 'CAD',
      importBatch: `${f.key}-receipt-match-1`,
      sourceRowFingerprint: `${f.key}-receipt-fp-1`,
      sourceIdentityFingerprint: `${f.key}-receipt-identity-1`,
    } as never);

    const t2 = await models.Transaction.create({
      accountId: acc2.body.id,
      householdId: 1,
      date: f.r2Expected.date,
      amount: (-smallTender.amount).toFixed(2),
      merchantRaw: f.r2Expected.merchantRaw,
      merchantClean: 'Costco',
      notes: null,
      sourceReference: null,
      currency: 'CAD',
      importBatch: `${f.key}-receipt-match-2`,
      sourceRowFingerprint: `${f.key}-receipt-fp-2`,
      sourceIdentityFingerprint: `${f.key}-receipt-identity-2`,
    } as never);

    // R2 was already uploaded by the previous test — re-upload to trigger re-matching.
    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r2(), { filename: 'r2-match.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.match.tendersProcessed, 2);
    // The two tenders should each pick one of our seeded transactions.
    assert.ok(
      res.body.match.created + res.body.match.updated === 2,
      `expected 2 links created/updated, got ${JSON.stringify(res.body.match)}`,
    );

    const orderId = res.body.order.id as number;
    const links = await models.TransactionOrderLink.findAll({
      where: { externalOrderId: orderId },
      order: [['linkedAmount', 'DESC']],
    });
    assert.equal(links.length, 2);

    // Larger-amount tender (with the printed card mask) links to t1 with the paymentLast4 boost
    assert.equal(links[0].transactionId, t1.id);
    assert.equal(Number(links[0].linkedAmount), bigTender.amount);
    // Smaller tender → t2
    assert.equal(links[1].transactionId, t2.id);
    assert.equal(Number(links[1].linkedAmount), smallTender.amount);
  });

  test(`POST /import-pdf-bulk: imports two receipts in one request with per-file results${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf-bulk')
      .attach('files', f.r1(), { filename: 'r1.pdf', contentType: 'application/pdf' })
      .attach('files', f.r2(), { filename: 'r2.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.equal(res.body.failed, 0);
    // R1 and R2 were already imported by the single-file tests above, so both
    // dedupe to the existing orders rather than creating new ones.
    assert.equal(res.body.duplicates, 2);
    assert.equal(res.body.imported, 0);
    assert.deepEqual(res.body.results.map((r: { filename: string }) => r.filename), ['r1.pdf', 'r2.pdf']);
    for (const r of res.body.results) {
      assert.equal(r.status, 'duplicate');
      assert.equal(r.parserId, 'costco_till_receipt');
      assert.ok(typeof r.orderId === 'number');
    }

    // Dedupe held: still exactly one order per receipt.
    const orders = await models.ExternalOrder.findAll({ where: { source: 'costco_till_receipt-pdf' } });
    const ids = new Set(orders.map((o) => o.vendorOrderId));
    assert.equal(orders.length, ids.size, 'duplicate orders were created');
  });

  test(`POST /import-pdf-bulk: one unparseable file does not stop the others${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf-bulk')
      .attach('files', Buffer.from('%PDF-1.4 garbage', 'utf8'), { filename: 'junk.pdf', contentType: 'application/pdf' })
      .attach('files', f.r2(), { filename: 'good.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.results[0].status, 'failed');
    assert.ok(res.body.results[0].error, 'failed entry carries an error message');
    assert.notEqual(res.body.results[1].status, 'failed');
  });

  test(`POST /import-pdf: re-uploading repairs parser-owned fields but preserves AI/user columns${f.suffix}`, opts, async () => {
    // R2 was imported by an earlier test in this set. Simulate an order that an
    // older parser ingested: blank item numbers, quantity collapsed to 1, and an
    // AI category that must survive the refresh.
    const order = await models.ExternalOrder.findOne({
      where: { vendorOrderId: f.r2Expected.orderId },
    });
    assert.ok(order, 'R2 order not found — earlier test did not run');

    const items = await models.ExternalOrderItem.findAll({
      where: { externalOrderId: order.id },
      order: [['id', 'ASC']],
    });
    assert.ok(items.length > 0);
    const victim = items[0];
    await victim.update({
      itemNumber: null,
      quantity: 1,
      title: 'STALE TITLE',
      inferredCategory: 'Groceries',
      businessUsePercent: '42.00',
    });

    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r2(), { filename: 'r2.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, false, 'must dedupe, not create a second order');
    assert.equal(res.body.refreshed, true, 'the mangled row should have been repaired');

    await victim.reload();
    // parser-owned: restored
    assert.notEqual(victim.title, 'STALE TITLE');
    assert.ok(victim.itemNumber, 'item number should be repopulated');
    // AI/user-owned: untouched
    assert.equal(victim.inferredCategory, 'Groceries');
    assert.equal(Number(victim.businessUsePercent), 42);

    // No duplicate rows were introduced by the refresh.
    const after = await models.ExternalOrderItem.count({ where: { externalOrderId: order.id } });
    assert.equal(after, items.length);
  });

  test(`POST /import-pdf: an unchanged re-upload reports refreshed=false${f.suffix}`, opts, async () => {
    const res = await authed
      .post('/api/external-orders/import-pdf')
      .attach('file', f.r2(), { filename: 'r2.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, false);
    assert.equal(res.body.refreshed, false, 'nothing changed, so nothing should be reported as repaired');
  });
}

// Synthetic receipts (test/helpers/syntheticStatements.ts) — always run.
registerReceiptImportTests({
  suffix: ' — synthetic receipts',
  key: 'synthetic',
  r1: () => synthPdf(SYN_COSTCO_R1),
  r2: () => synthPdf(SYN_COSTCO_R2),
  r1Expected: {
    orderId: '0999-11-303-23-20240504-1107',
    total: 547.64,
    subtotal: 493.44,
    tax: 54.2,
    itemCount: 8, // 6 catalog + 2 TPD
    tender: { paymentLast4: '9001', network: 'costco-mastercard', amount: 547.64 },
  },
  r2Expected: {
    orderId: '0999-7-285-17-20240615-1546',
    date: '2024-06-15',
    total: 1988.22,
    tenders: [
      { paymentLast4: '4242', network: 'mastercard', amount: 1200 },
      { paymentLast4: null, network: 'costco-mastercard', amount: 788.22 },
    ],
    merchantRaw: 'COSTCO WHOLESALE #0999 ANYTOWN ON',
    cardAccountName: 'Mastercard 4242',
    cardNotes: 'CARD XXXX-4242',
  },
});

// Connor's real receipts — LOCAL-ONLY.
registerReceiptImportTests({
  suffix: '',
  key: 'test',
  skip: skipUnlessPrivateFixtures(r1Path, r2Path),
  r1: () => fs.readFileSync(r1Path),
  r2: () => fs.readFileSync(r2Path),
  r1Expected: {
    orderId: '1168-11-303-23-20251213-1624',
    total: 947.04,
    subtotal: 849.81,
    tax: 97.23,
    itemCount: 11, // 9 catalog + 2 TPD
    tender: { paymentLast4: '3114', network: 'costco-mastercard', amount: 947.04 },
  },
  r2Expected: {
    orderId: '1168-7-285-17-20251226-1546',
    date: '2025-12-26',
    total: 2963.72,
    tenders: [
      { paymentLast4: '3812', network: 'mastercard', amount: 1863.72 },
      { paymentLast4: null, network: 'costco-mastercard', amount: 1100.0 },
    ],
    merchantRaw: 'COSTCO WHOLESALE #1168 GUELPH ON',
    cardAccountName: 'Mastercard 3812',
    cardNotes: 'CARD XXXX-3812',
  },
});

/**
 * Integration tests for POST /api/external-orders/import-pdf.
 * Runs in isolation (`yarn test:integration`) so DATABASE_URL is set before
 * any Sequelize import.
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
let models: typeof import('../../src/models/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const fixturesDir = path.join(backendRoot, 'test', 'fixtures', 'pdf');
const r1Path = path.join(fixturesDir, 'costco-till-2025-12-13.pdf');
const r2Path = path.join(fixturesDir, 'costco-till-2025-12-26.pdf');
const hasFixtures = fs.existsSync(r1Path) && fs.existsSync(r2Path);
const skipNoFixtures = hasFixtures
  ? undefined
  : 'Costco till fixtures not present (gitignored — see backend/test/fixtures/pdf/)';

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

test('POST /import-pdf: R1 (single-tender Costco) persists order + 1 tender + items', {
  skip: skipNoFixtures,
}, async () => {
  const pdf = fs.readFileSync(r1Path);
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', pdf, { filename: 'r1.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.parserId, 'costco_till_receipt');
  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.extracted.vendor, 'costco');
  assert.equal(res.body.extracted.orderId, '1168-11-303-23-20251213-1624');
  assert.equal(res.body.extracted.total, 947.04);
  assert.equal(res.body.extracted.tenders.length, 1);

  // DB-level checks: 1 tender row, 11 items (9 catalog + 2 TPD)
  const orderId = res.body.order.id as number;
  const tenders = await models.ExternalOrderTender.findAll({ where: { externalOrderId: orderId } });
  assert.equal(tenders.length, 1);
  assert.equal(tenders[0].paymentLast4, '3114');
  assert.equal(tenders[0].network, 'costco-mastercard');
  assert.equal(Number(tenders[0].amount), 947.04);

  const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: orderId } });
  assert.equal(items.length, 11);

  const order = await models.ExternalOrder.findByPk(orderId);
  assert.equal(Number(order!.subtotal), 849.81);
  assert.equal(Number(order!.tax), 97.23);
  assert.equal(order!.currency, 'CAD');
});

test('POST /import-pdf: re-uploading R1 is idempotent (created=false, no duplicate tenders)', {
  skip: skipNoFixtures,
}, async () => {
  const pdf = fs.readFileSync(r1Path);
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', pdf, { filename: 'r1-again.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 200);
  assert.equal(res.body.created, false);

  // Confirm exactly one ExternalOrder for that orderId, one tender row.
  const orders = await models.ExternalOrder.findAll({
    where: { vendorOrderId: '1168-11-303-23-20251213-1624' },
  });
  assert.equal(orders.length, 1);
  const tenders = await models.ExternalOrderTender.findAll({
    where: { externalOrderId: orders[0].id },
  });
  assert.equal(tenders.length, 1);
});

test('POST /import-pdf: R2 (split-tender) persists order + 2 tenders ordered by sequence', {
  skip: skipNoFixtures,
}, async () => {
  const pdf = fs.readFileSync(r2Path);
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', pdf, { filename: 'r2.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.extracted.tenders.length, 2);

  const orderId = res.body.order.id as number;
  const tenders = await models.ExternalOrderTender.findAll({
    where: { externalOrderId: orderId },
    order: [['sequence', 'ASC']],
  });
  assert.equal(tenders.length, 2);
  assert.equal(tenders[0].paymentLast4, '3812');
  assert.equal(tenders[0].network, 'mastercard');
  assert.equal(Number(tenders[0].amount), 1863.72);
  assert.equal(tenders[1].paymentLast4, null);
  assert.equal(tenders[1].network, 'costco-mastercard');
  assert.equal(Number(tenders[1].amount), 1100.0);

  const order = await models.ExternalOrder.findByPk(orderId);
  assert.equal(Number(order!.total), 2963.72);
  assert.equal(order!.paymentLast4, null); // multi-tender → no single last4
});

test('POST /import-pdf: split-tender receipt auto-links to both card transactions', {
  skip: skipNoFixtures,
}, async () => {
  // Seed two Costco transactions matching R2's two tenders.
  const acc1 = await authed.post('/api/accounts').send({
    name: 'Mastercard 3812',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  const acc2 = await authed.post('/api/accounts').send({
    name: 'Costco Mastercard',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc1.status, 201);
  assert.equal(acc2.status, 201);

  const t1 = await models.Transaction.create({
    accountId: acc1.body.id,
    householdId: 1,
    date: '2025-12-26',
    amount: '-1863.72',
    merchantRaw: 'COSTCO WHOLESALE #1168 GUELPH ON',
    merchantClean: 'Costco',
    notes: 'CARD XXXX-3812',
    sourceReference: null,
    currency: 'CAD',
    importBatch: 'test-receipt-match-1',
    sourceRowFingerprint: 'test-receipt-fp-1',
    sourceIdentityFingerprint: 'test-receipt-identity-1',
  } as never);

  const t2 = await models.Transaction.create({
    accountId: acc2.body.id,
    householdId: 1,
    date: '2025-12-26',
    amount: '-1100.00',
    merchantRaw: 'COSTCO WHOLESALE #1168 GUELPH ON',
    merchantClean: 'Costco',
    notes: null,
    sourceReference: null,
    currency: 'CAD',
    importBatch: 'test-receipt-match-2',
    sourceRowFingerprint: 'test-receipt-fp-2',
    sourceIdentityFingerprint: 'test-receipt-identity-2',
  } as never);

  // R2 was already uploaded by the previous test — re-upload to trigger re-matching.
  const pdf = fs.readFileSync(r2Path);
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', pdf, { filename: 'r2-match.pdf', contentType: 'application/pdf' });

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

  // Larger-amount tender ($1,863.72) should link to t1 with paymentLast4 boost
  assert.equal(links[0].transactionId, t1.id);
  assert.equal(Number(links[0].linkedAmount), 1863.72);
  // Smaller tender ($1,100) → t2
  assert.equal(links[1].transactionId, t2.id);
  assert.equal(Number(links[1].linkedAmount), 1100.0);
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

test('POST /import-pdf-bulk: imports two receipts in one request with per-file results', {
  skip: skipNoFixtures,
}, async () => {
  const res = await authed
    .post('/api/external-orders/import-pdf-bulk')
    .attach('files', fs.readFileSync(r1Path), { filename: 'r1.pdf', contentType: 'application/pdf' })
    .attach('files', fs.readFileSync(r2Path), { filename: 'r2.pdf', contentType: 'application/pdf' });

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

test('POST /import-pdf-bulk: one unparseable file does not stop the others', {
  skip: skipNoFixtures,
}, async () => {
  const res = await authed
    .post('/api/external-orders/import-pdf-bulk')
    .attach('files', Buffer.from('%PDF-1.4 garbage', 'utf8'), { filename: 'junk.pdf', contentType: 'application/pdf' })
    .attach('files', fs.readFileSync(r2Path), { filename: 'good.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 2);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.results[0].status, 'failed');
  assert.ok(res.body.results[0].error, 'failed entry carries an error message');
  assert.notEqual(res.body.results[1].status, 'failed');
});

test('POST /import-pdf: re-uploading repairs parser-owned fields but preserves AI/user columns', {
  skip: skipNoFixtures,
}, async () => {
  // R2 was imported by an earlier test in this file. Simulate an order that an
  // older parser ingested: blank item numbers, quantity collapsed to 1, and an
  // AI category that must survive the refresh.
  const order = await models.ExternalOrder.findOne({
    where: { vendorOrderId: '1168-7-285-17-20251226-1546' },
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
    .attach('file', fs.readFileSync(r2Path), { filename: 'r2.pdf', contentType: 'application/pdf' });

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

test('POST /import-pdf: an unchanged re-upload reports refreshed=false', {
  skip: skipNoFixtures,
}, async () => {
  const res = await authed
    .post('/api/external-orders/import-pdf')
    .attach('file', fs.readFileSync(r2Path), { filename: 'r2.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, false);
  assert.equal(res.body.refreshed, false, 'nothing changed, so nothing should be reported as repaired');
});

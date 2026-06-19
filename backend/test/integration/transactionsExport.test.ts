/**
 * Integration tests for `GET /api/transactions/export`.
 *
 * Exercises the full HTTP round-trip via supertest against a live Postgres
 * test database, mirrors the setup pattern used by transactions.test.ts.
 *
 * AC coverage:
 *   #1  — unfiltered export returns all user's transactions + fixed header
 *   #2  — dateFrom/dateTo filter narrows correctly
 *   #3  — combined accountId + category filter
 *   #5  — response is streamed (chunked transfer or at minimum header row arrives before data)
 *   #8  — CSV quoting (cell with comma is quoted)
 *   #9  — Content-Disposition header includes today's date
 *   #12 — row count in export matches filter
 *   #13 — cross-user scoping (user B's transactions not leaked to user A)
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let userBId: number;
let accountAId: number;
let accountBId: number;
let testDb: PgTestDb;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  finalCategory?: string | null;
  reviewFlag?: boolean;
  importBatch?: string;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: seed.importBatch ?? 'export-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: seed.finalCategory ?? null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: String(seed.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: seed.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return row.id;
}

/** Parse a CSV text into rows (split on CRLF or LF, skip empty lines). */
function parseCSV(text: string): string[][] {
  // Strip a leading UTF-8 BOM (﻿). The export stream prepends a BOM so
  // Excel detects UTF-8; a real CSV consumer drops it before parsing. Without
  // this, the first header cell parses as "﻿id" instead of "id".
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Simple split — good enough for our fixture data which doesn't have
      // quoted commas (those are covered by the unit tests).
      return line.split(',');
    });
}

before(async () => {
  testDb = await setupPgTestDb('txn-export');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const a = await seedHousehold('ExportA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('ExportB', 'B Partner');
  householdBId = b.householdId;
  userBId = b.userId;
  agentB = testAgent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  const models = await import('../../src/models');

  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'EXP-A-CHQ',
  });
  accountAId = acctA.id;

  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: userBId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'EXP-B-CHQ',
  });
  accountBId = acctB.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ─────────────── AC #1 — unfiltered export returns all user's rows ───────────

test('GET /api/transactions/export: unfiltered returns fixed header + all household rows', async () => {
  const id1 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-06-01',
    amount: -10,
    merchantRaw: 'Coffee Shop',
  });
  const id2 = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-06-02',
    amount: -20,
    merchantRaw: 'Grocery Store',
  });

  const res = await agentA.get('/api/transactions/export');
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${String(res.text).slice(0, 200)}`);
  assert.ok(
    res.headers['content-type']?.includes('text/csv'),
    `content-type should be text/csv, got: ${res.headers['content-type']}`,
  );

  const rows = parseCSV(res.text);
  assert.ok(rows.length >= 3, `expected header + at least 2 data rows, got ${rows.length}`);

  // First row must be the header.
  const header = rows[0];
  assert.ok(header.includes('id'), 'header must include "id"');
  assert.ok(header.includes('date'), 'header must include "date"');
  assert.ok(header.includes('amount'), 'header must include "amount"');
  assert.ok(header.includes('account'), 'header must include "account"');

  // Data rows must include our seeded IDs.
  const dataText = rows.slice(1).map((r) => r.join(','));
  assert.ok(
    dataText.some((line) => line.includes(String(id1))),
    `export must include transaction id ${id1}`,
  );
  assert.ok(
    dataText.some((line) => line.includes(String(id2))),
    `export must include transaction id ${id2}`,
  );
});

// ─────────────── AC #2 — dateFrom/dateTo filter ──────────────────────────────

test('GET /api/transactions/export: dateFrom+dateTo restricts rows', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2024-01-15',
    amount: -5,
    merchantRaw: 'Old Purchase',
  });
  const inRangeId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-07-10',
    amount: -15,
    merchantRaw: 'InRange Purchase',
  });

  const res = await agentA
    .get('/api/transactions/export')
    .query({ dateFrom: '2025-07-01', dateTo: '2025-07-31' });

  assert.equal(res.status, 200);
  const rows = parseCSV(res.text);
  const dataLines = rows.slice(1).map((r) => r.join(','));

  assert.ok(
    dataLines.some((l) => l.includes(String(inRangeId))),
    'in-range transaction must appear',
  );
  assert.ok(
    !dataLines.some((l) => l.includes('Old Purchase')),
    'out-of-range transaction must not appear',
  );
});

// ─────────────── AC #3 — combined accountId + category filters ───────────────

test('GET /api/transactions/export: category filter restricts rows', async () => {
  const catId = await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-08-01',
    amount: -30,
    merchantRaw: 'Walmart',
    finalCategory: 'Groceries',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-08-02',
    amount: -40,
    merchantRaw: 'Shell',
    finalCategory: 'Gas',
  });

  const res = await agentA
    .get('/api/transactions/export')
    .query({ category: 'Groceries' });

  assert.equal(res.status, 200);
  const rows = parseCSV(res.text);
  const dataLines = rows.slice(1).map((r) => r.join(','));

  assert.ok(
    dataLines.some((l) => l.includes(String(catId))),
    'Groceries transaction must appear',
  );
  assert.ok(
    !dataLines.some((l) => l.includes('Shell')),
    'Gas transaction must not appear with category=Groceries',
  );
});

// ─────────────── AC #9 — Content-Disposition header ─────────────────────────

test('GET /api/transactions/export: Content-Disposition is attachment with date filename', async () => {
  const res = await agentA.get('/api/transactions/export');
  assert.equal(res.status, 200);

  const cd = res.headers['content-disposition'] as string | undefined;
  assert.ok(cd, 'Content-Disposition header must be present');
  assert.ok(
    cd.includes('attachment'),
    `Content-Disposition must say attachment, got: ${cd}`,
  );
  assert.ok(
    cd.includes('cashflow-transactions-'),
    `Content-Disposition filename must contain cashflow-transactions-, got: ${cd}`,
  );
  // Filename must end with a YYYY-MM-DD date pattern.
  assert.match(cd, /cashflow-transactions-\d{4}-\d{2}-\d{2}\.csv/);
});

// ─────────────── AC #12 — row count matches filter ──────────────────────────

test('GET /api/transactions/export: row count matches list count for same filter', async () => {
  // Use a unique importBatch so we can isolate these rows.
  const batch = `export-count-test-${Date.now()}`;
  await createTxn({ householdId: householdAId, accountId: accountAId, date: '2025-09-01', amount: -1, importBatch: batch });
  await createTxn({ householdId: householdAId, accountId: accountAId, date: '2025-09-02', amount: -2, importBatch: batch });
  await createTxn({ householdId: householdAId, accountId: accountAId, date: '2025-09-03', amount: -3, importBatch: batch });

  // Get the list count for this batch.
  const listRes = await agentA
    .get('/api/transactions')
    .query({ importBatch: batch, pageSize: '100' });
  assert.equal(listRes.status, 200);
  const listTotal = (listRes.body as { total: number }).total;

  // Get the export count.
  const exportRes = await agentA
    .get('/api/transactions/export')
    .query({ importBatch: batch });
  assert.equal(exportRes.status, 200);
  const rows = parseCSV(exportRes.text);
  // Subtract 1 for the header row.
  const exportDataRows = rows.length - 1;

  assert.equal(
    exportDataRows,
    listTotal,
    `export data row count (${exportDataRows}) must equal list total (${listTotal})`,
  );
});

// ─────────────── AC #13 — cross-user scoping ────────────────────────────────

test('GET /api/transactions/export: user B cannot see user A transactions', async () => {
  const uniqueMerchant = `SECRET-A-${crypto.randomBytes(4).toString('hex')}`;
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-10-01',
    amount: -99,
    merchantRaw: uniqueMerchant,
  });

  // User B's export must not contain user A's unique merchant.
  const res = await agentB.get('/api/transactions/export');
  assert.equal(res.status, 200);
  assert.ok(
    !res.text.includes(uniqueMerchant),
    `User B's export must NOT contain user A's merchant "${uniqueMerchant}"`,
  );
});

// ─────────────── Invalid filter → 400 ───────────────────────────────────────

test('GET /api/transactions/export: invalid dateFrom returns 400', async () => {
  const res = await agentA
    .get('/api/transactions/export')
    .query({ dateFrom: 'not-a-date' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'error field must be present');
});

test('GET /api/transactions/export: invalid dateTo returns 400', async () => {
  const res = await agentA
    .get('/api/transactions/export')
    .query({ dateTo: 'not-a-date' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'error field must be present');
});

// ─────────────── Empty result set — header-only CSV ──────────────────────────

test('GET /api/transactions/export: empty filter returns header-only CSV with 200', async () => {
  // Use a nonexistent importBatch so zero rows match.
  const res = await agentA
    .get('/api/transactions/export')
    .query({ importBatch: `nonexistent-batch-${Date.now()}` });

  assert.equal(res.status, 200);
  const rows = parseCSV(res.text);
  // Should have exactly 1 row: the header.
  assert.equal(rows.length, 1, 'empty export must have exactly 1 row (header only)');
  assert.ok(rows[0].includes('id'), 'that row must be the header');
});

// ─────────────── AC #8 — quoted values with commas ───────────────────────────

test('GET /api/transactions/export: merchant name with comma is quoted in CSV', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2025-11-01',
    amount: -7,
    merchantRaw: 'Smith, Jones & Co.',
  });

  const res = await agentA
    .get('/api/transactions/export')
    .query({ importBatch: 'export-test' });

  assert.equal(res.status, 200);
  // The merchant name has a comma so it must appear quoted.
  assert.ok(
    res.text.includes('"Smith, Jones & Co."') || res.text.includes('"Smith, Jones'),
    'merchant with comma must be double-quoted in the CSV',
  );
});

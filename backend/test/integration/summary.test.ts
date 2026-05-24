/**
 * Integration tests for `backend/src/routes/summary.ts`:
 *   - GET /api/summary/dashboard
 *   - GET /api/summary/partner
 *   - GET /api/summary/business
 *   - GET /api/summary/monthly
 *
 * Setup mirrors `settlements.test.ts`: one isolated SQLite DB,
 * one bootstrap superadmin, plus two non-superadmin households
 * (A and B) seeded via the shared `seedHousehold` helper. Each
 * household gets its own session-cookie supertest agent so we
 * can assert household scoping for free.
 *
 * Fixtures are hand-built rows written via `Transaction.create`.
 * We deliberately avoid `seedDemoData` (production-scale, fragile
 * assertions) and CSV imports (an extra layer of variation we
 * don't need to exercise here).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-summary.sqlite');

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let householdBId: number;
let userAId: number;
let contactAId: number;
let accountAId: number;
let accountAUsdId: number;
let accountBId: number;

type TxnSeed = {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  currency?: string;
  merchantRaw?: string;
  merchantClean?: string;
  merchantCanonical?: string | null;
  finalCategory?: string | null;
  finalBusiness?: boolean;
  finalSplitType?: string;
  ownershipType?: string;
  ownershipContactId?: number | null;
  myShareAmount?: number;
  partnerShareAmount?: number;
  businessAmount?: number;
  txnType?: string;
  reviewFlag?: boolean;
  visibility?: string;
  createdByUserId?: number | null;
};

async function createTxn(seed: TxnSeed): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId: seed.accountId,
    householdId: seed.householdId,
    visibility: seed.visibility ?? 'shared',
    ownershipType: seed.ownershipType ?? 'me',
    ownershipContactId: seed.ownershipContactId ?? null,
    importBatch: 'summary-test',
    date: seed.date,
    merchantRaw: seed.merchantRaw ?? 'Test Merchant',
    merchantClean: seed.merchantClean ?? seed.merchantRaw ?? 'Test Merchant',
    merchantCanonical: seed.merchantCanonical ?? null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: seed.finalCategory ?? null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: seed.finalBusiness ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: seed.finalSplitType ?? 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: String(seed.myShareAmount ?? seed.amount).toString(),
    partnerShareAmount: String(seed.partnerShareAmount ?? 0).toString(),
    businessAmount: String(seed.businessAmount ?? 0).toString(),
    txnType: seed.txnType ?? 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: seed.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: seed.createdByUserId ?? null,
  });
  return row.id;
}

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap superadmin (first registration auto-promotes).
  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-summary@example.com',
    displayName: 'Super Summary',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('SummaryA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  contactAId = a.contactId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('SummaryB', 'B Partner');
  householdBId = b.householdId;
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  // Accounts (created directly so we can set accountType freely).
  const models = await import('../../src/models');
  const acctA = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'A-CHQ',
  });
  accountAId = acctA.id;
  const acctAUsd = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A USD Card',
    accountType: 'credit_card',
    defaultCurrency: 'USD',
    shortCode: 'A-USD',
  });
  accountAUsdId = acctAUsd.id;
  const acctB = await models.Account.create({
    householdId: householdBId,
    ownerUserId: b.userId,
    owner: 'me',
    visibility: 'shared',
    name: 'B Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: 'B-CHQ',
  });
  accountBId = acctB.id;
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

// ---------------- GET /api/summary/dashboard ----------------

test(
  '/dashboard: NULL-amount row excluded from monetary totals but counted',
  { skip: 'amount NOT NULL at DB level — guard at summary.ts:189 is dead code' },
  () => {
    // Documented in PR: the `if (amount == null) continue;` guard at
    // summary.ts:189 is unreachable because Transaction.amount has
    // allowNull:false at the DB level. Kept here for traceability;
    // delete in a separate cleanup PR.
  },
);

test('/dashboard: statement payment positives credit totalPayments and skip byCategory', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-02-01',
    amount: -50,
    finalCategory: 'Groceries',
    merchantRaw: 'Grocer',
    txnType: 'purchase',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-02-15',
    amount: 50,
    finalCategory: null,
    merchantRaw: 'Bank Payment Thank You',
    txnType: 'payment',
  });

  const dash = await agentA
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  assert.equal(dash.status, 200);

  const metrics = (dash.body.metricsByCurrency as Array<{
    currency: string;
    totalSpend: number;
    totalCredits: number;
    totalPayments: number;
    netSpend: number;
  }>).find((m) => m.currency === 'CAD');
  assert.ok(metrics);
  assert.equal(metrics.totalSpend, 50);
  assert.equal(metrics.totalPayments, 50, 'payment must land in totalPayments');
  assert.equal(metrics.totalCredits, 0, 'payment must not contaminate totalCredits');
  assert.equal(metrics.netSpend, 50, 'netSpend = totalSpend - totalCredits');

  // Payment row must NOT show up in byCategory at all (positiveBucket=payment short-circuits).
  const byCat = dash.body.byCategory as Array<{ category: string | null; sumAmount: number }>;
  const paymentCat = byCat.find((c) => c.category === null);
  // either there is no null-category row, or its sumAmount must not include the +50 payment.
  if (paymentCat) {
    assert.ok(
      paymentCat.sumAmount !== 50,
      `payment leaked into byCategory uncategorized bucket (sumAmount=${paymentCat.sumAmount})`,
    );
  }

  // merchant summary for the payment row carries totalPayments=50.
  const merchant = (dash.body.merchantSummaries as Array<{
    merchant: string;
    totalPayments: number;
  }>).find((m) => /payment thank you/i.test(m.merchant));
  assert.ok(merchant);
  assert.equal(merchant.totalPayments, 50);
});

test('/dashboard: multi-currency rows produce separate metricsByCurrency and byCategory entries', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-03-01',
    amount: -100,
    currency: 'CAD',
    finalCategory: 'Dining',
    merchantRaw: 'Cafe CAD',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAUsdId,
    date: '2026-03-02',
    amount: -40,
    currency: 'USD',
    finalCategory: 'Dining',
    merchantRaw: 'Cafe USD',
  });

  const dash = await agentA
    .get('/api/summary/dashboard')
    .query({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
  assert.equal(dash.status, 200);

  const currencies = (dash.body.metricsByCurrency as Array<{ currency: string }>).map(
    (m) => m.currency,
  );
  assert.ok(currencies.includes('CAD'), `missing CAD in ${JSON.stringify(currencies)}`);
  assert.ok(currencies.includes('USD'), `missing USD in ${JSON.stringify(currencies)}`);

  const diningRows = (dash.body.byCategory as Array<{ currency: string; category: string | null }>).filter(
    (c) => c.category === 'Dining',
  );
  const diningCurrencies = diningRows.map((c) => c.currency).sort();
  assert.deepEqual(
    diningCurrencies,
    ['CAD', 'USD'],
    'same category in two currencies must produce two entries',
  );
});

test('/dashboard: reviewQueue capped at 12, ordered by descending date then descending |amount|', async () => {
  // Seed 15 review-flagged rows spread across two dates so we can verify both sorts.
  // 10 rows on 2026-04-15 with amounts -1..-10; 5 rows on 2026-04-16 with amounts -100..-104.
  const earlierIds: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date: '2026-04-15',
      amount: -i,
      merchantRaw: `Earlier ${i}`,
      reviewFlag: true,
    });
    earlierIds.push(id);
  }
  const laterIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await createTxn({
      householdId: householdAId,
      accountId: accountAId,
      date: '2026-04-16',
      amount: -(100 + i),
      merchantRaw: `Later ${i}`,
      reviewFlag: true,
    });
    laterIds.push(id);
  }

  const dash = await agentA
    .get('/api/summary/dashboard')
    .query({ dateFrom: '2026-04-15', dateTo: '2026-04-16' });
  assert.equal(dash.status, 200);
  const queue = dash.body.reviewQueue as Array<{
    id: number;
    date: string;
    amount: number;
  }>;
  assert.equal(queue.length, 12, 'reviewQueue must be capped at 12');

  // All 5 of the later-date rows must appear first (descending date).
  for (let i = 0; i < 5; i++) {
    assert.equal(queue[i].date, '2026-04-16', `position ${i} should be 2026-04-16`);
  }
  // Among the later-date rows, |amount| must be descending: 104, 103, 102, 101, 100.
  for (let i = 1; i < 5; i++) {
    assert.ok(
      Math.abs(queue[i - 1].amount) >= Math.abs(queue[i].amount),
      `|amount| not descending within same date at position ${i}`,
    );
  }
  // Remaining 7 slots are from the earlier date, again descending by |amount|.
  for (let i = 5; i < 12; i++) {
    assert.equal(queue[i].date, '2026-04-15');
  }
  for (let i = 6; i < 12; i++) {
    assert.ok(
      Math.abs(queue[i - 1].amount) >= Math.abs(queue[i].amount),
      `|amount| not descending within 2026-04-15 at position ${i}`,
    );
  }
});

test('/dashboard: empty date range returns all expected keys as empty arrays not missing', async () => {
  // Use a date range guaranteed to contain no transactions.
  const dash = await agentA
    .get('/api/summary/dashboard')
    .query({ dateFrom: '2099-01-01', dateTo: '2099-01-02' });
  assert.equal(dash.status, 200);
  // The handler always builds every key from a `Map`, even when empty.
  // Frontend depends on these being arrays.
  for (const key of [
    'byCategory',
    'metricsByCurrency',
    'monthlyByCurrency',
    'netSpendBySplit',
    'netSpendByBusiness',
    'categoryReports',
    'merchantSummaries',
    'accountSummaries',
    'reviewQueue',
  ]) {
    assert.ok(Array.isArray(dash.body[key]), `${key} should be an array`);
    assert.equal((dash.body[key] as unknown[]).length, 0, `${key} should be empty for empty range`);
  }
});

// ---------------- GET /api/summary/partner ----------------

test('/partner: two settlements for the same (contact,currency) accumulate iPaid', async () => {
  // Seed a partner-shared transaction so there's a row in /partner to adjust.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-06-01',
    amount: -100,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: contactAId,
    myShareAmount: -50,
    partnerShareAmount: -50,
    merchantRaw: 'Joint Dinner',
  });

  // Two separate settlement rows for the same (contact, currency).
  for (const amt of [10, 15]) {
    const s = await agentA.post('/api/settlements').send({
      contactId: contactAId,
      direction: 'i_paid_partner',
      currency: 'CAD',
      amount: amt,
      settledDate: '2026-06-15',
    });
    assert.equal(s.status, 201);
  }

  const res = await agentA
    .get('/api/summary/partner')
    .query({ currency: 'CAD', dateFrom: '2026-06-01', dateTo: '2026-06-30' });
  assert.equal(res.status, 200);
  const rows = res.body.byCurrency as Array<{
    ownershipContactId: number | null;
    settledAmount: number;
    settlementCount: number;
  }>;
  const ours = rows.find((r) => r.ownershipContactId === contactAId);
  assert.ok(ours, `expected a partner row for contact ${contactAId}: ${JSON.stringify(rows)}`);
  // iPaid (10+15) - partnerPaid (0) = 25.
  assert.equal(ours.settledAmount, 25, 'two i_paid_partner rows must accumulate');
  // settlementCount counts which sides were non-zero (iPaid yes, partnerPaid no) → 1.
  assert.equal(ours.settlementCount, 1, 'only iPaid side had non-zero contributions');
});

test('/partner: settlement outside the date filter is excluded from net', async () => {
  // Outside the requested window — must not contribute.
  const outOfRange = await agentA.post('/api/settlements').send({
    contactId: contactAId,
    direction: 'i_paid_partner',
    currency: 'CAD',
    amount: 999,
    settledDate: '2027-01-01',
  });
  assert.equal(outOfRange.status, 201);

  const res = await agentA
    .get('/api/summary/partner')
    .query({ currency: 'CAD', dateFrom: '2026-06-01', dateTo: '2026-06-30' });
  assert.equal(res.status, 200);
  const rows = res.body.byCurrency as Array<{
    ownershipContactId: number | null;
    settledAmount: number;
  }>;
  const ours = rows.find((r) => r.ownershipContactId === contactAId);
  assert.ok(ours);
  // Must still be 25 from the earlier test — the 999 row outside the window was dropped.
  assert.equal(
    ours.settledAmount,
    25,
    'settlement outside dateFrom/dateTo must not leak into the net',
  );
});

test('/partner: ownershipContactId pointing to a contact outside the household yields contactName=null', async () => {
  // The FK ownership_contact_id → contacts.id has onDelete:SET NULL, so a
  // "truly deleted" contact can never produce an orphan row — the txn's
  // ownershipContactId is nulled out by the FK. The only way to exercise
  // the `contactsById.get(...) ?? null` fallback at summary.ts is to plant
  // a transaction in household A that references a contact owned by
  // household B (the contactsById lookup is scoped to the caller's
  // household via householdWhere).
  const models = await import('../../src/models');
  const foreignContact = await models.Contact.create({
    householdId: householdBId,
    name: 'B Foreign Contact',
    notes: null,
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-07-10',
    amount: -22,
    currency: 'CAD',
    finalSplitType: 'shared',
    ownershipType: 'contact',
    ownershipContactId: foreignContact.id,
    myShareAmount: -11,
    partnerShareAmount: -11,
    merchantRaw: 'Foreign Coffee',
  });

  const res = await agentA
    .get('/api/summary/partner')
    .query({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.equal(res.status, 200);
  const row = (res.body.byCurrency as Array<{
    ownershipContactId: number | null;
    contactName: string | null;
  }>).find((r) => r.ownershipContactId === foreignContact.id);
  assert.ok(row, `expected a row for the cross-household contact: ${JSON.stringify(res.body.byCurrency)}`);
  assert.equal(
    row.contactName,
    null,
    'contactName must be null when the txn points to a contact not visible to this household',
  );
});

// ---------------- GET /api/summary/business ----------------

test('/business: only finalBusiness=true rows are included', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-08-01',
    amount: -200,
    finalBusiness: true,
    businessAmount: -200,
    merchantRaw: 'Office Supplies',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-08-02',
    amount: -300,
    finalBusiness: false,
    merchantRaw: 'Personal',
  });

  const res = await agentA
    .get('/api/summary/business')
    .query({ currency: 'CAD', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{ currency: string; sumBusiness: number | null }>).find(
    (r) => r.currency === 'CAD',
  );
  assert.ok(cad);
  // Only the -200 (finalBusiness=true) row counts; personal -300 excluded.
  assert.equal(cad.sumBusiness, -200, 'personal row must not contribute to business total');
});

test('/business: multi-currency business rows produce separate per-currency entries', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAUsdId,
    date: '2026-08-03',
    amount: -80,
    currency: 'USD',
    finalBusiness: true,
    businessAmount: -80,
    merchantRaw: 'USD Conf Fee',
  });
  const res = await agentA
    .get('/api/summary/business')
    .query({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.equal(res.status, 200);
  const currencies = (res.body.byCurrency as Array<{ currency: string }>).map((r) => r.currency).sort();
  assert.ok(currencies.includes('CAD'));
  assert.ok(currencies.includes('USD'));
});

test('/business: date range filter excludes rows outside the window', async () => {
  // Add a business row well outside the August window.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2024-01-01',
    amount: -500,
    finalBusiness: true,
    businessAmount: -500,
    merchantRaw: 'Old Business',
  });
  const res = await agentA
    .get('/api/summary/business')
    .query({ currency: 'CAD', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{ currency: string; sumBusiness: number | null }>).find(
    (r) => r.currency === 'CAD',
  );
  assert.ok(cad);
  // Still -200 from the earlier in-range row; the -500 from 2024 must be excluded.
  assert.equal(cad.sumBusiness, -200, 'out-of-range business row leaked');
});

// ---------------- GET /api/summary/monthly ----------------

test('/monthly: dateFrom boundary is inclusive', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-01',
    amount: -10,
    finalCategory: 'Test',
    merchantRaw: 'Boundary From',
  });
  const res = await agentA
    .get('/api/summary/monthly')
    .query({ currency: 'CAD', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.equal(res.status, 200);
  const sep = (res.body.points as Array<{ month: string; currency: string; sumAmount: number }>).find(
    (p) => p.month === '2026-09' && p.currency === 'CAD',
  );
  assert.ok(sep, 'expected a 2026-09 point — dateFrom must be inclusive');
  assert.equal(sep.sumAmount, -10);
});

test('/monthly: dateTo boundary is inclusive', async () => {
  // Same month, on the last day.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-09-30',
    amount: -7,
    finalCategory: 'Test',
    merchantRaw: 'Boundary To',
  });
  const res = await agentA
    .get('/api/summary/monthly')
    .query({ currency: 'CAD', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.equal(res.status, 200);
  const sep = (res.body.points as Array<{ month: string; currency: string; sumAmount: number }>).find(
    (p) => p.month === '2026-09' && p.currency === 'CAD',
  );
  assert.ok(sep);
  // -10 (from previous test, same suite) + -7.
  assert.equal(sep.sumAmount, -17, 'dateTo must be inclusive');
});

test('/monthly: a row one day past dateTo is excluded', async () => {
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-10-01',
    amount: -1000,
    finalCategory: 'Test',
    merchantRaw: 'Past dateTo',
  });
  const res = await agentA
    .get('/api/summary/monthly')
    .query({ currency: 'CAD', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.equal(res.status, 200);
  const sep = (res.body.points as Array<{ month: string; currency: string; sumAmount: number }>).find(
    (p) => p.month === '2026-09' && p.currency === 'CAD',
  );
  assert.ok(sep);
  assert.equal(sep.sumAmount, -17, 'past-dateTo row leaked into monthly point');
});

test('/monthly: positive payment excluded, positive refund included', async () => {
  // Payment +20 (must be excluded). Refund +5 (must be included with sign).
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-11-05',
    amount: 20,
    finalCategory: null,
    merchantRaw: 'Statement Payment',
    txnType: 'payment',
  });
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-11-06',
    amount: 5,
    finalCategory: 'Dining',
    merchantRaw: 'Refund from Cafe',
    txnType: 'refund',
  });
  const res = await agentA
    .get('/api/summary/monthly')
    .query({ currency: 'CAD', dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  assert.equal(res.status, 200);
  const nov = (res.body.points as Array<{ month: string; currency: string; sumAmount: number }>).find(
    (p) => p.month === '2026-11' && p.currency === 'CAD',
  );
  assert.ok(nov, `expected 2026-11 point: ${JSON.stringify(res.body.points)}`);
  // Payment excluded, refund +5 included → sumAmount = +5.
  assert.equal(nov.sumAmount, 5, `expected only refund to contribute (sumAmount=5), got ${nov.sumAmount}`);
});

// ---------------- Cross-cutting ----------------

test('/dashboard: household B cannot see household A data', async () => {
  // Seed a unique-merchant row on household A.
  await createTxn({
    householdId: householdAId,
    accountId: accountAId,
    date: '2026-12-01',
    amount: -42,
    finalCategory: 'HouseholdA-Only',
    merchantRaw: 'HouseholdA-Secret-Merchant',
  });
  // Seed an unrelated row on household B so B has something to see.
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2026-12-01',
    amount: -7,
    finalCategory: 'HouseholdB-Only',
    merchantRaw: 'HouseholdB-Merchant',
  });

  const dashB = await agentB
    .get('/api/summary/dashboard')
    .query({ dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  assert.equal(dashB.status, 200);
  const merchants = (dashB.body.merchantSummaries as Array<{ merchant: string }>).map(
    (m) => m.merchant,
  );
  assert.ok(
    !merchants.includes('HouseholdA-Secret-Merchant'),
    `household B leaked household A merchant: ${JSON.stringify(merchants)}`,
  );
  const categories = (dashB.body.byCategory as Array<{ category: string | null }>).map((c) => c.category);
  assert.ok(!categories.includes('HouseholdA-Only'), 'category from other household leaked');
  assert.ok(categories.includes('HouseholdB-Only'), 'B should see its own category');
});

test('/dashboard: lowercase ?currency=cad is normalized to uppercase CAD', async () => {
  const dash = await agentA
    .get('/api/summary/dashboard')
    .query({ currency: 'cad', dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  assert.equal(dash.status, 200);
  const currencies = (dash.body.metricsByCurrency as Array<{ currency: string }>).map(
    (m) => m.currency,
  );
  // Should contain CAD (upper) and NEVER 'cad' (lower).
  if (currencies.length > 0) {
    for (const c of currencies) {
      assert.equal(c, 'CAD', `unexpected currency casing: ${c}`);
    }
  }
});

test('/dashboard: netSpend reconciles with sum of netSpendByBusiness across currencies', async () => {
  const dash = await agentA.get('/api/summary/dashboard');
  assert.equal(dash.status, 200);
  const metrics = dash.body.metricsByCurrency as Array<{
    currency: string;
    netSpend: number;
  }>;
  const byBiz = dash.body.netSpendByBusiness as Array<{
    currency: string;
    netSpend: number;
  }>;
  for (const m of metrics) {
    const bizForCurrency = byBiz
      .filter((b) => b.currency === m.currency)
      .reduce((s, b) => s + b.netSpend, 0);
    // Allow tiny FP error from summing many rows.
    assert.ok(
      Math.abs(bizForCurrency - m.netSpend) < 0.01,
      `netSpend (${m.netSpend}) for ${m.currency} must reconcile with sum(netSpendByBusiness)=${bizForCurrency}`,
    );
  }
});

test('/dashboard: byCategory empty when all transactions are non-categorical transfers', async () => {
  // Use household B for isolation; only seed transfers in a unique date window.
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2027-03-01',
    amount: -500,
    merchantRaw: 'Transfer Out 1',
    txnType: 'transfer',
  });
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2027-03-02',
    amount: -200,
    merchantRaw: 'Transfer Out 2',
    txnType: 'transfer',
  });
  await createTxn({
    householdId: householdBId,
    accountId: accountBId,
    date: '2027-03-03',
    amount: 700,
    merchantRaw: 'Transfer In',
    txnType: 'transfer',
  });
  const dash = await agentB
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2027-03-01', dateTo: '2027-03-31' });
  assert.equal(dash.status, 200);
  // byCategory must contain no entries for this window (every row is a transfer).
  assert.equal(
    (dash.body.byCategory as Array<unknown>).length,
    0,
    `byCategory must be empty for transfer-only window, got ${JSON.stringify(dash.body.byCategory)}`,
  );
  const metrics = (dash.body.metricsByCurrency as Array<{
    currency: string;
    transactionCount: number;
    totalSpend: number;
    totalCredits: number;
  }>).find((m) => m.currency === 'CAD');
  assert.ok(metrics);
  assert.equal(metrics.transactionCount, 3, 'transactionCount still includes transfers');
  assert.equal(metrics.totalSpend, 0, 'transfers must not contribute to spend');
  assert.equal(metrics.totalCredits, 0, 'transfers must not contribute to credits');
});

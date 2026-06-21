/**
 * Integration tests for the /api/fx/* routes (issue #221).
 *
 * Exercises the four endpoints end-to-end through a real Postgres test
 * DB:
 *   - GET /api/fx/exposure
 *   - GET /api/fx/fees
 *   - GET /api/fx/effective-rates
 *   - GET /api/fx/reporting
 *
 * The shared seed helpers from portfolioFixtures.ts give us an
 * authenticated request agent + a household.
 *
 * IMPORTANT: regular-user transactions need either `visibility: 'shared'`
 * OR `createdByUserId: user.id` for visibleTransactionWhere to surface
 * them. We set both for belt + suspenders since some tests query as
 * the seeding user.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let myUserId: number;
let myHouseholdId: number;

before(async () => {
  testDb = await setupPgTestDb('fx-routes');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models/index.js');
  const { seedHousehold } = await import('./portfolioFixtures.js');

  const me = await seedHousehold(models, `fx-routes-me-${Date.now()}@example.com`);
  myUserId = me.user.id;
  myHouseholdId = me.household.id;
  authed = testAgent(app);
  authed.jar.setCookie(`cashflow_session=${me.token}; Path=/`);

  // Seed a CAD chequing + USD chequing.
  const cadAcc = await models.Account.create({
    name: 'CAD Chq',
    owner: 'me',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    householdId: myHouseholdId,
    ownerUserId: myUserId,
    visibility: 'shared',
  } as never);
  const usdAcc = await models.Account.create({
    name: 'USD Chq',
    owner: 'me',
    accountType: 'checking',
    defaultCurrency: 'USD',
    householdId: myHouseholdId,
    ownerUserId: myUserId,
    visibility: 'shared',
  } as never);

  // Pre-seed an FxRate so the looseHistoricalFxLookup resolves USD→CAD
  // without hitting the BoC API.
  await models.FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2026-01-15',
    rate: '1.35',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });

  // Helper to seed transactions with the right scope.
  const seedTxn = (opts: {
    accountId: number;
    date: string;
    amount: number;
    currency: string;
    merchantRaw: string;
    merchantClean?: string;
    notes?: string | null;
    linkedTransactionId?: number | null;
  }) => {
    const fp = `${opts.accountId}-${opts.date}-${opts.amount}-${Math.random()}`;
    return models.Transaction.create({
      accountId: opts.accountId,
      date: opts.date,
      amount: String(opts.amount),
      currency: opts.currency,
      merchantRaw: opts.merchantRaw,
      merchantClean: opts.merchantClean ?? opts.merchantRaw,
      notes: opts.notes ?? null,
      linkedTransactionId: opts.linkedTransactionId ?? null,
      importBatch: 'test',
      sourceRowFingerprint: fp,
      sourceIdentityFingerprint: fp,
      householdId: myHouseholdId,
      createdByUserId: myUserId,
      visibility: 'shared',
    } as never);
  };

  // CAD purchases.
  await seedTxn({ accountId: cadAcc.id, date: '2026-01-10', amount: -100, currency: 'CAD', merchantRaw: 'Tim Hortons' });
  await seedTxn({ accountId: cadAcc.id, date: '2026-01-12', amount: 200, currency: 'CAD', merchantRaw: 'Payroll' });

  // USD purchases.
  await seedTxn({ accountId: usdAcc.id, date: '2026-01-15', amount: -50, currency: 'USD', merchantRaw: 'Amazon' });

  // FX fee: explicit text trigger.
  await seedTxn({
    accountId: cadAcc.id,
    date: '2026-01-15',
    amount: -1.5,
    currency: 'CAD',
    merchantRaw: 'VISA FX FEE',
  });

  // Effective rate pair on CAD account: USD txn paired with CAD inflow.
  // Use linked_transaction_id to lock the pair.
  const usdLeg = await seedTxn({
    accountId: cadAcc.id,
    date: '2026-01-20',
    amount: -100,
    currency: 'USD',
    merchantRaw: 'Wire transfer USD',
  });
  await seedTxn({
    accountId: cadAcc.id,
    date: '2026-01-20',
    amount: 135,
    currency: 'CAD',
    merchantRaw: 'Wire transfer CAD',
    linkedTransactionId: usdLeg.id,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/fx/exposure: 401 unauthenticated', async () => {
  const res = await testRequest(app).get('/api/fx/exposure');
  assert.equal(res.status, 401);
});

test('GET /api/fx/exposure: returns per-currency breakdown', async () => {
  const res = await authed
    .get('/api/fx/exposure')
    .query({ dateFrom: '2026-01-01', dateTo: '2026-01-31', reportingCurrency: 'CAD' });
  assert.equal(res.status, 200, `body=${res.text}`);
  assert.equal(res.body.reportingCurrency, 'CAD');
  // Should see at least CAD and USD currencies.
  const currencies = res.body.byCurrency.map((r: { currency: string }) => r.currency);
  assert.ok(currencies.includes('CAD'));
  assert.ok(currencies.includes('USD'));
  // Total in CAD includes converted USD entries.
  assert.ok(typeof res.body.totalCadEquivalent === 'number');
});

test('GET /api/fx/exposure: non-CAD reportingCurrency converts CAD via inverse rate (no gaps)', async () => {
  // dateTo pinned to the seeded FxRate's ratedDate so the lookup cache-hits
  // deterministically (no live BoC call). Only the X→CAD direction exists in
  // the FxRate table — CAD→USD must be derived by inverting it.
  const res = await authed
    .get('/api/fx/exposure')
    .query({ dateFrom: '2026-01-01', dateTo: '2026-01-15', reportingCurrency: 'USD' });
  assert.equal(res.status, 200, `body=${res.text}`);
  assert.equal(res.body.reportingCurrency, 'USD');
  assert.deepEqual(res.body.gaps, [], 'CAD must not be an FX gap under USD reporting');
  const cad = res.body.byCurrency.find((r: { currency: string }) => r.currency === 'CAD');
  assert.ok(cad);
  // CAD nets to 98.5 in window; USD equivalent = 98.5 / 1.35 ≈ 72.963.
  assert.ok(Math.abs(cad.fxRate - 1 / 1.35) < 0.0001, `fxRate=${cad.fxRate}`);
  assert.ok(Math.abs(cad.cadEquivalent - 72.963) < 0.001, `cadEquivalent=${cad.cadEquivalent}`);
  // Headline total includes every currency: 72.963 (CAD) + (-50) (USD).
  assert.ok(Math.abs(res.body.totalCadEquivalent - 22.963) < 0.001, `total=${res.body.totalCadEquivalent}`);
});

test('GET /api/fx/exposure: rejects bad date', async () => {
  const res = await authed.get('/api/fx/exposure').query({ dateFrom: 'not-a-date' });
  assert.equal(res.status, 400);
});

test('GET /api/fx/exposure: rejects bad reportingCurrency', async () => {
  const res = await authed.get('/api/fx/exposure').query({ reportingCurrency: 'TOO_LONG' });
  assert.equal(res.status, 400);
});

test('GET /api/fx/fees: returns flagged FX fees', async () => {
  const res = await authed.get('/api/fx/fees').query({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });
  assert.equal(res.status, 200, `body=${res.text}`);
  // At least the "VISA FX FEE" row should appear.
  const merchants = res.body.fees.map((r: { merchant: string }) => r.merchant);
  assert.ok(merchants.some((m: string) => m.toUpperCase().includes('FX FEE')));
});

test('GET /api/fx/effective-rates: returns linked pair rate', async () => {
  const res = await authed.get('/api/fx/effective-rates').query({
    dateFrom: '2026-01-15',
    dateTo: '2026-01-25',
  });
  assert.equal(res.status, 200, `body=${res.text}`);
  // Two legs of a pair derive a rate each (one in each direction). Find
  // the USD→CAD derivation.
  const rate = res.body.rates.find(
    (r: { fromCurrency: string; toCurrency: string }) =>
      r.fromCurrency === 'USD' && r.toCurrency === 'CAD',
  );
  assert.ok(rate, `expected USD→CAD rate, got ${JSON.stringify(res.body.rates)}`);
  // 135/100 = 1.35
  assert.ok(Math.abs(rate.effectiveRate - 1.35) < 0.001);
});

test('GET /api/fx/reporting: normalizes per-metric totals to reporting currency', async () => {
  const res = await authed.get('/api/fx/reporting').query({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    reportingCurrency: 'CAD',
  });
  assert.equal(res.status, 200, `body=${res.text}`);
  assert.equal(res.body.reportingCurrency, 'CAD');
  // Three metrics expected.
  const keys = res.body.metrics.map((m: { key: string }) => m.key);
  assert.deepEqual(keys.sort(), ['netSpend', 'totalCredits', 'totalSpend']);
  // FX rates used should include USD→CAD.
  const usdRate = res.body.fxRatesUsed.find(
    (r: { from: string }) => r.from === 'USD',
  );
  assert.ok(usdRate);
});

test('GET /api/fx/reporting: non-CAD reportingCurrency converts every bucket (no gaps)', async () => {
  const res = await authed.get('/api/fx/reporting').query({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-15',
    reportingCurrency: 'USD',
  });
  assert.equal(res.status, 200, `body=${res.text}`);
  assert.equal(res.body.reportingCurrency, 'USD');
  assert.deepEqual(res.body.gaps, [], 'CAD must not be an FX gap under USD reporting');
  for (const metric of res.body.metrics as Array<{ key: string; partial: boolean }>) {
    assert.equal(metric.partial, false, `${metric.key} should not be partial`);
  }
  const cadRate = res.body.fxRatesUsed.find(
    (r: { from: string; to: string }) => r.from === 'CAD' && r.to === 'USD',
  );
  assert.ok(cadRate, `expected CAD→USD in fxRatesUsed, got ${JSON.stringify(res.body.fxRatesUsed)}`);
  assert.ok(Math.abs(cadRate.rate - 1 / 1.35) < 0.0001);
});

test('GET /api/fx/reporting: determinism — repeated calls return same totals', async () => {
  const params = {
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    reportingCurrency: 'CAD',
  };
  const a = await authed.get('/api/fx/reporting').query(params);
  const b = await authed.get('/api/fx/reporting').query(params);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(
    a.body.metrics.map((m: { key: string; normalized: number }) => ({
      key: m.key,
      normalized: m.normalized,
    })),
    b.body.metrics.map((m: { key: string; normalized: number }) => ({
      key: m.key,
      normalized: m.normalized,
    })),
  );
});

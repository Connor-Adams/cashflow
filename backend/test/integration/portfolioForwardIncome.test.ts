/**
 * Integration tests for GET /api/portfolio/forward-income.
 * Each test function uses its own sqlite + household to stay isolated.
 * Pattern mirrors portfolioIncome.test.ts — per-file db, node:test, supertest.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-forward-income.sqlite');

let app: import('express').Express;
let models: typeof import('../../src/models');

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
  models = await import('../../src/models');
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/** Build an authed agent + seeded household for each test. */
async function makeHousehold(tag: string) {
  const { seedHousehold } = await import('./portfolioFixtures.js');
  const seeded = await seedHousehold(models, `fi-${tag}-${Date.now()}@example.com`);
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
  return { ...seeded, agent };
}

// Helper to seed an account with explicit taxStatus
async function seedAccountWithTax(
  householdId: number,
  ownerUserId: number,
  name: string,
  shortCode: string,
  taxStatus: string,
) {
  const account = await models.Account.create({
    householdId,
    ownerUserId,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode,
    taxStatus,
  });
  return { id: account.id, name, shortCode };
}

// ─── Test 1: 401 when unauthenticated ────────────────────────────────────────

test('401 when unauthenticated', async () => {
  const res = await request(app).get('/api/portfolio/forward-income');
  assert.equal(res.status, 401);
});

// ─── Test 2: Empty household returns all-zero structure ───────────────────────

test('empty household returns all-zero structure', async () => {
  const { agent } = await makeHousehold('empty');
  const res = await agent.get('/api/portfolio/forward-income');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.ok(Array.isArray(body.rows), 'rows should be an array');
  assert.equal(body.rows.length, 0);
  assert.equal(body.totals.projectedAnnualIncomeCad, 0);
  assert.ok(Array.isArray(body.byTaxStatus));
  assert.ok(Array.isArray(body.byAssetType));
  assert.ok(Array.isArray(body.upcoming90d));
  assert.ok(Array.isArray(body.caveats.unreliableSecurityIds));
  assert.ok(Array.isArray(body.caveats.holdingsWithoutHistory));
});

// ─── Test 3: Returns projection for held security with dividend history ───────

test('returns projection for held CAD security with monthly dividends', async () => {
  const { household, user, agent } = await makeHousehold('cad-monthly');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'RRSP', 'RRSP01', 'registered_rrsp');
  const vcn = await seedSecurity(models, household.id, 'VCN', 'Vanguard FTSE Canada', 'ETF', 'CAD');

  // 100 shares at $20 = $2000 MV
  await seedHolding(models, {
    accountId: acct.id,
    householdId: household.id,
    securityId: vcn.id,
    statementDate: '2025-01-31',
    quantity: 100,
    price: 20,
    marketValue: 2000,
    costBasis: 1800,
    currency: 'CAD',
  });

  // 12 monthly dividends of $0.10/share each, anchored to the run date so they
  // always fall inside the endpoint's trailing-365-day window (inferCadence:
  // date >= asOf-365d && date <= asOf). Hardcoded dates rotted — the earliest
  // aged out of the window once "now" crossed its first-of-month, dropping the
  // sum to 11 × $0.10. Offsets 0..11 (this month back through 11 months ago)
  // keep all 12 comfortably in-window for any run date.
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      .toISOString()
      .slice(0, 10),
  );
  for (const date of months) {
    await seedDividend(models, { securityId: vcn.id, exDividendDate: date, amount: 0.10, currency: 'CAD' });
  }

  const res = await agent.get('/api/portfolio/forward-income');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.equal(body.rows.length, 1);

  const row = body.rows[0];
  assert.equal(row.symbol, 'VCN');
  assert.equal(row.cadenceLabel, 'monthly');
  assert.ok(Math.abs(row.annualDividendPerShare - 1.20) < 0.05, `annualDividendPerShare=${row.annualDividendPerShare}`);
  assert.ok(Math.abs(row.projectedAnnualIncomeNative - 120) < 5, `projectedAnnualIncomeNative=${row.projectedAnnualIncomeNative}`);
  assert.ok(Math.abs(row.projectedAnnualIncomeCad - 120) < 5, `projectedAnnualIncomeCad=${row.projectedAnnualIncomeCad} (CAD passthrough)`);
  // forwardYield = 120/2000 * 100 = 6%
  assert.ok(Math.abs(row.forwardYieldPct - 6) < 0.5, `forwardYieldPct=${row.forwardYieldPct}`);
  assert.ok(Math.abs(body.totals.projectedAnnualIncomeCad - 120) < 5);
});

// ─── Test 4: FX-converts USD to CAD in totals ────────────────────────────────

test('FX converts USD income to CAD using a seeded rate', async () => {
  const { household, user, agent } = await makeHousehold('usd-fx');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'RRSP-USD', 'RRSPUSD', 'registered_rrsp');
  const vti = await seedSecurity(models, household.id, 'VTI', 'Vanguard Total Market', 'ETF', 'USD');

  // 50 shares at $200 = $10000 USD MV
  await seedHolding(models, {
    accountId: acct.id,
    householdId: household.id,
    securityId: vti.id,
    statementDate: '2025-01-31',
    quantity: 50,
    price: 200,
    marketValue: 10000,
    costBasis: 8000,
    currency: 'USD',
  });

  // Quarterly dividends $0.80/share (=$3.20/year * 50 = $160 USD) — within last 12 months
  const quarters = ['2025-06-15', '2025-09-15', '2025-12-15', '2026-03-15'];
  for (const date of quarters) {
    await seedDividend(models, { securityId: vti.id, exDividendDate: date, amount: 0.80, currency: 'USD' });
  }

  // Seed a fixed USD→CAD rate so the test is deterministic
  const today = new Date().toISOString().slice(0, 10);
  await models.FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: today,
    rate: '1.37',
    source: 'fixture',
    fetchedAt: new Date(),
  });

  const res = await agent.get('/api/portfolio/forward-income');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.equal(body.rows.length, 1);

  const row = body.rows[0];
  assert.equal(row.currency, 'USD');
  // projNative ≈ 160 USD; projCad ≈ 160 * 1.37 = 219.20
  assert.ok(row.projectedAnnualIncomeNative > 140 && row.projectedAnnualIncomeNative < 175,
    `projectedAnnualIncomeNative=${row.projectedAnnualIncomeNative}`);
  assert.ok(row.projectedAnnualIncomeCad > row.projectedAnnualIncomeNative,
    'CAD total should exceed native USD (rate > 1)');
  assert.ok(
    Math.abs(row.projectedAnnualIncomeCad - row.projectedAnnualIncomeNative * 1.37) < 5,
    `projectedAnnualIncomeCad=${row.projectedAnnualIncomeCad}`
  );
  assert.ok(
    Math.abs(body.totals.projectedAnnualIncomeCad - row.projectedAnnualIncomeCad) < 1,
    'totals.projectedAnnualIncomeCad should match the single row'
  );
});

// ─── Test 5: byTaxStatus matrix for TFSA ─────────────────────────────────────

test('byTaxStatus contains registered_tfsa entry matching totalCad', async () => {
  const { household, user, agent } = await makeHousehold('tfsa-tax');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const tfsa = await seedAccountWithTax(household.id, user.id, 'TFSA', 'TFSA01', 'registered_tfsa');
  const xeqt = await seedSecurity(models, household.id, 'XEQT', 'iShares Core Equity', 'ETF', 'CAD');

  await seedHolding(models, {
    accountId: tfsa.id,
    householdId: household.id,
    securityId: xeqt.id,
    statementDate: '2025-01-31',
    quantity: 200,
    marketValue: 4000,
    costBasis: 3500,
    currency: 'CAD',
  });

  // 4 quarterly dividends of $0.25/share — within last 12 months
  const quarters = ['2025-06-01', '2025-09-01', '2025-12-01', '2026-03-01'];
  for (const date of quarters) {
    await seedDividend(models, { securityId: xeqt.id, exDividendDate: date, amount: 0.25, currency: 'CAD' });
  }

  const res = await agent.get('/api/portfolio/forward-income');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;

  const tfsaBucket = body.byTaxStatus.find((b: { taxStatus: string }) => b.taxStatus === 'registered_tfsa');
  assert.ok(tfsaBucket, `expected registered_tfsa in byTaxStatus, got: ${JSON.stringify(body.byTaxStatus)}`);
  // 200 shares * $1.00/year = $200 CAD
  assert.ok(tfsaBucket.totalCad > 0, `totalCad should be > 0, got ${tfsaBucket.totalCad}`);
  assert.ok(
    Math.abs(tfsaBucket.totalCad - body.totals.projectedAnnualIncomeCad) < 1,
    'TFSA-only household: byTaxStatus totalCad should match totals'
  );
});

// ─── Test 7: Perf smoke — median latency < 500ms with 50-security fixture ────

/**
 * Perf smoke for /api/portfolio/forward-income with 50 securities.
 *
 * Why median (and not p95) with this many samples:
 *   - The endpoint typically returns in 100-500ms warm, but CI workers
 *     occasionally spike a single sample to >1s due to GC / scheduler jitter
 *     unrelated to the route's actual cost.
 *   - The original assertion was "p95 < 500ms with 3 sample runs", which is
 *     mathematically just max-of-3 (Math.floor(3*0.95)=2). A single outlier
 *     forced the whole test red, even when the route is healthy.
 *   - Median of 5 samples is robust to one transient spike, still catches
 *     order-of-magnitude regressions, and keeps the test cheap.
 *   - The full durations vector is included in the failure message so a real
 *     regression is still easy to diagnose.
 */
test('forward income endpoint: median latency < 500ms with 50-security fixture (5 sample runs)', async () => {
  const { household, user, agent } = await makeHousehold('perf-50');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'Perf-RRSP', 'PERF01', 'registered_rrsp');

  const today = new Date().toISOString().slice(0, 10);
  await models.FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: today,
    rate: '1.37',
    source: 'fixture',
    fetchedAt: new Date(),
  });

  const months = [
    '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01',
    '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01',
    '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01',
  ];

  for (let i = 0; i < 50; i++) {
    const currency = i % 2 === 0 ? 'CAD' : 'USD';
    const sym = `PERF${String(i).padStart(2, '0')}`;
    const sec = await seedSecurity(models, household.id, sym, `Perf Security ${i}`, 'ETF', currency);

    await seedHolding(models, {
      accountId: acct.id,
      householdId: household.id,
      securityId: sec.id,
      statementDate: '2025-01-31',
      quantity: 100,
      price: 10,
      marketValue: 1000,
      costBasis: 900,
      currency,
    });

    for (const date of months) {
      await seedDividend(models, { securityId: sec.id, exDividendDate: date, amount: 0.10, currency });
    }
  }

  // Two warm calls — the first triggers the lazy projection rebuild for all
  // 50 securities; the second lets Sequelize / V8 settle so the measured
  // samples reflect steady-state cost, not first-hot-path effects.
  await agent.get('/api/portfolio/forward-income').expect(200);
  await agent.get('/api/portfolio/forward-income').expect(200);

  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const res = await agent.get('/api/portfolio/forward-income');
    durations.push(Date.now() - t0);
    assert.equal(res.status, 200);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(
    median < 500,
    `median was ${median}ms (durations: ${durations.join(', ')})`,
  );
});

// ─── Test 6: Lazy rebuild on stale ───────────────────────────────────────────

test('second call refreshes projections when dividend added between calls', async () => {
  const { household, user, agent } = await makeHousehold('stale-rebuild');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'RRSP2', 'RRSP02', 'registered_rrsp');
  const cm = await seedSecurity(models, household.id, 'CM', 'CIBC', 'EQUITY', 'CAD');

  await seedHolding(models, {
    accountId: acct.id,
    householdId: household.id,
    securityId: cm.id,
    statementDate: '2025-01-31',
    quantity: 100,
    marketValue: 5000,
    costBasis: 4000,
    currency: 'CAD',
  });

  // First call — no dividends yet, so projection income = 0
  const res1 = await agent.get('/api/portfolio/forward-income');
  assert.equal(res1.status, 200, JSON.stringify(res1.body));
  assert.equal(res1.body.rows.length, 1);
  const firstIncome = res1.body.totals.projectedAnnualIncomeCad;

  // Add monthly dividends (hooks will mark rows stale) — within last 12 months
  const months = [
    '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01',
    '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01',
    '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01',
  ];
  for (const date of months) {
    await seedDividend(models, { securityId: cm.id, exDividendDate: date, amount: 0.15, currency: 'CAD' });
  }

  // Second call — should trigger rebuild and return updated projections
  const res2 = await agent.get('/api/portfolio/forward-income');
  assert.equal(res2.status, 200, JSON.stringify(res2.body));
  const secondIncome = res2.body.totals.projectedAnnualIncomeCad;
  // After dividends, income should be significantly higher than first call
  assert.ok(
    secondIncome > firstIncome,
    `secondIncome (${secondIncome}) should exceed firstIncome (${firstIncome}) after adding dividends`
  );
  // ~$0.15/share * 12 * 100 shares = $180
  assert.ok(secondIncome > 100, `expected secondIncome > 100, got ${secondIncome}`);
});

// ─── FX hard-failure handling: stale-rate fallback, never silent parity ──────

test('falls back to the most recent cached FX rate instead of valuing USD at parity', async () => {
  const { household, user, agent } = await makeHousehold('usd-fx-stale');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'RRSP-USD2', 'RRSPUSD2', 'registered_rrsp');
  const vxus = await seedSecurity(models, household.id, 'VXUS', 'Vanguard Intl', 'ETF', 'USD');

  await seedHolding(models, {
    accountId: acct.id,
    householdId: household.id,
    securityId: vxus.id,
    statementDate: '2025-01-31',
    quantity: 100,
    price: 20,
    marketValue: 2000,
    costBasis: 1800,
    currency: 'USD',
  });

  // Monthly dividends anchored to the run date (same pattern as the CAD test).
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      .toISOString()
      .slice(0, 10),
  );
  for (const date of months) {
    await seedDividend(models, { securityId: vxus.id, exDividendDate: date, amount: 0.10, currency: 'USD' });
  }

  // ONLY a stale USD→CAD rate exists (outside ensureFxRate's 7-day window)
  // and the BoC API is unreachable. The endpoint must use the stale rate,
  // not silently value USD income at parity (rate 1).
  await models.FxRate.destroy({ where: {} });
  const staleDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  await models.FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: staleDate,
    rate: '1.30',
    source: 'fixture',
    fetchedAt: new Date(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('BoC unreachable (stubbed in test)');
  }) as unknown as typeof fetch;
  try {
    const res = await agent.get('/api/portfolio/forward-income');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.rows.find((r: { symbol: string }) => r.symbol === 'VXUS');
    assert.ok(row, 'VXUS row present');
    assert.ok(row.projectedAnnualIncomeNative > 100, `native=${row.projectedAnnualIncomeNative}`);
    assert.ok(
      Math.abs(row.projectedAnnualIncomeCad - row.projectedAnnualIncomeNative * 1.30) < 1,
      `expected CAD ≈ native × 1.30, got cad=${row.projectedAnnualIncomeCad} native=${row.projectedAnnualIncomeNative}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns 502 when no FX data exists at all for a held currency', async () => {
  const { household, user, agent } = await makeHousehold('usd-fx-none');
  const { seedSecurity, seedHolding, seedDividend } = await import('./portfolioFixtures.js');

  const acct = await seedAccountWithTax(household.id, user.id, 'RRSP-USD3', 'RRSPUSD3', 'registered_rrsp');
  const vea = await seedSecurity(models, household.id, 'VEA', 'Vanguard Dev Mkts', 'ETF', 'USD');

  await seedHolding(models, {
    accountId: acct.id,
    householdId: household.id,
    securityId: vea.id,
    statementDate: '2025-01-31',
    quantity: 10,
    price: 50,
    marketValue: 500,
    costBasis: 400,
    currency: 'USD',
  });
  await seedDividend(models, {
    securityId: vea.id,
    exDividendDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    amount: 0.50,
    currency: 'USD',
  });

  await models.FxRate.destroy({ where: {} });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('BoC unreachable (stubbed in test)');
  }) as unknown as typeof fetch;
  try {
    const res = await agent.get('/api/portfolio/forward-income');
    assert.equal(res.status, 502, JSON.stringify(res.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

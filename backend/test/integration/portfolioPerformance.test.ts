/**
 * Integration tests for GET /api/portfolio/performance.
 * Each test uses its own sqlite + household to stay isolated.
 * Pattern mirrors portfolioForwardIncome.test.ts — per-file db, node:test, supertest.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { testAgent, testRequest } from './_setup/testServer.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-performance.sqlite');

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
  const seeded = await seedHousehold(models, `perf-${tag}-${Date.now()}@example.com`);
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
  return { ...seeded, agent };
}

/** Seed an account with defaults. */
async function seedAccount(householdId: number, ownerUserId: number, name: string, shortCode: string) {
  const account = await models.Account.create({
    householdId,
    ownerUserId,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode,
  });
  return account;
}

/** Seed a PortfolioDailySnapshot row directly. */
async function seedSnapshot(opts: {
  householdId: number;
  accountId: number;
  date: string;
  marketValueCad: number;
  cashFlowCad?: number;
  isPartial?: boolean;
  missingDataReasons?: string[];
}) {
  return models.PortfolioDailySnapshot.create({
    householdId: opts.householdId,
    accountId: opts.accountId,
    date: opts.date,
    marketValueNative: String(opts.marketValueCad),
    currency: 'CAD',
    fxRateToCad: '1',
    marketValueCad: String(opts.marketValueCad),
    cashFlowNative: String(opts.cashFlowCad ?? 0),
    cashFlowCad: String(opts.cashFlowCad ?? 0),
    isPartial: opts.isPartial ?? false,
    missingDataReasons: opts.missingDataReasons ?? null,
    computedAt: new Date(),
  });
}

// ─── Test 1: 401 when unauthenticated ────────────────────────────────────────

test('401 when unauthenticated', async () => {
  const res = await testRequest(app).get('/api/portfolio/performance');
  assert.equal(res.status, 401);
});

// ─── Test 2: Empty household returns all-zero structure ───────────────────────

test('empty household returns all-zero structure', async () => {
  const { agent } = await makeHousehold('empty');
  const res = await agent.get('/api/portfolio/performance');
  assert.equal(res.status, 200);
  const body = res.body;
  assert.equal(body.stats.twrPct, 0, 'twrPct should be 0');
  assert.deepEqual(body.series, [], 'series should be empty');
  assert.deepEqual(body.byAccount, [], 'byAccount should be empty');
  assert.equal(body.caveats.benchmarkSymbol, 'SPY', 'benchmarkSymbol should default to SPY');
  assert.equal(typeof body.presetStats['1M'], 'object', 'presetStats.1M should exist');
  assert.equal(body.presetStats['1M'].twrPct, 0, 'preset 1M twrPct should be 0');
});

// ─── Test 3: Single-account 1Y TWR ───────────────────────────────────────────

test('single-account 1Y history TWR ≈ 10%', async () => {
  const { household, user, agent } = await makeHousehold('twr1y');
  const account = await seedAccount(household.id, user.id, 'Main RRSP', 'RRSP1');

  // Two snapshots: start MV=1000 day-1, end MV=1100 day-365.
  //
  // Timezone-awareness (PR #614): GET /api/portfolio/performance clips its
  // window's `to` to resolveHouseholdToday — "today" in the household's zone
  // (default America/Toronto), NOT UTC. An `end` snapshot dated at UTC-today
  // would land *after* the Toronto `to` during the 20:00-23:59 Toronto window
  // (= next-day UTC), get excluded from the series, and collapse TWR to ~0.
  // Anchor `end` to the SAME resolved today the endpoint uses (household has no
  // timezone -> default Toronto) so the snapshot is always in-window.
  const { resolveHouseholdToday } = await import('../../src/time/householdToday.js');
  const end = resolveHouseholdToday({ timezone: null });
  const startD = new Date(`${end}T00:00:00Z`);
  startD.setUTCDate(startD.getUTCDate() - 364); // safely inside the 1Y (-365d) window
  const start = startD.toISOString().slice(0, 10);

  await seedSnapshot({ householdId: household.id, accountId: account.id, date: start, marketValueCad: 1000 });
  await seedSnapshot({ householdId: household.id, accountId: account.id, date: end, marketValueCad: 1100 });

  const res = await agent.get('/api/portfolio/performance?range=1Y');
  assert.equal(res.status, 200);
  const { stats } = res.body;
  // TWR = (1100 - 0) / 1000 - 1 = 10%, so twrPct should be close to 10
  assert.ok(
    Math.abs(stats.twrPct - 10) < 1,
    `Expected twrPct ≈ 10, got ${stats.twrPct}`,
  );
  assert.equal(stats.endValueCad, 1100, 'endValueCad should be 1100');
});

// ─── Test 4: range='custom' validates from/to ────────────────────────────────

test("range='custom' validates from/to", async () => {
  const { agent } = await makeHousehold('custom-range');

  // Missing from/to → 400
  const res400 = await agent.get('/api/portfolio/performance?range=custom');
  assert.equal(res400.status, 400, 'Missing from/to should return 400');

  // Valid from/to → 200 with clipped series
  const res200 = await agent.get('/api/portfolio/performance?range=custom&from=2024-01-01&to=2024-12-31');
  assert.equal(res200.status, 200, 'Valid from/to should return 200');
  assert.equal(res200.body.range, 'custom');
});

// ─── Test 5: range='YTD' starts Jan 1 ────────────────────────────────────────

test("range='YTD' series starts Jan 1 of current year (or earliest available)", async () => {
  const { household, user, agent } = await makeHousehold('ytd');
  const account = await seedAccount(household.id, user.id, 'TFSA', 'TFSA1');
  const currentYear = new Date().getFullYear();
  const jan1 = `${currentYear}-01-01`;
  const jan2 = `${currentYear}-01-02`;

  await seedSnapshot({ householdId: household.id, accountId: account.id, date: jan1, marketValueCad: 5000 });
  await seedSnapshot({ householdId: household.id, accountId: account.id, date: jan2, marketValueCad: 5100 });

  const res = await agent.get('/api/portfolio/performance?range=YTD');
  assert.equal(res.status, 200);
  const { series } = res.body;
  assert.ok(series.length >= 1, 'Should have at least 1 series point');
  // First point should be on or after Jan 1 of current year
  assert.ok(series[0].date >= jan1, `First series date ${series[0].date} should be >= ${jan1}`);
});

// ─── Test 6: Per-account TWR + weight populated ───────────────────────────────

test('2 accounts → byAccount has 2 entries with weights summing to 100', async () => {
  const { household, user, agent } = await makeHousehold('byaccount');
  const accountA = await seedAccount(household.id, user.id, 'Account A', 'ACCA');
  const accountB = await seedAccount(household.id, user.id, 'Account B', 'ACCB');

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  await seedSnapshot({ householdId: household.id, accountId: accountA.id, date: yesterday, marketValueCad: 1000 });
  await seedSnapshot({ householdId: household.id, accountId: accountA.id, date: today, marketValueCad: 1100 });
  await seedSnapshot({ householdId: household.id, accountId: accountB.id, date: yesterday, marketValueCad: 2000 });
  await seedSnapshot({ householdId: household.id, accountId: accountB.id, date: today, marketValueCad: 2200 });

  const res = await agent.get('/api/portfolio/performance?range=1Y');
  assert.equal(res.status, 200);
  const { byAccount } = res.body;
  assert.equal(byAccount.length, 2, 'Should have 2 byAccount entries');
  const totalWeight = byAccount.reduce((sum: number, a: { weightInPortfolioPct: number }) => sum + a.weightInPortfolioPct, 0);
  assert.ok(Math.abs(totalWeight - 100) < 0.01, `Weights should sum to 100, got ${totalWeight}`);
  for (const acc of byAccount) {
    assert.ok(typeof acc.twrPct === 'number', 'twrPct should be a number');
    assert.ok(typeof acc.accountName === 'string', 'accountName should be a string');
  }
});

// ─── Test 7: Cross-household isolation ───────────────────────────────────────

test('cross-household isolation — household B data not visible to household A', async () => {
  const { household: hhA, user: userA, agent: agentA } = await makeHousehold('iso-a');
  const { household: hhB, user: userB } = await makeHousehold('iso-b');

  const accountA = await seedAccount(hhA.id, userA.id, 'A Account', 'AISO');
  const accountB = await seedAccount(hhB.id, userB.id, 'B Account', 'BISO');

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Seed only household B snapshots (household A has nothing)
  await seedSnapshot({ householdId: hhB.id, accountId: accountB.id, date: yesterday, marketValueCad: 50000 });
  await seedSnapshot({ householdId: hhB.id, accountId: accountB.id, date: today, marketValueCad: 60000 });

  // Also seed A's account so we can confirm B data isn't mixed in
  await seedSnapshot({ householdId: hhA.id, accountId: accountA.id, date: yesterday, marketValueCad: 100 });
  await seedSnapshot({ householdId: hhA.id, accountId: accountA.id, date: today, marketValueCad: 110 });

  const res = await agentA.get('/api/portfolio/performance?range=1Y');
  assert.equal(res.status, 200);
  const { byAccount } = res.body;
  const accountIds = byAccount.map((a: { accountId: number }) => a.accountId);
  assert.ok(!accountIds.includes(accountB.id), 'Household B account should not appear in household A response');
  assert.ok(accountIds.includes(accountA.id), 'Household A account should appear');
});

// ─── Test 8: Benchmark missing → caveats.benchmarkIsPartial=true ─────────────

test('benchmark Security missing → caveats.benchmarkIsPartial=true', async () => {
  const { household, user, agent } = await makeHousehold('bench-partial');
  const account = await seedAccount(household.id, user.id, 'Main', 'MAIN8');

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  await seedSnapshot({ householdId: household.id, accountId: account.id, date: yesterday, marketValueCad: 1000 });
  await seedSnapshot({ householdId: household.id, accountId: account.id, date: today, marketValueCad: 1100 });

  // Do NOT create a Security for benchmark symbol (SPY) — so benchmark lookup fails

  const res = await agent.get('/api/portfolio/performance?range=1Y');
  assert.equal(res.status, 200);
  assert.equal(res.body.caveats.benchmarkIsPartial, true, 'benchmarkIsPartial should be true when Security is missing');
  assert.equal(res.body.caveats.benchmarkSymbol, 'SPY');
});

// ─── Test 9: range key is case-insensitive (issue #552) ──────────────────────

test('range=ALL / all / All all resolve to the all-time range (200, not 500)', async () => {
  const { agent } = await makeHousehold('range-case');

  for (const variant of ['ALL', 'all', 'All']) {
    const res = await agent.get(`/api/portfolio/performance?range=${variant}`);
    assert.equal(res.status, 200, `range=${variant} should return 200, got ${res.status}`);
    // Response echoes the canonical 'All' key regardless of input casing.
    assert.equal(res.body.range, 'All', `range=${variant} should resolve to canonical 'All'`);
  }
});

// ─── Test 10: unknown range returns 400, not 500 (issue #552) ────────────────

test('unknown range returns 400 with a descriptive message (not 500)', async () => {
  const { agent } = await makeHousehold('range-unknown');

  const res = await agent.get('/api/portfolio/performance?range=BOGUS');
  assert.equal(res.status, 400, `Unknown range should return 400, got ${res.status}`);
  assert.match(
    res.body.error ?? '',
    /Unrecognized range/i,
    'Error message should describe the unrecognized range',
  );
});

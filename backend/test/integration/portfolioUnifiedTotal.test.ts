/**
 * Integration test for GET /api/portfolio unifiedTotal field.
 *
 * Seeds a USD holding and a pre-seeded FxRate row, then verifies that
 * the response includes a unifiedTotal whose marketValue equals the USD
 * market value × the seeded exchange rate, and whose ratesUsed array
 * includes the USD→CAD entry.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-unified.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

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

  const models = await import('../../src/models/index.js');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding } = await import(
    './portfolioFixtures.js'
  );

  const seeded = await seedHousehold(models, `unified-total-${Date.now()}@example.com`);
  const householdId = seeded.household.id;
  const userId = seeded.user.id;

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);

  // One investment account with a USD security.
  const tfsa = await seedAccount(models, householdId, userId, 'TFSA', 'UNIF01');
  const vti = await seedSecurity(models, householdId, 'VTI', 'Vanguard Total US', 'ETF', 'USD');

  // Holding: 10 units × imported market value $500 USD = $500 USD total.
  await seedHolding(models, {
    accountId: tfsa.id,
    householdId,
    securityId: vti.id,
    statementDate: '2026-05-22',
    quantity: 10,
    marketValue: 500,
    costBasis: 450,
    currency: 'USD',
  });

  // Pre-seed an FxRate row so we don't make real HTTP calls.
  // Rate: 1 USD = 1.3654 CAD.
  const today = new Date().toISOString().slice(0, 10);
  await models.FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: today,
    rate: '1.3654',
    source: 'bank_of_canada',
    fetchedAt: new Date(),
  });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('GET /api/portfolio: unifiedTotal converts USD holdings to CAD using seeded FxRate', async () => {
  const res = await authed.get('/api/portfolio');
  assert.equal(res.status, 200);

  const body = res.body as {
    totalsByCurrency: Array<{ currency: string; marketValue: number }>;
    unifiedTotal: {
      baseCurrency: string;
      marketValue: number;
      ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>;
    } | null;
  };

  // Sanity: we should have a USD total of 500.
  const usdTotal = body.totalsByCurrency.find((t) => t.currency === 'USD');
  assert.ok(usdTotal, 'should have a USD total');
  assert.equal(usdTotal.marketValue, 500);

  // unifiedTotal must be present and non-null.
  assert.ok(body.unifiedTotal !== null, 'unifiedTotal should be non-null');
  assert.equal(body.unifiedTotal.baseCurrency, 'CAD');

  // Expected CAD = 500 × 1.3654 = 682.7.
  const expectedCad = 500 * 1.3654;
  assert.ok(
    Math.abs(body.unifiedTotal.marketValue - expectedCad) < 0.01,
    `expected unifiedTotal.marketValue ≈ ${expectedCad}, got ${body.unifiedTotal.marketValue}`,
  );

  // ratesUsed must include USD→CAD.
  const usdRate = body.unifiedTotal.ratesUsed.find(
    (r) => r.from === 'USD' && r.to === 'CAD',
  );
  assert.ok(usdRate, 'ratesUsed should include USD→CAD entry');
  assert.equal(usdRate.rate, 1.3654);
});

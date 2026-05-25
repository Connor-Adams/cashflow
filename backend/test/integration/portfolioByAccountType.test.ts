/**
 * Integration tests for GET /api/portfolio/by-account-type.
 *
 * Verifies: bucket grouping by taxStatus, warnings,
 * harvestCandidates with superficial-loss check, household scoping.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-bytax.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let tfsaId: number;
let rrspId: number;
let nrId: number;
let xeqtId: number;
let vtiId: number;
let xbbId: number;
let vooId: number;
let householdId: number;

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
  const models = await import('../../src/models');
  const {
    seedHousehold,
    seedSecurity,
    seedHolding,
    seedActivity,
    seedDividend,
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `bytax-${Date.now()}@example.com`);
  householdId = seeded.household.id;

  const tfsa = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'TFSA01', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'TFSA01', taxStatus: 'registered_tfsa',
  });
  const rrsp = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'RRSP01', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'RRSP01', taxStatus: 'registered_rrsp',
  });
  const nr = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'Margin', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'NR01', taxStatus: 'non_registered',
  });
  tfsaId = tfsa.id;
  rrspId = rrsp.id;
  nrId = nr.id;

  const xeqt = await seedSecurity(models, householdId, 'XEQT.TO', 'iShares', 'ETF', 'CAD');
  const vti = await seedSecurity(models, householdId, 'VTI', 'Vanguard Total', 'ETF', 'USD');
  const xbb = await seedSecurity(models, householdId, 'XBB.TO', 'Cdn Bond', 'BOND', 'CAD');
  const voo = await seedSecurity(models, householdId, 'VOO', 'Vanguard S&P', 'ETF', 'USD');
  xeqtId = xeqt.id;
  vtiId = vti.id;
  xbbId = xbb.id;
  vooId = voo.id;

  await seedDividend(models, { securityId: voo.id, exDividendDate: '2026-03-01', amount: 1.5, currency: 'USD' });

  await seedHolding(models, {
    accountId: tfsa.id, householdId, securityId: voo.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 4500, costBasis: 4000,
  });
  await seedHolding(models, {
    accountId: rrsp.id, householdId, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3400, costBasis: 3000,
  });
  await seedHolding(models, {
    accountId: nr.id, householdId, securityId: vti.id,
    statementDate: '2026-05-01', quantity: 20, marketValue: 5000, costBasis: 4500,
  });
  await seedHolding(models, {
    accountId: nr.id, householdId, securityId: xbb.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 2500, costBasis: 3500,
  });

  await seedActivity(models, {
    accountId: rrsp.id, householdId, securityId: xbb.id,
    activityType: 'buy', tradeDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
    description: 'Buy XBB', quantity: 10, price: 25, amount: 250, currency: 'CAD',
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('returns buckets keyed by taxStatus with correct labels', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  assert.equal(res.status, 200);
  const taxStatuses = res.body.buckets.map((b: { taxStatus: string }) => b.taxStatus).sort();
  assert.deepEqual(taxStatuses, ['non_registered', 'registered_rrsp', 'registered_tfsa']);
  const tfsa = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'registered_tfsa');
  assert.equal(tfsa.label, 'TFSA');
});

test('bucket includes allocationByAssetType + rows + holdingsCount', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const nr = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'non_registered');
  assert.equal(nr.holdingsCount, 2);
  assert.ok(Array.isArray(nr.allocationByAssetType));
  assert.ok(Array.isArray(nr.rows));
  assert.equal(nr.rows.length, 2);
});

test('warnings include fixed_income_in_non_reg (XBB) + us_payer_in_tfsa (VOO)', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const kinds = res.body.warnings.map((w: { kind: string; symbol: string }) => `${w.kind}:${w.symbol}`).sort();
  assert.ok(kinds.includes('fixed_income_in_non_reg:XBB.TO'), `kinds=${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('us_payer_in_tfsa:VOO'), `kinds=${JSON.stringify(kinds)}`);
});

test('row flags include us_withholding for VTI in non-reg', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const nr = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'non_registered');
  const vti = nr.rows.find((r: { symbol: string }) => r.symbol === 'VTI');
  assert.ok(vti);
  assert.ok(vti.flags.includes('us_withholding'), `flags=${JSON.stringify(vti.flags)}`);
});

test('harvestCandidates includes XBB with superficialLossWarning=true', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const xbb = res.body.harvestCandidates.find((c: { symbol: string }) => c.symbol === 'XBB.TO');
  assert.ok(xbb, `candidates=${JSON.stringify(res.body.harvestCandidates)}`);
  assert.ok(xbb.unrealizedLossCad > 500);
  assert.equal(xbb.superficialLossWarning, true);
  assert.ok(xbb.superficialLossDetail && xbb.superficialLossDetail.length > 0);
});

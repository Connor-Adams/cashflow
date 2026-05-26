import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-divs.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;

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
  const { seedHousehold, seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `divs-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;
  // Need a holding so the security is visible
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 300, costBasis: 280,
  });
  await seedDividend(models, { securityId: xeqt.id, exDividendDate: '2025-12-15', amount: 0.18 });
  await seedDividend(models, { securityId: xeqt.id, exDividendDate: '2026-03-15', amount: 0.20 });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('returns dividends sorted ascending with backfill state', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/dividends`);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.events[0].exDividendDate, '2025-12-15');
  assert.equal(res.body.events[1].exDividendDate, '2026-03-15');
  assert.equal(res.body.backfill.status, 'fresh');
});

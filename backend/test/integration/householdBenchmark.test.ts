/**
 * Integration tests for PATCH /api/household/benchmark.
 * Uses the same auth helpers (seedHousehold, request.agent) as
 * portfolioForwardIncome.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-household-benchmark.sqlite');

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
  const seeded = await seedHousehold(models, `hb-${tag}-${Date.now()}@example.com`);
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
  return { ...seeded, agent };
}

// ─── Test 1: PATCH /api/household/benchmark updates symbol ───────────────────

test('PATCH /api/household/benchmark updates benchmarkSymbol', async () => {
  const { household, agent } = await makeHousehold('update');

  const res = await agent
    .patch('/api/household/benchmark')
    .send({ benchmarkSymbol: 'VEQT.TO' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.benchmarkSymbol, 'VEQT.TO');

  // Confirm DB reflects the update
  const hh = await models.Household.findByPk(household.id);
  assert.equal(hh?.benchmarkSymbol, 'VEQT.TO');
});

// ─── Test 2: Validates symbol shape ──────────────────────────────────────────

test('PATCH /api/household/benchmark returns 400 for invalid symbol', async () => {
  const { agent } = await makeHousehold('invalid');

  const res = await agent
    .patch('/api/household/benchmark')
    .send({ benchmarkSymbol: '!!!invalid!!!' });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.error, 'response should have an error field');
});

// ─── Test 3: 401 unauthenticated ─────────────────────────────────────────────

test('PATCH /api/household/benchmark returns 401 when unauthenticated', async () => {
  const res = await testRequest(app)
    .patch('/api/household/benchmark')
    .send({ benchmarkSymbol: 'VEQT.TO' });

  assert.equal(res.status, 401);
});

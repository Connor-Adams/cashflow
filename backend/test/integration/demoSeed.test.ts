import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import type { Express } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-demo-seed.sqlite');

let models: typeof import('../../src/models/index.js');
let seedDemoData: typeof import('../../src/demo/seedDemoData.js').seedDemoData;
let app: Express;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'production';
  process.env.DEMO_ACCOUNT_ENABLED = 'true';
  process.env.DEMO_ACCOUNT_EMAIL = 'dev-test@cashflow.local';
  process.env.DEMO_ACCOUNT_PASSWORD = 'cashflow-demo-test';
  process.env.OPENAI_API_KEY = 'test-key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
  });

  models = await import('../../src/models/index.js');
  ({ seedDemoData } = await import('../../src/demo/seedDemoData.js'));
  app = (await import('../../src/app.js')).default;
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('seedDemoData creates an idempotent production demo account with sample ledger data', async () => {
  await seedDemoData();
  await seedDemoData();

  const user = await models.User.findOne({
    where: { email: 'dev-test@cashflow.local' },
  });
  assert.ok(user);

  const memberships = await models.HouseholdMember.findAll({
    where: { userId: user.id },
  });
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, 'owner');

  const accounts = await models.Account.findAll({
    where: { householdId: memberships[0].householdId, shortCode: 'DEMO' },
  });
  assert.equal(accounts.length, 1);

  const transactions = await models.Transaction.findAll({
    where: { householdId: memberships[0].householdId },
  });
  assert.equal(transactions.length, 21);
  assert.ok(transactions.some((row) => row.finalCategory === 'Groceries'));
  assert.ok(transactions.some((row) => row.finalBusiness));
  assert.ok(transactions.some((row) => row.reviewFlag));

  const rules = await models.Rule.findAll({
    where: { householdId: memberships[0].householdId },
  });
  assert.equal(rules.length, 5);
});

test('POST /api/auth/demo-login creates a session for the seeded demo user', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/demo-login').send({});
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, 'dev-test@cashflow.local');
  const cookie = login.headers['set-cookie'];
  assert.ok(cookie);

  const txns = await agent.get('/api/transactions?pageSize=25').set('Cookie', cookie);
  assert.equal(txns.status, 200);
  assert.equal(txns.body.total, 21);
});

test('demo user cannot use AI even when OpenAI is configured', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/demo-login').send({});
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'];
  assert.ok(cookie);

  const status = await agent.get('/api/ai/status').set('Cookie', cookie);
  assert.equal(status.status, 200);
  assert.equal(status.body.openai, false);

  const txns = await agent.get('/api/transactions?pageSize=1').set('Cookie', cookie);
  assert.equal(txns.status, 200);
  const id = txns.body.data[0].id;

  const rowAi = await agent.post(`/api/transactions/${id}/ai-suggest`).set('Cookie', cookie);
  assert.equal(rowAi.status, 403);
  assert.match(rowAi.body.error, /demo account/i);

  const bulkAi = await agent
    .post('/api/transactions/bulk-ai-suggest')
    .set('Cookie', cookie)
    .send({ ids: [id] });
  assert.equal(bulkAi.status, 403);
  assert.match(bulkAi.body.error, /demo account/i);
});

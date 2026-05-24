/**
 * Integration tests for `backend/src/routes/items.ts`.
 *
 * Setup mirrors `backend/test/integration/transactions.test.ts`:
 *   - isolated SQLite DB
 *   - bootstrap superadmin
 *   - two non-superadmin households (A and B) via `seedHousehold` helper
 *
 * Items are written via direct model creates for tight fixture control.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-items.sqlite');

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;

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

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-items@example.com',
    displayName: 'Super Items',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('ItemsA', 'A Partner');
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);
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

test('GET /api/items returns empty list for new household', async () => {
  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
});

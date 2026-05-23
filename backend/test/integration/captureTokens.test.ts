import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-capture-tokens.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development', GH_PACKAGES_TOKEN: 'dummy' },
    stdio: 'pipe',
  });
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'tokens@example.com',
    displayName: 'Tokens User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('mints a token, lists it (without plaintext), then revokes', async () => {
  const mint = await authed.post('/api/capture/tokens').send({ label: 'My Mac' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfc_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'My Mac');
  const tokenId = mint.body.id;

  const list = await authed.get('/api/capture/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].tokenHash, undefined, 'list must never include tokenHash');
  assert.equal(list.body[0].userId, undefined, 'list must never include userId');
  assert.equal(list.body[0].label, 'My Mac');

  const revoke = await authed.delete(`/api/capture/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  const listAfter = await authed.get('/api/capture/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('rejects unauthenticated calls', async () => {
  const res = await request(app).post('/api/capture/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});

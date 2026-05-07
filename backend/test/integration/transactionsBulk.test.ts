/**
 * Integration tests run in isolation (`yarn test:integration`) so DATABASE_PATH
 * is set before any Sequelize import.
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
const dbPath = path.join(backendRoot, 'data', 'test-integration-bulk.sqlite');
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-integration-bulk-csv');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(csvUploadDir, { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'bulk@example.com',
    displayName: 'Bulk User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
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

test('POST /api/transactions/bulk-patch updates rows', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Bulk Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n2025-06-02,Shop,-3.00\n';
  const imp = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', 'bulk-test-batch')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'stmt.csv',
      contentType: 'text/csv',
    });
  assert.equal(imp.status, 200);

  const list = await authed.get('/api/transactions?pageSize=25');
  assert.equal(list.status, 200);
  const ids = (list.body.data as { id: number }[]).map((t) => t.id);
  assert.ok(ids.length >= 2);

  const batch = await authed.get(
    `/api/transactions?importBatch=${encodeURIComponent('bulk-test-batch')}`
  );
  assert.equal(batch.status, 200);
  assert.equal(
    (batch.body.data as unknown[]).length,
    ids.length,
    'importBatch filter should match uploaded rows'
  );

  const res = await authed.post('/api/transactions/bulk-patch').send({
    ids,
    patch: { categoryOverride: 'Groceries', reviewFlag: false },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, ids.length);

  const again = await authed.get('/api/transactions?pageSize=25');
  for (const row of again.body.data as { finalCategory: string }[]) {
    assert.equal(row.finalCategory, 'Groceries');
  }
});

test('POST /api/transactions/bulk-patch 400 when patch empty', async () => {
  const res = await authed.post('/api/transactions/bulk-patch').send({
    ids: [1],
    patch: {},
  });
  assert.equal(res.status, 400);
});

test('GET /api/transactions/category-hints returns known categories with usage counts', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Category Hint Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-07-01,Grocer,-10.00\n2025-07-02,Cafe,-12.00\n';
  const imp = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'category-hints.csv',
      contentType: 'text/csv',
    });
  assert.equal(imp.status, 200);

  const list = await authed.get('/api/transactions?pageSize=25');
  assert.equal(list.status, 200);
  const ids = (list.body.data as { id: number }[]).slice(0, 2).map((t) => t.id);
  assert.equal(ids.length, 2);

  const patch = await authed.post('/api/transactions/bulk-patch').send({
    ids,
    patch: { categoryOverride: 'Groceries', reviewFlag: false },
  });
  assert.equal(patch.status, 200);

  const rule = await authed.post('/api/rules').send({
    merchantPattern: 'coffee',
    matchKind: 'substring',
    priority: 1,
    category: 'Dining',
    isBusiness: false,
    splitType: 'me',
  });
  assert.equal(rule.status, 201);

  const res = await authed.get('/api/transactions/category-hints');
  assert.equal(res.status, 200);
  const categories = res.body.categories as { label: string; usageCount: number }[];
  assert.ok(
    categories.some((row) => row.label === 'Groceries' && row.usageCount >= 2)
  );
  assert.ok(categories.some((row) => row.label === 'Dining'));
});

test('invited partner sees shared records but not private records', async () => {
  const invite = await authed.post('/api/auth/invites').send();
  assert.equal(invite.status, 201);

  const partner = request.agent(app);
  const joined = await partner.post('/api/auth/register').send({
    email: 'partner@example.com',
    displayName: 'Partner User',
    password: 'password123',
    inviteToken: invite.body.token,
  });
  assert.equal(joined.status, 201);

  const privateAcc = await authed.post('/api/accounts').send({
    name: 'Private Account',
    owner: 'me',
    defaultCurrency: 'CAD',
    visibility: 'private',
  });
  const sharedAcc = await authed.post('/api/accounts').send({
    name: 'Shared Account',
    owner: 'joint',
    defaultCurrency: 'CAD',
    visibility: 'shared',
  });
  assert.equal(privateAcc.status, 201);
  assert.equal(sharedAcc.status, 201);

  const privateCsv = 'Date,Description,Amount\n2025-10-01,Private,-7.00\n';
  const sharedCsv = 'Date,Description,Amount\n2025-10-02,Shared,-8.00\n';
  assert.equal(
    (
      await authed
        .post('/api/import/upload')
        .field('accountId', String(privateAcc.body.id))
        .field('profileId', 'generic_simple')
        .attach('file', Buffer.from(privateCsv, 'utf8'), {
          filename: 'private.csv',
          contentType: 'text/csv',
        })
    ).status,
    200
  );
  assert.equal(
    (
      await authed
        .post('/api/import/upload')
        .field('accountId', String(sharedAcc.body.id))
        .field('profileId', 'generic_simple')
        .attach('file', Buffer.from(sharedCsv, 'utf8'), {
          filename: 'shared.csv',
          contentType: 'text/csv',
        })
    ).status,
    200
  );

  const partnerAccounts = await partner.get('/api/accounts');
  assert.equal(partnerAccounts.status, 200);
  const accountNames = (partnerAccounts.body as { name: string }[]).map((a) => a.name);
  assert.ok(accountNames.includes('Shared Account'));
  assert.ok(!accountNames.includes('Private Account'));

  const partnerTxns = await partner.get('/api/transactions?pageSize=100');
  assert.equal(partnerTxns.status, 200);
  const merchants = (partnerTxns.body.data as { merchantClean: string }[]).map(
    (t) => t.merchantClean
  );
  assert.ok(merchants.includes('Shared'));
  assert.ok(!merchants.includes('Private'));
});

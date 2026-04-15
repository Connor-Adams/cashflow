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
  const acc = await request(app).post('/api/accounts').send({
    name: 'Bulk Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n2025-06-02,Shop,-3.00\n';
  const imp = await request(app)
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', 'bulk-test-batch')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'stmt.csv',
      contentType: 'text/csv',
    });
  assert.equal(imp.status, 200);

  const list = await request(app).get('/api/transactions?pageSize=25');
  assert.equal(list.status, 200);
  const ids = (list.body.data as { id: number }[]).map((t) => t.id);
  assert.ok(ids.length >= 2);

  const batch = await request(app).get(
    `/api/transactions?importBatch=${encodeURIComponent('bulk-test-batch')}`
  );
  assert.equal(batch.status, 200);
  assert.equal(
    (batch.body.data as unknown[]).length,
    ids.length,
    'importBatch filter should match uploaded rows'
  );

  const res = await request(app).post('/api/transactions/bulk-patch').send({
    ids,
    patch: { categoryOverride: 'Groceries', reviewFlag: false },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, ids.length);

  const again = await request(app).get('/api/transactions?pageSize=25');
  for (const row of again.body.data as { finalCategory: string }[]) {
    assert.equal(row.finalCategory, 'Groceries');
  }
});

test('POST /api/transactions/bulk-patch 400 when patch empty', async () => {
  const res = await request(app).post('/api/transactions/bulk-patch').send({
    ids: [1],
    patch: {},
  });
  assert.equal(res.status, 400);
});

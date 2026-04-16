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
const dbPath = path.join(backendRoot, 'data', 'test-integration.sqlite');
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-integration-csv');

let app: import('express').Express;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(csvUploadDir, { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.NODE_ENV = 'test';

  // sequelize.config.cjs uses :memory: when NODE_ENV=test; use development so migrations hit DATABASE_PATH.
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

test('POST /api/import/upload: creates transactions for valid CSV', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'Integration Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n2025-06-02,Shop,-3.00\n';
  const res = await request(app)
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'stmt.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.inserted === 'number');
  assert.ok(res.body.inserted >= 2, `expected inserted >= 2, got ${JSON.stringify(res.body)}`);
});

test('POST /api/import/upload: 400 when accountId missing', async () => {
  const csv = 'Date,Description,Amount\n2025-06-01,X,-1\n';
  const res = await request(app)
    .post('/api/import/upload')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'x.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 400);
  assert.ok(String(res.body?.error || '').includes('accountId'));
});

test('POST /api/import/upload: returns parseErrors for bad rows', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'ParseErr Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n' +
    '2025-06-01,OK Row,-1.00\n' +
    'not-a-date,Bad Row,-2.00\n' +
    '2025-06-03,OK Row Two,-3.00\n' +
    ',Missing,-4.00\n';

  const res = await request(app)
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'mixed.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.parseErrors));
  assert.equal(res.body.parseErrors.length, 2);
  assert.equal(res.body.rowErrors, 2);
  assert.ok(res.body.inserted >= 2);
  assert.ok(
    res.body.parseErrors.some((e: { message: string }) =>
      String(e.message).toLowerCase().includes('invalid date')
    )
  );
  assert.ok(
    res.body.parseErrors.some((e: { message: string }) =>
      String(e.message).toLowerCase().includes('missing')
    )
  );
});

test('POST /api/import/upload: rejects non-csv extension', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'A2',
    owner: 'me',
  });
  const accountId = acc.body.id as number;

  const res = await request(app)
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', Buffer.from('a,b\n1,2'), {
      filename: 'bad.txt',
      contentType: 'text/plain',
    });

  assert.equal(res.status, 400);
});

test('GET /api/import/profiles returns CSV profile list', async () => {
  const res = await request(app).get('/api/import/profiles');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  assert.ok(
    res.body.some(
      (p: { id: string }) => p.id === 'generic_simple'
    )
  );
});

test('GET /api/summary/monthly returns points after import', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'Monthly Test',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Cafe,-5.50\n2025-07-01,Shop,-3.00\n';
  const up = await request(app)
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'm.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);

  const res = await request(app).get('/api/summary/monthly');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.points));
  assert.ok(res.body.points.length >= 1);
  const cad = res.body.points.filter(
    (p: { currency: string }) => p.currency === 'CAD'
  );
  assert.ok(cad.some((p: { month: string }) => p.month === '2025-06'));
  assert.ok(cad.some((p: { month: string }) => p.month === '2025-07'));
});

test('POST /api/import/preview returns headers and mapped rows', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'Preview Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n';
  const res = await request(app)
    .post('/api/import/preview')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'preview.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.headers));
  assert.ok(res.body.headers.includes('Date'));
  assert.ok(Array.isArray(res.body.rows));
  assert.equal(res.body.rows.length, 1);
  const row = res.body.rows[0] as { ok: boolean; mapped?: { date: string } };
  assert.equal(row.ok, true);
  assert.equal(row.mapped?.date, '2025-06-01');
});

test('POST /api/import/preview: row error for invalid date', async () => {
  const acc = await request(app).post('/api/accounts').send({
    name: 'Preview Bad Row',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\nnot-a-date,X,-1\n';
  const res = await request(app)
    .post('/api/import/preview')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'bad.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  const row = res.body.rows[0] as { ok: boolean; error?: string };
  assert.equal(row.ok, false);
  assert.ok(
    String(row.error ?? '').toLowerCase().includes('invalid date'),
    `expected invalid date in ${row.error}`
  );
});

test('POST /api/import/preview: 400 when accountId missing', async () => {
  const csv = 'Date,Description,Amount\n2025-06-01,X,-1\n';
  const res = await request(app)
    .post('/api/import/preview')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'x.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400);
});

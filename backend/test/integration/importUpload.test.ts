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
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-integration-receipts');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(csvUploadDir, { recursive: true });
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;
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
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'integration@example.com',
    displayName: 'Integration User',
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
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

test('protected routes require auth', async () => {
  const res = await request(app).get('/api/accounts');
  assert.equal(res.status, 401);
});

test('POST /api/import/upload: creates transactions for valid CSV', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Integration Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n2025-06-02,Shop,-3.00\n';
  const res = await authed
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

test('POST /api/import/upload-many: imports multiple CSV files', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Multi Upload Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const one = 'Date,Description,Amount\n2025-06-04,Multi One,-4.00\n';
  const two = 'Date,Description,Amount\n2025-06-05,Multi Two,-5.00\n';
  const res = await authed
    .post('/api/import/upload-many')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('files', Buffer.from(one, 'utf8'), {
      filename: 'multi-one.csv',
      contentType: 'text/csv',
    })
    .attach('files', Buffer.from(two, 'utf8'), {
      filename: 'multi-two.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 2);
  assert.deepEqual(
    res.body.results.map((row: { inserted?: number }) => row.inserted),
    [1, 1],
  );
});

test('POST /api/import/upload-many: rejects empty uploads', async () => {
  const res = await authed
    .post('/api/import/upload-many')
    .field('accountId', '1')
    .field('profileId', 'generic_simple');

  assert.equal(res.status, 400);
  assert.ok(String(res.body?.error || '').includes('files'));
});

test('receipt upload stores, downloads, lists, and deletes the image', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Receipt Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);

  const csv = 'Date,Description,Amount\n2025-06-03,Receipt Cafe,-7.25\n';
  const upload = await authed
    .post('/api/import/upload')
    .field('accountId', String(acc.body.id))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'receipt-source.csv',
      contentType: 'text/csv',
    });
  assert.equal(upload.status, 200);

  const txns = await authed.get('/api/transactions').query({ pageSize: 5 });
  assert.equal(txns.status, 200);
  const txn = txns.body.data.find(
    (row: { merchantClean?: string }) => row.merchantClean === 'Receipt Cafe',
  );
  assert.ok(txn, `expected imported transaction in ${JSON.stringify(txns.body.data)}`);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz9ncwAAAABJRU5ErkJggg==',
    'base64',
  );
  const receipt = await authed
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', png, {
      filename: 'receipt.png',
      contentType: 'image/png',
    });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body.originalName, 'receipt.png');

  const list = await authed.get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, receipt.body.id);

  const file = await authed.get(`/api/receipts/${receipt.body.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(file.body, png);

  const deleted = await authed.delete(`/api/receipts/${receipt.body.id}`);
  assert.equal(deleted.status, 204);

  const empty = await authed.get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.length, 0);
});

test('POST /api/import/upload: 400 when accountId missing', async () => {
  const csv = 'Date,Description,Amount\n2025-06-01,X,-1\n';
  const res = await authed
    .post('/api/import/upload')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'x.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 400);
  assert.ok(String(res.body?.error || '').includes('accountId'));
});

test('POST /api/import/upload: returns parseErrors for bad rows', async () => {
  const acc = await authed.post('/api/accounts').send({
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

  const res = await authed
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
  const acc = await authed.post('/api/accounts').send({
    name: 'A2',
    owner: 'me',
  });
  const accountId = acc.body.id as number;

  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', Buffer.from('a,b\n1,2'), {
      filename: 'bad.txt',
      contentType: 'text/plain',
    });

  assert.equal(res.status, 400);
});

test('GET /api/ai/status returns openai flag', async () => {
  const res = await authed.get('/api/ai/status');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.openai, 'boolean');
});

test('GET /api/import/profiles returns CSV profile list', async () => {
  const res = await authed.get('/api/import/profiles');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  assert.equal(res.body[0]?.id, 'auto');
  assert.ok(
    res.body.some(
      (p: { id: string }) => p.id === 'generic_simple'
    )
  );
});

test('GET /api/summary/monthly returns points after import', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Monthly Test',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Amount\n2025-06-01,Cafe,-5.50\n2025-07-01,Shop,-3.00\n';
  const up = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'm.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);

  const res = await authed.get('/api/summary/monthly');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.points));
  assert.ok(res.body.points.length >= 1);
  const cad = res.body.points.filter(
    (p: { currency: string }) => p.currency === 'CAD'
  );
  assert.ok(cad.some((p: { month: string }) => p.month === '2025-06'));
  assert.ok(cad.some((p: { month: string }) => p.month === '2025-07'));
});

test('GET /api/summary/dashboard separates payments from refunds', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Dashboard Metrics Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Type,Amount\n' +
    '2025-09-01,Grocery Store,Debit,100.00\n' +
    '2025-09-02,ONLINE PAYMENT THANK YOU,Credit,100.00\n' +
    '2025-09-03,MERCHANDISE REFUND,Credit,25.00\n';
  const up = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'dashboard-signs.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);
  assert.equal(up.body.inserted, 3);

  const res = await authed
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2025-09-01', dateTo: '2025-09-30' });
  assert.equal(res.status, 200);
  const metrics = (res.body.metricsByCurrency as {
    currency: string;
    totalSpend: number;
    totalCredits: number;
    totalPayments: number;
    netSpend: number;
    transactionCount: number;
  }[]).find((row) => row.currency === 'CAD');
  assert.ok(metrics);
  assert.equal(metrics?.totalSpend, 100);
  assert.equal(metrics?.totalCredits, 25);
  assert.equal(metrics?.totalPayments, 100);
  assert.equal(metrics?.netSpend, 75);
  assert.equal(metrics?.transactionCount, 3);

  const accountSummary = (res.body.accountSummaries as {
    currency: string;
    accountId: number;
    accountName: string;
    totalSpend: number;
    totalCredits: number;
    totalPayments: number;
    netSpend: number;
    transactionCount: number;
    reviewCount: number;
  }[]).find((row) => row.currency === 'CAD' && row.accountName === 'Dashboard Metrics Account');
  assert.ok(accountSummary);
  assert.equal(accountSummary?.totalSpend, 100);
  assert.equal(accountSummary?.totalCredits, 25);
  assert.equal(accountSummary?.totalPayments, 100);
  assert.equal(accountSummary?.netSpend, 75);
  assert.equal(accountSummary?.transactionCount, 3);
  assert.equal(accountSummary?.reviewCount, 3);

  const merchantRows = res.body.merchantSummaries as {
    currency: string;
    merchant: string;
    totalSpend: number;
    totalCredits: number;
    totalPayments: number;
    netSpend: number;
    transactionCount: number;
    reviewCount: number;
  }[];
  assert.equal(merchantRows.filter((row) => row.currency === 'CAD').length, 3);
  assert.ok(
    merchantRows.some(
      (row) =>
        row.currency === 'CAD' &&
        row.totalSpend === 100 &&
        row.totalCredits === 0 &&
        row.totalPayments === 0 &&
        row.netSpend === 100
    )
  );
  assert.ok(
    merchantRows.some(
      (row) =>
        row.currency === 'CAD' &&
        row.totalSpend === 0 &&
        row.totalCredits === 0 &&
        row.totalPayments === 100 &&
        row.netSpend === 0
    )
  );

  const reviewQueue = res.body.reviewQueue as {
    date: string;
    currency: string;
    amount: number;
  }[];
  assert.equal(reviewQueue.length, 3);
  assert.deepEqual(
    reviewQueue.map((row) => row.date),
    ['2025-09-03', '2025-09-02', '2025-09-01']
  );
  assert.deepEqual(
    reviewQueue.map((row) => row.amount),
    [25, 100, -100]
  );

  const categoryRows = (res.body.byCategory as {
    currency: string;
    category: string | null;
    sumAmount: number;
  }[]).filter((row) => row.currency === 'CAD');
  assert.equal(
    categoryRows.reduce((sum, row) => sum + row.sumAmount, 0),
    -75,
    'category activity includes charges and refunds, but excludes payments'
  );
});

test('GET /api/summary/monthly excludes payment rows from monthly activity', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Monthly Payments Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Type,Amount\n' +
    '2025-08-01,Grocery Store,Debit,100.00\n' +
    '2025-08-02,ONLINE PAYMENT THANK YOU,Credit,60.00\n' +
    '2025-08-03,MERCHANDISE REFUND,Credit,10.00\n';
  const up = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'monthly-activity.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);

  const res = await authed
    .get('/api/summary/monthly')
    .query({ currency: 'CAD', dateFrom: '2025-08-01', dateTo: '2025-08-31' });
  assert.equal(res.status, 200);
  const august = (res.body.points as {
    month: string;
    currency: string;
    sumAmount: number;
  }[]).find((row) => row.month === '2025-08' && row.currency === 'CAD');
  assert.ok(august);
  assert.equal(august?.sumAmount, -90);
});

test('POST /api/import/preview returns headers and mapped rows', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Preview Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n';
  const res = await authed
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
  assert.equal(res.body.usedProfileId, 'generic_simple');
  assert.equal(res.body.profileInferred, false);
});

test('POST /api/import/preview: row error for invalid date', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Preview Bad Row',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\nnot-a-date,X,-1\n';
  const res = await authed
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

test('POST /api/import/preview maps Visa monthly fee rows with blank details', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Preview Visa Fee',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'transaction_date,post_date,type,details,amount,currency\n' +
    '2025-12-12,2025-12-12,Monthly fee,,10.0,CAD\n';
  const res = await authed
    .post('/api/import/preview')
    .field('accountId', String(accountId))
    .field('profileId', 'auto')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'visa-fee.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.usedProfileId, 'generic_simple');
  const row = res.body.rows[0] as {
    ok: boolean;
    mapped?: { merchantClean: string; amount: number };
  };
  assert.equal(row.ok, true);
  assert.equal(row.mapped?.merchantClean, 'Monthly fee');
  assert.equal(row.mapped?.amount, -10);
});

test('POST /api/import/preview: 400 when accountId missing', async () => {
  const csv = 'Date,Description,Amount\n2025-06-01,X,-1\n';
  const res = await authed
    .post('/api/import/preview')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'x.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400);
});

test('POST /api/import/upload with profile auto infers generic_simple', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Auto Profile Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv = 'Date,Description,Amount\n2025-06-01,Cafe,-5.50\n';
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'auto')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'auto.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.usedProfileId, 'generic_simple');
  assert.equal(res.body.profileInferred, true);
  assert.ok((res.body.inserted as number) >= 1);
});

test('POST /api/import/upload keeps payment rows positive when generic profile normalizes signs', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Payment Direction Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const csv =
    'Date,Description,Type,Amount\n' +
    '2025-06-01,Grocery Store,Debit,1200.00\n' +
    '2025-06-02,ONLINE PAYMENT THANK YOU,Credit,-1200.00\n';

  const up = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'payment-signs.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);
  assert.equal(up.body.inserted, 2);

  const txns = await authed
    .get('/api/transactions')
    .query({ accountId });
  assert.equal(txns.status, 200);
  const byDescription = new Map(
    (txns.body.data as { merchantRaw: string; amount: number }[]).map((t) => [
      t.merchantRaw,
      t.amount,
    ])
  );
  assert.equal(byDescription.get('Grocery Store'), -1200);
  assert.equal(byDescription.get('ONLINE PAYMENT THANK YOU'), 1200);
});

/**
 * Integration tests run in isolation (`yarn test:integration`) so DATABASE_URL
 * is set before any Sequelize import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
let models: typeof import('../../src/models/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const fixturesDir = path.join(backendRoot, 'test', 'fixtures', 'pdf');
const hasFixtures = fs.existsSync(path.join(fixturesDir, 'cibc-costco-2026-01-12.pdf'));
const skipNoFixtures = hasFixtures ? undefined : 'PDF fixtures not present (gitignored — see backend/test/fixtures/pdf/)';
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-integration-csv');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-integration-receipts');

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  fs.mkdirSync(csvUploadDir, { recursive: true });
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  testDb = await setupPgTestDb('upload');

  models = await import('../../src/models/index.js');
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

after(async () => {
  await teardownPgTestDb(testDb);
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

test('POST /api/import/preview does not mutate until commit', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Preview Commit Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);

  const csv = 'Date,Description,Amount\n2025-10-01,Commit Cafe,-9.25\n';
  const preview = await authed
    .post('/api/import/preview')
    .field('accountId', String(acc.body.id))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'commit-preview.csv',
      contentType: 'text/csv',
    });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.transactions.length, 1);
  assert.ok(preview.body.previewToken);

  const before = await authed
    .get('/api/transactions')
    .query({ accountId: acc.body.id, pageSize: 100 });
  assert.equal(before.status, 200);
  assert.equal(
    before.body.data.some((row: { merchantClean: string }) => row.merchantClean === 'Commit Cafe'),
    false
  );

  const commit = await authed
    .post('/api/import/commit')
    .send({ previewToken: preview.body.previewToken });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.insertedTransactions, 1);

  const afterRows = await authed
    .get('/api/transactions')
    .query({ accountId: acc.body.id, pageSize: 100 });
  assert.equal(afterRows.status, 200);
  assert.equal(
    afterRows.body.data.some((row: { merchantClean: string }) => row.merchantClean === 'Commit Cafe'),
    true
  );
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

test('investment OFX preview and commit populates portfolio', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'Brokerage Account',
    owner: 'me',
    defaultCurrency: 'USD',
    accountType: 'investment',
  });
  assert.equal(acc.status, 201);
  assert.equal(acc.body.accountType, 'investment');

  const ofx = `
OFXHEADER:100
DATA:OFXSGML

<OFX>
  <INVSTMTMSGSRSV1>
    <INVSTMTTRNRS>
      <INVSTMTRS>
        <CURDEF>USD
        <DTASOF>20251231210000
        <INVTRANLIST>
          <BUYSTOCK>
            <INVBUY>
              <INVTRAN><FITID>BUY1<DTTRADE>20251215<MEMO>Buy Apple</INVTRAN>
              <SECID><UNIQUEID>AAPL</SECID>
              <UNITS>2
              <UNITPRICE>200
              <TOTAL>-400
            </INVBUY>
          </BUYSTOCK>
          <INCOME>
            <INVTRAN><FITID>DIV1<DTTRADE>20251220<MEMO>Apple Dividend</INVTRAN>
            <SECID><UNIQUEID>AAPL</SECID>
            <INCOMETYPE>DIV
            <TOTAL>3.5
          </INCOME>
        </INVTRANLIST>
        <INVPOSLIST>
          <POSSTOCK>
            <INVPOS>
              <SECID><UNIQUEID>AAPL</SECID>
              <HELDINACCT>CASH
              <POSTYPE>LONG
              <UNITS>2
              <UNITPRICE>210
              <MKTVAL>420
            </INVPOS>
          </POSSTOCK>
        </INVPOSLIST>
      </INVSTMTRS>
    </INVSTMTTRNRS>
  </INVSTMTMSGSRSV1>
</OFX>`;

  const preview = await authed
    .post('/api/import/preview')
    .field('accountId', String(acc.body.id))
    .attach('file', Buffer.from(ofx, 'utf8'), {
      filename: 'brokerage.qfx',
      contentType: 'application/x-ofx',
    });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.usedParser, 'ofx');
  assert.equal(preview.body.investmentActivities.length, 2);
  assert.equal(preview.body.holdings.length, 1);
  assert.equal(preview.body.holdings[0].security.symbol, 'AAPL');

  const commit = await authed
    .post('/api/import/commit')
    .send({ previewToken: preview.body.previewToken });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.insertedInvestmentActivities, 2);
  assert.equal(commit.body.insertedHoldings, 1);

  const portfolio = await authed.get('/api/portfolio');
  assert.equal(portfolio.status, 200);
  assert.equal(portfolio.body.holdings.length >= 1, true);
  const holding = portfolio.body.holdings.find(
    (row: { security?: { symbol?: string } }) => row.security?.symbol === 'AAPL'
  );
  assert.ok(holding, JSON.stringify(portfolio.body.holdings));
  assert.equal(holding.quantity, 2);
  assert.equal(holding.marketValue, 420);

  const refresh = await authed.post('/api/portfolio/prices/refresh').send({});
  assert.equal(refresh.status, 400);
  assert.ok(String(refresh.body.error).includes('ALPHA_VANTAGE_API_KEY'));
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

test('enrichment: rule-matched row has confident auto fields and signals; cold row stays in review', async () => {
  // Get the householdId by calling /api/auth/me (session cookie already set on authed agent).
  const me = await authed.get('/api/auth/me');
  assert.equal(me.status, 200);
  const householdId = me.body.user.household.id as number;

  const acc = await authed.post('/api/accounts').send({
    name: 'Enrichment Smoke Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const ruleRow = await models.Rule.create({
    householdId,
    merchantPattern: 'NETFLIX',
    matchKind: 'substring',
    priority: 5,
    category: 'Subscriptions',
    isBusiness: false,
    splitType: 'shared',
    pctMe: '0.5',
    pctPartner: '0.5',
  });

  const csv =
    'Date,Description,Amount\n' +
    '2026-04-15,NETFLIX.COM,-14.99\n' +
    '2026-04-16,Random Unknown Vendor XYZ,-5.00\n';

  const up = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'enrichment-smoke.csv',
      contentType: 'text/csv',
    });
  assert.equal(up.status, 200);
  assert.equal(up.body.inserted, 2);

  const txns = await models.Transaction.findAll({
    where: { accountId },
    order: [['date', 'ASC']],
  });
  assert.equal(txns.length, 2);

  const netflix = txns.find((t) => t.merchantRaw.includes('NETFLIX'));
  const unknown = txns.find((t) => t.merchantRaw.includes('Random Unknown'));
  assert.ok(netflix, `expected NETFLIX transaction; got ${txns.map((t) => t.merchantRaw).join(', ')}`);
  assert.ok(unknown, `expected Random Unknown transaction; got ${txns.map((t) => t.merchantRaw).join(', ')}`);

  assert.equal(netflix.autoSource, 'rule', `NETFLIX autoSource should be 'rule'`);
  assert.equal(netflix.autoConfidence, 'high', `NETFLIX autoConfidence should be 'high'`);
  assert.equal(netflix.reviewFlag, false, `NETFLIX reviewFlag should be false`);
  assert.equal(netflix.autoCategory, 'Subscriptions', `NETFLIX autoCategory should be 'Subscriptions'`);
  assert.equal(netflix.appliedRuleId, ruleRow.id, `NETFLIX appliedRuleId should match rule`);

  assert.equal(unknown.reviewFlag, true, `unknown vendor reviewFlag should be true`);
  assert.equal(unknown.autoSource, null, `unknown vendor autoSource should be null`);
  assert.equal(unknown.autoCategory, null, `unknown vendor autoCategory should be null`);

  for (const t of [netflix, unknown]) {
    const signals = await models.TransactionSignal.findAll({ where: { transactionId: t.id } });
    assert.ok(
      signals.some((s) => s.source === 'normalize-seed'),
      `transaction ${t.merchantRaw} (id=${t.id}) should have a normalize-seed signal; got sources: ${signals.map((s) => s.source).join(', ')}`
    );
  }
});

test('POST /api/import/upload: parses a CIBC Costco PDF statement end-to-end', { skip: skipNoFixtures }, async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'CIBC Costco MC (pdf integration)',
    owner: 'me',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const pdfPath = path.join(backendRoot, 'test', 'fixtures', 'pdf', 'cibc-costco-2026-01-12.pdf');
  const buf = fs.readFileSync(pdfPath);
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', buf, {
      filename: 'cibc-costco-2026-01-12.pdf',
      contentType: 'application/pdf',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 6, JSON.stringify(res.body));
  assert.equal(res.body.parseErrors?.length ?? 0, 0);
});

test('POST /api/import/upload: rejects an unknown-layout PDF with a clear error', async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'PDF reject account',
    owner: 'me',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  // A minimal valid PDF (one blank page) that no parser will sniff.
  const blankPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF',
    'binary',
  );
  const res = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', blankPdf, {
      filename: 'unknown.pdf',
      contentType: 'application/pdf',
    });
  // The route returns 200 with `skipped: true` + a reason/message when parseStatementFile rejects.
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, true, JSON.stringify({ status: res.status, body: res.body }));
  assert.equal(res.body.reason, 'pdf_parse_error');
  assert.match(String(res.body.message ?? ''), /PDF|parser/i);
});

test('POST /api/import/upload: re-uploading the same CIBC Costco PDF is deduped (no double-insert)', { skip: skipNoFixtures }, async () => {
  const acc = await authed.post('/api/accounts').send({
    name: 'CIBC Costco MC (dedup)',
    owner: 'me',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  const accountId = acc.body.id as number;

  const pdfPath = path.join(backendRoot, 'test', 'fixtures', 'pdf', 'cibc-costco-2025-12-12.pdf');
  const buf = fs.readFileSync(pdfPath);

  // First upload — 5 charges inserted, no duplicates.
  const first = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', buf, { filename: 'cibc-costco-2025-12-12.pdf', contentType: 'application/pdf' });
  assert.equal(first.status, 200);
  assert.equal(first.body.inserted, 5, JSON.stringify(first.body));

  // Second upload of the same bytes — should not insert anything new.
  const second = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .attach('file', buf, { filename: 'cibc-costco-2025-12-12.pdf', contentType: 'application/pdf' });
  assert.equal(second.status, 200);
  // Either the contentHash short-circuit returns { skipped: true, reason: 'duplicate_file' }
  // (or whatever the project's duplicate-content reason is), OR the row-level dedup catches
  // every transaction and reports inserted: 0. Accept either — both achieve "no double-insert".
  const insertedAgain = second.body?.inserted ?? 0;
  const skipped = second.body?.skipped === true;
  assert.ok(
    skipped || insertedAgain === 0,
    `expected the second upload to be skipped or insert 0 rows, got ${JSON.stringify(second.body)}`,
  );
});

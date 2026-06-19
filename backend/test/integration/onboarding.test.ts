/**
 * Integration tests for the first-run onboarding feature (#259):
 *   - POST /api/onboarding/initial-import (import-creates-accounts)
 *   - PATCH /api/preferences/onboarding-dismiss
 *
 * Runs in isolation (`yarn test:integration`) against a real Postgres test DB
 * so DATABASE_URL is set before any Sequelize import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('onboarding');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'onboarding@example.com',
    displayName: 'Onboarding User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

const VALID_CSV =
  'Date,Description,Amount\n2025-06-01,Test Cafe,-5.50\n2025-06-02,Grocery Shop,-12.00\n';

/**
 * Build a CSV with unique merchant/amount rows per test so that
 * cross-account enrichment (transfer/refund matching across the same
 * household) never reclassifies these as non-importable rows.
 */
function uniqueCsv(tag: string): string {
  return (
    'Date,Description,Amount\n' +
    `2025-07-01,${tag} Coffee,-4.25\n` +
    `2025-07-02,${tag} Market,-9.10\n`
  );
}

test('unauthenticated initial-import is rejected', async () => {
  const res = await testRequest(app)
    .post('/api/onboarding/initial-import')
    .attach('file', Buffer.from(VALID_CSV, 'utf8'), {
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 401);
});

test('initial-import with inferable filename creates account + ingests txns (AC #4, #6)', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .attach('file', Buffer.from(VALID_CSV, 'utf8'), {
      // Amex_2025_06.csv → inferAccountMeta returns name "Amex", no type.
      filename: 'Amex_2025_06.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.accountCreated, true);
  assert.equal(res.body.accountName, 'Amex');
  assert.ok(res.body.importedCount >= 2, `importedCount=${res.body.importedCount}`);
  assert.ok(typeof res.body.accountId === 'number');

  // The account actually exists and is non-archived.
  const models = await import('../../src/models/index.js');
  const account = await models.Account.findByPk(res.body.accountId);
  assert.ok(account);
  assert.equal(account!.name, 'Amex');
  assert.equal(account!.accountType, 'checking');
  assert.equal(account!.closedAt, null);
});

test('initial-import uses explicit accountName + accountType when provided (AC #5)', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .field('accountName', 'My Savings')
    .field('accountType', 'savings')
    .attach('file', Buffer.from(uniqueCsv('Savings'), 'utf8'), {
      // Unrecognized filename → inference returns null, so explicit name is required.
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.accountName, 'My Savings');

  const models = await import('../../src/models/index.js');
  const account = await models.Account.findByPk(res.body.accountId);
  assert.equal(account!.accountType, 'savings');
});

test('initial-import maps credit → credit_card column type', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .field('accountName', 'My Visa')
    .field('accountType', 'credit')
    .attach('file', Buffer.from(uniqueCsv('Visa'), 'utf8'), {
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  const models = await import('../../src/models/index.js');
  const account = await models.Account.findByPk(res.body.accountId);
  assert.equal(account!.accountType, 'credit_card');
});

test('initial-import without inferable name and no accountName → MISSING_ACCOUNT_NAME', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .attach('file', Buffer.from(VALID_CSV, 'utf8'), {
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_ACCOUNT_NAME');
});

test('initial-import with unsupported file extension → UNSUPPORTED_FORMAT (AC #7)', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .field('accountName', 'Spreadsheet')
    .attach('file', Buffer.from('a,b,c\n1,2,3\n', 'utf8'), {
      filename: 'data.xlsx',
      contentType: 'application/vnd.ms-excel',
    });
  assert.equal(res.status, 400, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'UNSUPPORTED_FORMAT');
});

test('initial-import of a header-only CSV → NO_TRANSACTIONS (AC #8)', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .field('accountName', 'Empty Account')
    .attach('file', Buffer.from('Date,Description,Amount\n', 'utf8'), {
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'NO_TRANSACTIONS');

  // The empty account must NOT have been left behind.
  const models = await import('../../src/models/index.js');
  const stranded = await models.Account.findOne({ where: { name: 'Empty Account' } });
  assert.equal(stranded, null);
});

test('initial-import rejects an invalid accountType', async () => {
  const res = await authed
    .post('/api/onboarding/initial-import')
    .field('accountName', 'Bad Type')
    .field('accountType', 'crypto')
    .attach('file', Buffer.from(VALID_CSV, 'utf8'), {
      filename: 'statement.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 400);
});

test('PATCH /api/preferences/onboarding-dismiss persists a timestamp (AC #3)', async () => {
  const res = await authed.patch('/api/preferences/onboarding-dismiss').send();
  assert.equal(res.status, 200);
  assert.ok(res.body.dismissedAt, 'dismissedAt missing');
  assert.match(res.body.dismissedAt, /\d{4}-\d{2}-\d{2}T/);

  // It is reflected on the settings read used by the frontend gate.
  const settings = await authed.get('/api/settings/cashflow');
  assert.equal(settings.status, 200);
  assert.ok(settings.body.onboardingDismissedAt, 'onboardingDismissedAt not surfaced');
});

test('onboarding-dismiss is idempotent (second call still 200)', async () => {
  const first = await authed.patch('/api/preferences/onboarding-dismiss').send();
  assert.equal(first.status, 200);
  const second = await authed.patch('/api/preferences/onboarding-dismiss').send();
  assert.equal(second.status, 200);
  assert.ok(second.body.dismissedAt);
});

test('unauthenticated onboarding-dismiss is rejected', async () => {
  const res = await testRequest(app).patch('/api/preferences/onboarding-dismiss').send();
  assert.equal(res.status, 401);
});

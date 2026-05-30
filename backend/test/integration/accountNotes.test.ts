import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let accountId: number;

before(async () => {
  testDb = await setupPgTestDb('account-notes');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'account-notes@example.com',
    displayName: 'Account Notes User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const create = await authed.post('/api/accounts').send({
    name: 'Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
  });
  assert.equal(create.status, 201);
  accountId = create.body.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/accounts accepts notes and persists it', async () => {
  const create = await authed.post('/api/accounts').send({
    name: 'Savings with Notes',
    accountType: 'savings',
    notes: 'Routing # 001',
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.notes, 'Routing # 001');
});

test('PATCH /api/accounts/:id accepts notes and returns updated account', async () => {
  const patch = await authed.patch(`/api/accounts/${accountId}`).send({ notes: 'My **notes**' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.notes, 'My **notes**');
});

test('PATCH notes longer than 4000 chars returns 400 NOTES_TOO_LONG', async () => {
  const patch = await authed
    .patch(`/api/accounts/${accountId}`)
    .send({ notes: 'x'.repeat(4001) });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'NOTES_TOO_LONG');
});

test('GET /api/accounts returns notesPreview (first 100 chars) not full notes', async () => {
  const longNote = 'A'.repeat(200);
  await authed.patch(`/api/accounts/${accountId}`).send({ notes: longNote });
  const list = await authed.get('/api/accounts');
  assert.equal(list.status, 200);
  const acc = list.body.find((a: { id: number }) => a.id === accountId);
  assert.ok(acc, 'account should appear in list');
  assert.equal(acc.notes, undefined, 'full notes must not appear in list');
  assert.equal(acc.notesPreview, 'A'.repeat(100));
});

test('GET /api/accounts/:id returns full notes', async () => {
  const longNote = 'B'.repeat(200);
  await authed.patch(`/api/accounts/${accountId}`).send({ notes: longNote });
  const detail = await authed.get(`/api/accounts/${accountId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.notes, longNote);
});

test('whitespace-only notes treated as null', async () => {
  await authed.patch(`/api/accounts/${accountId}`).send({ notes: '   ' });
  const detail = await authed.get(`/api/accounts/${accountId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.notes, null);
});

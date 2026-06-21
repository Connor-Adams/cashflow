import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('email-history');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'history@example.com',
    displayName: 'History User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const hh = await models.Household.findOne();
  assert.ok(hh, 'household exists after register');
  householdId = hh.id;

  await models.ProcessedEmailMessage.create({
    householdId,
    provider: 'google',
    messageId: 'msg-1',
    status: 'extracted',
    parser: 'apple',
    subject: 'Your receipt',
    fromAddr: 'no_reply@apple.com',
    scannedAt: new Date('2026-05-20T10:00:00Z'),
  } as never);
  await models.ProcessedEmailMessage.create({
    householdId,
    provider: 'google',
    messageId: 'msg-2',
    status: 'no_items',
    subject: 'Newsletter',
    fromAddr: 'news@apple.com',
    scannedAt: new Date('2026-05-21T10:00:00Z'),
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/email/history returns the household scan log, newest first', async () => {
  const res = await authed.get('/api/email/history');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].messageId, 'msg-2');
  assert.equal(res.body[0].status, 'no_items');
  assert.equal(res.body[1].messageId, 'msg-1');
  assert.equal(res.body[1].parser, 'apple');
});

test('rejects unauthenticated requests', async () => {
  const res = await testRequest(app).get('/api/email/history');
  assert.equal(res.status, 401);
});

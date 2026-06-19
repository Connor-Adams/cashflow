/**
 * Integration tests for `backend/src/routes/contacts.ts` — focuses on the
 * #375 `is_partner` flag (AC1). The pre-existing legacy behavior (list,
 * create, rename, delete) is covered by frontend smoke tests + unit code
 * paths; this suite adds confidence around the new flag's POST/PATCH
 * surface and the household-scoped isolation contract.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAContactId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('contacts');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin-contacts@example.com',
    displayName: 'SuperC',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('CA', 'A Original');
  householdAContactId = a.contactId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('CB', 'B Original');
  agentB = testAgent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/contacts surfaces the new isPartner field (default false)', async () => {
  const res = await agentA.get('/api/contacts');
  assert.equal(res.status, 200);
  const rows = res.body as Array<{ id: number; name: string; isPartner: boolean }>;
  // The seeded contact ("A Original") was created BEFORE is_partner existed
  // on contact-creation; default = false.
  const target = rows.find((r) => r.id === householdAContactId);
  assert.ok(target, `expected seeded contact in: ${JSON.stringify(rows)}`);
  assert.equal(target.isPartner, false);
});

test('POST /api/contacts accepts isPartner=true at creation', async () => {
  const res = await agentA.post('/api/contacts').send({
    name: 'Partner 375',
    isPartner: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Partner 375');
  assert.equal(res.body.isPartner, true);
});

test('POST /api/contacts coerces "true"/"false" string isPartner', async () => {
  const res = await agentA.post('/api/contacts').send({
    name: 'String Bool',
    isPartner: 'true',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.isPartner, true);
});

test('POST /api/contacts rejects non-boolean isPartner', async () => {
  const res = await agentA.post('/api/contacts').send({
    name: 'Bad Bool',
    isPartner: 'maybe',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /isPartner must be boolean/);
});

test('PATCH /api/contacts/:id flips isPartner on an existing row', async () => {
  // Create a non-partner contact, then flip the bit to true.
  const create = await agentA.post('/api/contacts').send({ name: 'Flip Me' });
  assert.equal(create.status, 201);
  assert.equal(create.body.isPartner, false);

  const flip = await agentA
    .patch(`/api/contacts/${create.body.id}`)
    .send({ isPartner: true });
  assert.equal(flip.status, 200);
  assert.equal(flip.body.isPartner, true);
});

test('PATCH /api/contacts/:id leaves other fields alone when only isPartner sent', async () => {
  const create = await agentA.post('/api/contacts').send({
    name: 'Preserve',
    notes: 'keep me',
  });
  assert.equal(create.status, 201);
  const flip = await agentA
    .patch(`/api/contacts/${create.body.id}`)
    .send({ isPartner: true });
  assert.equal(flip.status, 200);
  assert.equal(flip.body.name, 'Preserve');
  assert.equal(flip.body.notes, 'keep me');
  assert.equal(flip.body.isPartner, true);
});

test('cross-household isolation: household B cannot read or flip household A contacts', async () => {
  // B should not see A's partner contact.
  const list = await agentB.get('/api/contacts');
  assert.equal(list.status, 200);
  const bRows = list.body as Array<{ name: string }>;
  assert.ok(!bRows.some((r) => r.name === 'Partner 375'));
  // And cannot PATCH it.
  const partnerRows = (await agentA.get('/api/contacts')).body as Array<{
    id: number;
    name: string;
  }>;
  const target = partnerRows.find((r) => r.name === 'Partner 375');
  assert.ok(target);
  const patchAttempt = await agentB
    .patch(`/api/contacts/${target.id}`)
    .send({ isPartner: false });
  assert.equal(patchAttempt.status, 404);
});

/**
 * Integration tests for Task 4 of PR B:
 *   - findOrCreateContactByName deduplication by normalized_name
 *   - resolveCounterpartyContact: person-kind creates/dedupes; payroll-kind returns null
 *
 * Additional import-path tests (Task 5) will extend this file.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let householdAId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('cpimport_autolink');
  app = (await import('../../src/app.js')).default;

  // Bootstrap superadmin — first registered user.
  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'boot-autolink@example.com',
    displayName: 'Boot',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const seedA = await seedHousehold('autolinkA', 'Self A');
  householdAId = seedA.householdId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${seedA.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('resolveCounterpartyContact creates one contact and dedupes casing variants', async () => {
  const models = await import('../../src/models');
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  const id1 = await resolveCounterpartyContact(householdAId, { name: 'JANE DOE', kind: 'person' });
  const id2 = await resolveCounterpartyContact(householdAId, { name: 'Jane Doe', kind: 'person' });
  assert.equal(id1, id2, 'casing variants resolve to the same contact');
  const count = await models.Contact.count({ where: { householdId: householdAId, normalizedName: 'jane doe' } });
  assert.equal(count, 1);
});

test('resolveCounterpartyContact returns null for payroll kind', async () => {
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  assert.equal(await resolveCounterpartyContact(householdAId, { name: 'ACME CORP', kind: 'payroll' }), null);
});

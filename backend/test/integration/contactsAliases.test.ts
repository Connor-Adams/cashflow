// backend/test/integration/contactsAliases.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';
import { seedHousehold } from '../helpers/seedHousehold';

let testDb: PgTestDb;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('contacts-aliases');
  ({ householdId } = await seedHousehold('aliases', 'Seed'));
});
after(async () => { await teardownPgTestDb(testDb); });

test('Contact persists aliases round-trip', async () => {
  const { Contact } = await import('../../src/models');
  const c = await Contact.create({ householdId, name: 'Caelan', aliases: 'iten-mcgrath' });
  const reloaded = await Contact.findByPk(c.id);
  assert.equal(reloaded?.aliases, 'iten-mcgrath');
});

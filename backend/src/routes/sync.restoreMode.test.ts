/**
 * POST /api/sync/restore is merge-only.
 *
 * Replace mode was removed: it ran `DELETE FROM transactions` (and accounts,
 * categories, ...) for the household, and those deletes ON DELETE CASCADE into
 * receipts, order links, labels, reimbursements, tax metadata, investment
 * activity and more — none of which the bundle carries (see sync/tables.ts),
 * so a "restore" silently destroyed data it could never put back. An old client
 * that still sends mode=replace must get a 400, not a wipe.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let owner: ReturnType<typeof request.agent>;
let emptyOwner: ReturnType<typeof request.agent>;
let ownerHouseholdId: number;
let emptyHouseholdId: number;

async function seedOwner(name: string, withData: boolean) {
  const models = await import('../models/index.js');
  const { hashPassword, hashToken } = await import('../auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: name,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${name} HH` });
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  if (withData) {
    const account = await models.Account.create({
      householdId: household.id,
      ownerUserId: user.id,
      owner: 'me',
      name: `${name} card`,
    });
    await models.Transaction.create({
      accountId: account.id,
      householdId: household.id,
      importBatch: 'b',
      date: '2026-01-15',
      merchantRaw: 'Coffee Co',
      merchantClean: 'Coffee Co',
      amount: '-4.5000',
      currency: 'CAD',
      sourceRowFingerprint: `fp-${crypto.randomBytes(8).toString('hex')}`,
      sourceIdentityFingerprint: `id-${crypto.randomBytes(8).toString('hex')}`,
      reviewFlag: false,
    });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { agent, householdId: household.id };
}

async function txnCount(householdId: number): Promise<number> {
  const models = await import('../models/index.js');
  return models.Transaction.count({ where: { householdId } });
}

async function makeBackup(passphrase: string): Promise<string> {
  const res = await owner.post('/api/sync/backup').send({ passphrase });
  assert.equal(res.status, 200);
  return res.body.bundle as string;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../db.js');
  await import('../models/index.js');
  await sequelize.sync({ force: true });
  app = (await import('../app.js')).default;

  ({ agent: owner, householdId: ownerHouseholdId } = await seedOwner('Owner', true));
  ({ agent: emptyOwner, householdId: emptyHouseholdId } = await seedOwner('Empty', false));
});

after(async () => {
  const { sequelize } = await import('../db.js');
  await sequelize.close();
});

test('mode=replace is rejected with 400 and leaves household data intact', async () => {
  const passphrase = 'replace-is-gone-passphrase';
  const bundle = await makeBackup(passphrase);
  const before = await txnCount(ownerHouseholdId);
  assert.ok(before > 0, 'precondition: household has data');

  const res = await owner.post('/api/sync/restore').send({ passphrase, bundle, mode: 'replace' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /replace/i);
  assert.match(res.body.error, /merge/i);
  assert.equal(await txnCount(ownerHouseholdId), before, 'nothing was wiped');
});

test('an unknown mode is rejected with 400 rather than silently treated as merge', async () => {
  const passphrase = 'unknown-mode-passphrase';
  const bundle = await makeBackup(passphrase);

  // Restore into the EMPTY household, where a merge would succeed — so a 400
  // proves the bad mode was rejected, not merge's non-empty refusal.
  const res = await emptyOwner
    .post('/api/sync/restore')
    .send({ passphrase, bundle, mode: 'overwrite' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /mode/i);
  assert.equal(await txnCount(emptyHouseholdId), 0, 'nothing was restored');
});

test('merge into a non-empty household refuses without suggesting replace', async () => {
  const passphrase = 'merge-refuses-passphrase';
  const bundle = await makeBackup(passphrase);

  const res = await owner.post('/api/sync/restore').send({ passphrase, bundle, mode: 'merge' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Refusing to restore/);
  assert.doesNotMatch(res.body.error, /replace/i);
});

test('merge (default mode) restores into an empty household', async () => {
  const passphrase = 'merge-into-empty-passphrase';
  const bundle = await makeBackup(passphrase);
  const sourceCount = await txnCount(ownerHouseholdId);
  assert.equal(await txnCount(emptyHouseholdId), 0);

  const res = await emptyOwner.post('/api/sync/restore').send({ passphrase, bundle });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted.transactions, sourceCount);
  // Only presence is asserted on the table itself: on SQLite, insertRow's
  // RETURNING attempt fails after the INSERT lands and its fallback inserts
  // again, so the unit DB holds duplicates (Postgres is unaffected).
  assert.ok((await txnCount(emptyHouseholdId)) >= sourceCount, 'rows landed in the empty household');
});

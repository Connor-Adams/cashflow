/**
 * requireTokenAuth(scope) + createScopedTokenRouter(scope) on the per-process
 * SQLite test DB. The load-bearing property: a token issued for one scope
 * never authenticates another — enforced twice, by plaintext prefix and by
 * the `scope` column in the lookup.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { sequelize, Household, HouseholdMember, User, UserToken } from '../models';
import { requireTokenAuth } from './tokenAuth';
import { TOKEN_SCOPES, hashScopedToken, issueToken, mintTokenPlaintext, type TokenScope } from './scopedToken';
import { createScopedTokenRouter } from '../routes/scopedTokens';

let app: express.Express;
let userId: number;
let orphanUserId: number;
const plaintexts = {} as Record<TokenScope, string>;

async function mkUser(email: string) {
  return User.create({
    email,
    displayName: email,
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
}

before(async () => {
  await sequelize.sync({ force: true });
  const user = await mkUser('tokens@example.com');
  userId = user.id;
  orphanUserId = (await mkUser('orphan@example.com')).id;
  const household = await Household.create({ name: 'Tokens HH' } as never);
  await HouseholdMember.create({ householdId: household.id, userId, role: 'owner' } as never);

  for (const scope of TOKEN_SCOPES) {
    plaintexts[scope] = (await issueToken(userId, scope, scope)).plaintext;
  }

  app = express();
  app.use(express.json());
  // Fake session for the mint/list/revoke routers.
  app.use((req, _res, next) => {
    req.auth = { user: { id: userId } } as never;
    next();
  });
  for (const scope of TOKEN_SCOPES) {
    app.use(`/${scope}/tokens`, createScopedTokenRouter(scope));
    app.all(`/${scope}`, requireTokenAuth(scope), (req, res) => {
      // Exactly one per-scope context key is populated — the one for this scope.
      const set = TOKEN_SCOPES.filter((s) => req[`${s}Auth`] != null);
      res.json({ scope: set.join(','), userId: req[`${scope}Auth`]?.user.id });
    });
  }
});

const call = (scope: TokenScope, plaintext: string) => {
  const r = request(app);
  const req = scope === 'capture' ? r.post(`/${scope}`) : r.get(`/${scope}`);
  return req.set('Authorization', `Bearer ${plaintext}`);
};

for (const scope of TOKEN_SCOPES) {
  test(`a ${scope} token authenticates the ${scope} surface`, async () => {
    const res = await call(scope, plaintexts[scope]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { scope, userId });
  });

  for (const other of TOKEN_SCOPES) {
    if (other === scope) continue;
    test(`a ${scope} token does NOT authenticate the ${other} surface`, async () => {
      const res = await call(other, plaintexts[scope]);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, `Invalid ${other} token`);
    });
  }
}

test('scope column is enforced even if the prefix matches (forged cross-scope row)', async () => {
  // A row stored under scope=audit whose plaintext carries the reporting prefix.
  const plaintext = mintTokenPlaintext('reporting');
  await UserToken.create({
    userId,
    scope: 'audit',
    tokenHash: hashScopedToken(plaintext),
    label: 'forged',
    lastUsedAt: null,
    revokedAt: null,
  });
  const res = await call('reporting', plaintext);
  assert.equal(res.status, 401);
});

test('read-only scopes answer non-GET with 405; capture accepts POST', async () => {
  const audit = await request(app).post('/audit').set('Authorization', `Bearer ${plaintexts.audit}`);
  assert.equal(audit.status, 405);
  assert.equal(audit.body.error, 'Audit tokens are read-only');
  const reporting = await request(app).delete('/reporting').set('Authorization', `Bearer ${plaintexts.reporting}`);
  assert.equal(reporting.status, 405);
  assert.equal(reporting.body.error, 'Reporting tokens are read-only');
});

test('missing / malformed bearer is 401', async () => {
  assert.equal((await request(app).get('/audit')).status, 401);
  assert.equal((await request(app).get('/audit').set('Authorization', 'Basic abc')).status, 401);
});

test('expired capture token is refused with the re-mint message', async () => {
  const plaintext = mintTokenPlaintext('capture');
  await UserToken.create({
    userId,
    scope: 'capture',
    tokenHash: hashScopedToken(plaintext),
    label: 'old',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() - 1000),
  });
  const res = await call('capture', plaintext);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Capture token has expired — mint a new one');
});

test('token whose owner has no household is 403', async () => {
  const { plaintext } = await issueToken(orphanUserId, 'reporting', 'orphan');
  const res = await call('reporting', plaintext);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Reporting token user has no household');
});

test('successful auth touches last_used_at', async () => {
  const { row, plaintext } = await issueToken(userId, 'audit', 'touch');
  assert.equal(row.lastUsedAt, null);
  assert.equal((await call('audit', plaintext)).status, 200);
  // The touch is fire-and-forget; give it a tick to land.
  await new Promise((r) => setTimeout(r, 50));
  await row.reload();
  assert.ok(row.lastUsedAt instanceof Date);
});

test('mint/list responses keep their pre-fold shapes (expiresAt only for capture)', async () => {
  const audit = await request(app).post('/audit/tokens').send({ label: 'CI agent' });
  assert.equal(audit.status, 201);
  assert.match(audit.body.plaintext, /^cfa_/);
  assert.deepEqual(Object.keys(audit.body).sort(), ['createdAt', 'id', 'label', 'plaintext']);

  const reporting = await request(app).post('/reporting/tokens').send({});
  assert.equal(reporting.status, 201);
  assert.equal(reporting.body.label, 'Reporting');
  assert.deepEqual(Object.keys(reporting.body).sort(), ['createdAt', 'id', 'label', 'plaintext']);

  const capture = await request(app).post('/capture/tokens').send({});
  assert.equal(capture.status, 201);
  assert.equal(capture.body.label, 'Browser');
  assert.deepEqual(Object.keys(capture.body).sort(), ['createdAt', 'expiresAt', 'id', 'label', 'plaintext']);
  assert.ok(new Date(capture.body.expiresAt).getTime() > Date.now());

  const list = await request(app).get('/audit/tokens');
  assert.equal(list.status, 200);
  assert.ok(list.body.length > 0);
  for (const row of list.body) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'label', 'lastUsedAt']);
  }
  const captureList = await request(app).get('/capture/tokens');
  for (const row of captureList.body) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'expiresAt', 'id', 'label', 'lastUsedAt']);
  }
});

test('list and revoke are scope-confined: a capture id cannot be revoked via /audit/tokens', async () => {
  const { row } = await issueToken(userId, 'capture', 'confined');
  const auditIds = (await request(app).get('/audit/tokens')).body.map((r: { id: number }) => r.id);
  assert.ok(!auditIds.includes(row.id));
  assert.equal((await request(app).delete(`/audit/tokens/${row.id}`)).status, 404);
  assert.equal((await request(app).delete(`/capture/tokens/${row.id}`)).status, 204);
  await row.reload();
  assert.ok(row.revokedAt instanceof Date);
  const res = await call('capture', plaintexts.capture);
  assert.equal(res.status, 200, 'revoking one capture token leaves the others live');
});

test('revoked token is refused', async () => {
  const { row, plaintext } = await issueToken(userId, 'reporting', 'to-revoke');
  assert.equal((await request(app).delete(`/reporting/tokens/${row.id}`)).status, 204);
  assert.equal((await call('reporting', plaintext)).status, 401);
});

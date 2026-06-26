/**
 * Colocated route tests for the security fix in issue #852: when a household
 * owner removes a member, that member's existing session and any
 * household-scoped capture / reporting / audit tokens must be revoked so the
 * removed user can no longer authenticate (sessions are keyed by user_id only
 * and resolve a household via the user's first remaining membership, so a stale
 * session would otherwise keep granting access until natural expiry).
 *
 * Boots the full app on the per-process SQLite test DB (no Postgres).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Household,
  HouseholdMember,
  Session,
  User,
  UserCaptureToken,
  UserReportingToken,
  UserAuditToken,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';

process.env.NODE_ENV = 'test';

let app: (typeof import('../app.js'))['default'];
let ownerAgent: ReturnType<typeof request.agent>;
let memberAgent: ReturnType<typeof request.agent>;
let householdId: number;
let memberUserId: number;

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');

  const owner = await User.create({
    email: 'removal-owner@example.com',
    displayName: 'Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);

  const member = await User.create({
    email: 'removal-member@example.com',
    displayName: 'Member',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  memberUserId = member.id;

  const household = await Household.create({ name: 'Removal HH' } as never);
  householdId = household.id;
  await HouseholdMember.create({ householdId, userId: owner.id, role: 'owner' } as never);
  await HouseholdMember.create({ householdId, userId: member.id, role: 'member' } as never);

  const ownerToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: owner.id,
    tokenHash: hashToken(ownerToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const memberToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: member.id,
    tokenHash: hashToken(memberToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  // Live (non-revoked) household-scoped tokens held by the member.
  await UserCaptureToken.create({
    userId: member.id,
    tokenHash: crypto.randomBytes(32).toString('hex'),
    label: 'phone capture',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
  } as never);
  await UserReportingToken.create({
    userId: member.id,
    tokenHash: crypto.randomBytes(32).toString('hex'),
    label: 'reporting',
    lastUsedAt: null,
    revokedAt: null,
  } as never);
  await UserAuditToken.create({
    userId: member.id,
    tokenHash: crypto.randomBytes(32).toString('hex'),
    label: 'audit',
    lastUsedAt: null,
    revokedAt: null,
  } as never);

  const mod = await import('../app.js');
  app = mod.default;

  ownerAgent = request.agent(app);
  ownerAgent.jar.setCookie(`cashflow_session=${ownerToken}; Path=/`);

  memberAgent = request.agent(app);
  memberAgent.jar.setCookie(`cashflow_session=${memberToken}; Path=/`);
});

test('member session authenticates before removal', async () => {
  const res = await memberAgent.get('/api/household/members');
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('owner removes the member (204)', async () => {
  const res = await ownerAgent.delete(`/api/household/members/${memberUserId}`);
  assert.equal(res.status, 204, JSON.stringify(res.body));
});

test('removed member session rows are deleted', async () => {
  const remaining = await Session.count({ where: { userId: memberUserId } });
  assert.equal(remaining, 0);
});

test("removed member's session no longer grants access to the household", async () => {
  const res = await memberAgent.get('/api/household/members');
  assert.equal(res.status, 401, JSON.stringify(res.body));
});

test("removed member's capture/reporting/audit tokens are revoked", async () => {
  const capture = await UserCaptureToken.findOne({ where: { userId: memberUserId } });
  const reporting = await UserReportingToken.findOne({ where: { userId: memberUserId } });
  const audit = await UserAuditToken.findOne({ where: { userId: memberUserId } });
  assert.ok(capture?.revokedAt instanceof Date, 'capture token should be revoked');
  assert.ok(reporting?.revokedAt instanceof Date, 'reporting token should be revoked');
  assert.ok(audit?.revokedAt instanceof Date, 'audit token should be revoked');
});

test("the owner's own session and tokens are untouched", async () => {
  const res = await ownerAgent.get('/api/household/members');
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

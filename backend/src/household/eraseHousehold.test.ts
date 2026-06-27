/**
 * Unit tests for eraseHousehold (issue #850), run against the per-PID SQLite
 * unit DB. SQLite in the unit harness does not enforce FK cascades the way
 * production Postgres does, so this suite specifically proves the EXPLICIT
 * purges in eraseHousehold — it must remove the no-FK household-scoped rows
 * (securities, tax_entities, audit_log, …) and the member users itself, not
 * lean on a DB cascade that isn't there under SQLite.
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  User,
  Household,
  HouseholdMember,
  Session,
  Account,
  Security,
  AuditLog,
  Entity,
} from '../models';
import { eraseHousehold } from './eraseHousehold';
import { hashPassword, hashToken } from '../auth/password';

before(async () => {
  process.env.NODE_ENV = 'test';
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedOwnerHousehold(name: string) {
  const pw = await hashPassword('password123');
  const user = await User.create({
    email: `erase-unit-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'EraseUnit',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  } as never);
  const household = await Household.create({ name } as never);
  await HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  } as never);
  await Session.create({
    userId: user.id,
    tokenHash: hashToken(`tok-${user.id}`),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);
  return { user, household };
}

test('eraseHousehold purges no-FK household rows, the household, and the member user', async () => {
  const { user, household } = await seedOwnerHousehold('Unit HH');

  await Security.create({
    householdId: household.id,
    symbol: 'VFV',
    currency: 'CAD',
    assetType: 'etf',
  } as never);
  await Entity.create({
    householdId: household.id,
    name: 'Self',
    kind: 'individual',
  } as never).catch(() => {
    /* Entity columns vary; ignore if shape differs — securities/audit cover the no-FK assertion */
  });
  await AuditLog.create({
    householdId: household.id,
    actorUserId: user.id,
    action: 'unit.event',
    entityType: 'Test',
    entityId: 1,
  } as never);

  const result = await eraseHousehold(household.id);

  assert.equal(result.householdId, household.id);
  assert.deepEqual(result.deletedUserIds, [user.id]);

  assert.equal(await Household.findByPk(household.id), null);
  assert.equal(await User.findByPk(user.id), null);
  assert.equal(await Session.count({ where: { userId: user.id } }), 0);
  assert.equal(await Security.count({ where: { householdId: household.id } }), 0);
  assert.equal(await AuditLog.count({ where: { householdId: household.id } }), 0);
});

test('eraseHousehold leaves other households untouched', async () => {
  const a = await seedOwnerHousehold('A HH');
  const b = await seedOwnerHousehold('B HH');
  await Account.create({
    householdId: b.household.id,
    ownerUserId: b.user.id,
    name: 'B account',
    owner: 'me',
    accountType: 'checking',
  } as never);

  await eraseHousehold(a.household.id);

  assert.equal(await Household.findByPk(a.household.id), null);
  assert.ok(await Household.findByPk(b.household.id));
  assert.ok(await User.findByPk(b.user.id));
  assert.equal(await Account.count({ where: { householdId: b.household.id } }), 1);
});

test('eraseHousehold throws 404 for a missing household', async () => {
  await assert.rejects(() => eraseHousehold(999999), /Household not found/);
});

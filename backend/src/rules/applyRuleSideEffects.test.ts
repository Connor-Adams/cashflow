import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Household, Label, Notification, Rule, TransactionLabel, User } from '../models';
import { applyRuleSideEffects } from './applyRuleSideEffects';

// applyRuleSideEffects runs inside the import's per-row SAVEPOINT and swallows
// a failed Notification / TransactionLabel insert so a misconfigured action
// never aborts an import. On Postgres a failed statement aborts the whole
// transaction, so the swallowed error left the import transaction poisoned:
// the next row's SAVEPOINT failed with "current transaction is aborted". Each
// best-effort write needs its own savepoint, rolled back on failure.
//
// SQLite does not abort on a failed statement, so these assert the mechanism
// (ROLLBACK TO SAVEPOINT after the failed insert) and that the caller's
// transaction keeps working.

const NOTIF_TABLE = Notification.getTableName() as string;
const LABEL_JOIN_TABLE = TransactionLabel.getTableName() as string;
const hidden = (t: string) => `${t}_hidden`;
let sql: string[] = [];
const originalLogging = sequelize.options.logging;
let householdId: number;
let userId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'Rule actions' } as never);
  householdId = hh.id;
  const user = await User.create({
    email: 'rule-actions@test.local', displayName: 'Rule Actions',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: 'x',
  } as never);
  userId = user.id;
});

beforeEach(() => {
  sql = [];
  sequelize.options.logging = (msg: unknown) => {
    sql.push(String(msg));
  };
});

afterEach(async () => {
  sequelize.options.logging = originalLogging;
  const tables = (await sequelize.getQueryInterface().showAllTables()) as string[];
  for (const t of [NOTIF_TABLE, LABEL_JOIN_TABLE]) {
    if (tables.includes(hidden(t))) await sequelize.getQueryInterface().renameTable(hidden(t), t);
  }
});

function rolledBackAfter(pattern: RegExp): boolean {
  const at = sql.findIndex((s) => pattern.test(s));
  return at >= 0 && sql.some((s, i) => i > at && /ROLLBACK TO SAVEPOINT/.test(s));
}

test('a failed alert insert rolls back to its own savepoint and the caller transaction survives', async () => {
  const rule = await Rule.create({
    householdId, merchantPattern: 'coffee', createdByUserId: userId,
  } as never);
  await sequelize.getQueryInterface().renameTable(NOTIF_TABLE, hidden(NOTIF_TABLE));
  sql = [];

  await sequelize.transaction(async (t) => {
    await applyRuleSideEffects({
      ruleActions: {
        ruleId: rule.id,
        labelIds: [],
        alerts: [{ severity: 'info', title: 'Coffee', body: 'matched' }],
      } as never,
      transactionId: 1,
      householdId,
      transaction: t,
    });
    // The caller keeps using its transaction after the swallowed failure.
    await Rule.findByPk(rule.id, { transaction: t });
  });

  assert.ok(
    rolledBackAfter(/INSERT INTO [`"]?notifications/i),
    `the failed notification insert is rolled back to its savepoint:\n${sql.join('\n')}`,
  );
});

test('a failed label attach rolls back to its own savepoint', async () => {
  const rule = await Rule.create({
    householdId, merchantPattern: 'groceries', createdByUserId: userId,
  } as never);
  const label = await Label.create({ householdId, name: 'food' } as never);
  await sequelize.getQueryInterface().renameTable(LABEL_JOIN_TABLE, hidden(LABEL_JOIN_TABLE));
  sql = [];

  await sequelize.transaction(async (t) => {
    await applyRuleSideEffects({
      ruleActions: { ruleId: rule.id, labelIds: [label.id], alerts: [] } as never,
      transactionId: 1,
      householdId,
      transaction: t,
    });
    await Rule.findByPk(rule.id, { transaction: t });
  });

  assert.ok(
    rolledBackAfter(new RegExp(`FROM [\`"]?${LABEL_JOIN_TABLE}`, 'i')),
    `the failed label attach is rolled back to its savepoint:\n${sql.join('\n')}`,
  );
});

test('a successful alert inside the caller transaction is kept', async () => {
  const rule = await Rule.create({
    householdId, merchantPattern: 'books', createdByUserId: userId,
  } as never);
  await sequelize.transaction(async (t) => {
    await applyRuleSideEffects({
      ruleActions: {
        ruleId: rule.id, labelIds: [], alerts: [{ severity: 'info', title: 'Books', body: 'b' }],
      } as never,
      transactionId: 2,
      householdId,
      transaction: t,
    });
  });
  assert.equal(await Notification.count({ where: { userId, title: 'Books' } }), 1);
});

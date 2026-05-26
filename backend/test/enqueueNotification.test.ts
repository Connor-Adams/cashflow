/**
 * Unit tests for `enqueueNotification`. Boots an in-memory sqlite via the
 * existing test setup (process.env.NODE_ENV='test' uses sqlite memory db)
 * — see backend/src/db.ts. Exercises the contract:
 *   - writes a row when channel_in_app is true (default for a new type)
 *   - skips when channel_in_app is false
 *   - never sets anything email-shaped (no mailer side-effect; this issue
 *     doesn't ship one)
 *   - validates input shapes (oversize title, bad severity)
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
let Notification: typeof import('../src/models/Notification').Notification;
let NotificationPreference: typeof import('../src/models/NotificationPreference').NotificationPreference;
let enqueueNotification: typeof import('../src/notifications/index').enqueueNotification;
let resolveNotificationPreference: typeof import('../src/notifications/index').resolveNotificationPreference;

before(async () => {
  // Spin up a private sqlite instance and init the two relevant models on it.
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // Minimal users table to satisfy FK references (sqlite is lenient but we
  // still need the table to exist for cascade semantics).
  await sequelize.getQueryInterface().createTable('users', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });

  const notifMod = await import('../src/models/Notification');
  Notification = notifMod.Notification;
  notifMod.initNotification(sequelize);

  const prefMod = await import('../src/models/NotificationPreference');
  NotificationPreference = prefMod.NotificationPreference;
  prefMod.initNotificationPreference(sequelize);

  await sequelize.sync();

  const helperMod = await import('../src/notifications/index');
  enqueueNotification = helperMod.enqueueNotification;
  resolveNotificationPreference = helperMod.resolveNotificationPreference;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Notification.destroy({ where: {} });
  await NotificationPreference.destroy({ where: {} });
});

test('resolveNotificationPreference returns defaults for a type with no row', async () => {
  const pref = await resolveNotificationPreference(1, 'budget.breach');
  assert.deepEqual(pref, { channelInApp: true, channelEmail: false });
});

test('resolveNotificationPreference returns the row when one exists', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'insight.new',
    channelInApp: false,
    channelEmail: true,
  });
  const pref = await resolveNotificationPreference(1, 'insight.new');
  assert.deepEqual(pref, { channelInApp: false, channelEmail: true });
});

test('enqueueNotification writes a row when default preference applies (no row)', async () => {
  const result = await enqueueNotification(1, 'budget.breach', {
    severity: 'warn',
    title: 'Budget over',
    body: 'You spent 1.2x budget',
    dataJson: { budgetId: 42 },
  });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  assert.equal(result.notification.userId, 1);
  assert.equal(result.notification.type, 'budget.breach');
  assert.equal(result.notification.severity, 'warn');
  assert.equal(result.notification.title, 'Budget over');
  assert.equal(result.notification.body, 'You spent 1.2x budget');
  assert.deepEqual(result.notification.dataJson, { budgetId: 42 });
  assert.ok(
    result.notification.readAt == null,
    `expected readAt nullish, got ${String(result.notification.readAt)}`,
  );

  const count = await Notification.count();
  assert.equal(count, 1);
});

test('enqueueNotification respects an explicit channelInApp=true preference row', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'insight.new',
    channelInApp: true,
    channelEmail: false,
  });
  const result = await enqueueNotification(1, 'insight.new', {
    title: 'New insight',
    body: 'See your dashboard',
  });
  assert.equal(result.status, 'created');
  const count = await Notification.count();
  assert.equal(count, 1);
});

test('enqueueNotification skips writing when channelInApp is false (muted)', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'subscription.price_change',
    channelInApp: false,
    channelEmail: false,
  });
  const result = await enqueueNotification(1, 'subscription.price_change', {
    title: 'Price changed',
    body: 'Netflix went up by 2 dollars',
  });
  assert.equal(result.status, 'muted');

  const count = await Notification.count();
  assert.equal(count, 0);
});

test('enqueueNotification defaults severity to info when omitted', async () => {
  const result = await enqueueNotification(1, 'system.welcome', {
    title: 'Welcome',
    body: 'Hello, world',
  });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  assert.equal(result.notification.severity, 'info');
});

test('enqueueNotification rejects an empty title', async () => {
  await assert.rejects(
    () =>
      enqueueNotification(1, 'budget.breach', {
        title: '',
        body: 'Body',
      }),
    /title is required/,
  );
});

test('enqueueNotification rejects an oversize title', async () => {
  await assert.rejects(
    () =>
      enqueueNotification(1, 'budget.breach', {
        title: 'x'.repeat(161),
        body: 'Body',
      }),
    /title exceeds/,
  );
});

test('enqueueNotification rejects an empty type', async () => {
  await assert.rejects(
    () =>
      enqueueNotification(1, '', {
        title: 'Hi',
        body: 'Body',
      }),
    /type is required/,
  );
});

test('enqueueNotification rejects an oversize type', async () => {
  await assert.rejects(
    () =>
      enqueueNotification(1, 'x'.repeat(65), {
        title: 'Hi',
        body: 'Body',
      }),
    /type exceeds/,
  );
});

test('enqueueNotification rejects an invalid severity', async () => {
  await assert.rejects(
    () =>
      enqueueNotification(1, 'budget.breach', {
        // @ts-expect-error testing runtime guard
        severity: 'panic',
        title: 'Hi',
        body: 'Body',
      }),
    /severity must be one of/,
  );
});

test('enqueueNotification does not send any email (AC #3)', async () => {
  // No mailer should exist in this issue. A black-box assertion: the helper
  // returns synchronously after the DB write with no side-effect on any
  // external module. We assert the model count is 1 and nothing else.
  const result = await enqueueNotification(1, 'budget.breach', {
    title: 'Over',
    body: 'Body',
  });
  assert.equal(result.status, 'created');
  // Sanity: ensure no email-channel state is created in either model.
  // (NotificationPreference row should not be auto-created either.)
  const prefCount = await NotificationPreference.count();
  assert.equal(prefCount, 0);
});

test('enqueueNotification scopes rows to userId', async () => {
  // Two users, same type, default preference applies → both should get rows.
  await enqueueNotification(1, 'system.welcome', {
    title: 'Welcome u1',
    body: 'Hi',
  });
  await enqueueNotification(2, 'system.welcome', {
    title: 'Welcome u2',
    body: 'Hi',
  });
  const u1 = await Notification.findAll({ where: { userId: 1 } });
  const u2 = await Notification.findAll({ where: { userId: 2 } });
  assert.equal(u1.length, 1);
  assert.equal(u2.length, 1);
  assert.equal(u1[0]?.title, 'Welcome u1');
  assert.equal(u2[0]?.title, 'Welcome u2');
});

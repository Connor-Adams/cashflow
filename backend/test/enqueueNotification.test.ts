/**
 * Unit tests for the folded notification service module
 * (`src/notifications/index.ts`, issues #266, #379). Boots a private
 * in-memory sqlite and inits the two relevant models on it.
 *
 * After the #379 fold this single module owns the whole in-app notification
 * concern: dispatch (`enqueueNotification`), preference read
 * (`listNotificationPreferences`), and preference write
 * (`upsertNotificationPreference`). The per-(user, type) preference lookup is
 * a PRIVATE helper consulted only by the dispatch path — it is no longer
 * exported as a public service of its own (AC #3). We therefore exercise it
 * indirectly, through `enqueueNotification`, rather than importing it.
 *
 * Dispatch contract:
 *   - writes a row when channel_in_app is true (default for a new type)
 *   - skips when channel_in_app is false (muted)
 *   - never sets anything email-shaped (no mailer side-effect)
 *   - validates input shapes (oversize title, bad severity)
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
let Notification: typeof import('../src/models/Notification').Notification;
let NotificationPreference: typeof import('../src/models/NotificationPreference').NotificationPreference;
let enqueueNotification: typeof import('../src/notifications/index').enqueueNotification;
let listNotificationPreferences: typeof import('../src/notifications/index').listNotificationPreferences;
let upsertNotificationPreference: typeof import('../src/notifications/index').upsertNotificationPreference;

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
  listNotificationPreferences = helperMod.listNotificationPreferences;
  upsertNotificationPreference = helperMod.upsertNotificationPreference;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Notification.destroy({ where: {} });
  await NotificationPreference.destroy({ where: {} });
});

// ---- private preference lookup, observed through dispatch ----------------

test('dispatch uses default (deliver in-app) for a type with no preference row', async () => {
  // No row exists → the private lookup must resolve channelInApp=true.
  const result = await enqueueNotification(1, 'budget.breach', {
    title: 'Budget over',
    body: 'body',
  });
  assert.equal(result.status, 'created');
  const count = await Notification.count();
  assert.equal(count, 1);
});

test('dispatch honors an explicit channelInApp=false row (private lookup reads the row)', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'insight.new',
    channelInApp: false,
    channelEmail: true,
  });
  const result = await enqueueNotification(1, 'insight.new', {
    title: 'New insight',
    body: 'body',
  });
  assert.equal(result.status, 'muted');
  const count = await Notification.count();
  assert.equal(count, 0);
});

// ---- enqueueNotification (dispatch) --------------------------------------

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

// ---- listNotificationPreferences (folded prefs read) ---------------------

test('listNotificationPreferences returns explicit rows for the user', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'budget.breach',
    channelInApp: false,
    channelEmail: true,
  });
  const list = await listNotificationPreferences(1);
  const found = list.find((p) => p.type === 'budget.breach');
  assert.ok(found, 'explicit row should be present');
  assert.equal(found?.channelInApp, false);
  assert.equal(found?.channelEmail, true);
});

test('listNotificationPreferences infers defaulted rows from the notifications table', async () => {
  // A notification of a type with no explicit pref row should surface with
  // the defaults applied (channelInApp=true, channelEmail=false).
  await enqueueNotification(1, 'subscription.price_change', {
    title: 'Price change',
    body: 'body',
  });
  const list = await listNotificationPreferences(1);
  const found = list.find((p) => p.type === 'subscription.price_change');
  assert.ok(found, 'inferred row should be present');
  assert.equal(found?.channelInApp, true);
  assert.equal(found?.channelEmail, false);
});

test('listNotificationPreferences always includes well-known types (digest.weekly)', async () => {
  const list = await listNotificationPreferences(1);
  const found = list.find((p) => p.type === 'digest.weekly');
  assert.ok(found, 'digest.weekly well-known type should always appear');
  assert.equal(found?.channelInApp, true);
  assert.equal(found?.channelEmail, false);
});

test('listNotificationPreferences is sorted by type ascending', async () => {
  await NotificationPreference.create({ userId: 1, type: 'zeta.event' });
  await NotificationPreference.create({ userId: 1, type: 'alpha.event' });
  const list = await listNotificationPreferences(1);
  const types = list.map((p) => p.type);
  const sorted = [...types].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(types, sorted, `expected sorted, got ${types.join(',')}`);
});

test('listNotificationPreferences is user-scoped', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'budget.breach',
    channelInApp: false,
  });
  // user 2 has neither an explicit row nor a notification of this type, so it
  // should NOT appear (only well-known + their own data appear).
  const list2 = await listNotificationPreferences(2);
  const found = list2.find((p) => p.type === 'budget.breach');
  assert.equal(found, undefined, 'user 2 must not see user 1 preference rows');
});

// ---- upsertNotificationPreference (folded prefs write) -------------------

test('upsertNotificationPreference creates a row applying the patch', async () => {
  const saved = await upsertNotificationPreference(1, 'budget.breach', {
    channelInApp: false,
    channelEmail: true,
  });
  assert.equal(saved.type, 'budget.breach');
  assert.equal(saved.channelInApp, false);
  assert.equal(saved.channelEmail, true);
  const row = await NotificationPreference.findOne({
    where: { userId: 1, type: 'budget.breach' },
  });
  assert.ok(row, 'row should be persisted');
});

test('upsertNotificationPreference updates an existing row, preserving unset fields', async () => {
  await NotificationPreference.create({
    userId: 1,
    type: 'budget.breach',
    channelInApp: true,
    channelEmail: true,
  });
  const saved = await upsertNotificationPreference(1, 'budget.breach', {
    channelInApp: false,
  });
  assert.equal(saved.channelInApp, false);
  // channelEmail was not in the patch → preserved.
  assert.equal(saved.channelEmail, true);
});

test('upsertNotificationPreference with empty patch leaves defaults / existing values', async () => {
  const saved = await upsertNotificationPreference(1, 'newtype.event', {});
  assert.equal(saved.channelInApp, true);
  assert.equal(saved.channelEmail, false);
});

test('upsertNotificationPreference is user-scoped (does not touch another user)', async () => {
  await upsertNotificationPreference(1, 'budget.breach', { channelInApp: false });
  await upsertNotificationPreference(2, 'budget.breach', { channelInApp: true });
  const u1 = await NotificationPreference.findOne({
    where: { userId: 1, type: 'budget.breach' },
  });
  const u2 = await NotificationPreference.findOne({
    where: { userId: 2, type: 'budget.breach' },
  });
  assert.equal(u1?.channelInApp, false);
  assert.equal(u2?.channelInApp, true);
});

/**
 * Dispatch-channel independence for `enqueueNotification`: in-app and push
 * are separate toggles. Turning in-app OFF must not mute push, and vice
 * versa. Runs on the per-process SQLite unit DB with an injected push sender;
 * VAPID env is set before import so `isPushConfigured()` is true.
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

let models: typeof import('../models');
let enqueueNotification: typeof import('./index').enqueueNotification;
let userId: number;

before(async () => {
  models = await import('../models');
  ({ enqueueNotification } = await import('./index'));
  await models.sequelize.sync({ force: true });
});

beforeEach(async () => {
  await models.PushSubscription.destroy({ where: {} });
  await models.Notification.destroy({ where: {} });
  await models.NotificationPreference.destroy({ where: {} });
  await models.User.destroy({ where: {} });
  const user = await models.User.create({
    email: `dispatch-${Date.now()}@example.com`,
    displayName: 'Dispatch User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  });
  userId = user.id;
  await models.PushSubscription.create({
    userId,
    endpoint: 'https://fcm.googleapis.com/fcm/send/a',
    p256dh: 'p',
    auth: 'a',
    userAgent: null,
  });
});

async function setPref(channelInApp: boolean, channelPush: boolean) {
  await models.NotificationPreference.create({
    userId,
    type: 'budget.breach',
    channelInApp,
    channelEmail: false,
    channelPush,
  });
}

function countingSender() {
  const sent: string[] = [];
  return {
    sent,
    sender: async (target: { endpoint: string }) => {
      sent.push(target.endpoint);
      return 'sent' as const;
    },
  };
}

test('in-app OFF + push ON: push is still delivered, no in-app row', async () => {
  await setPref(false, true);
  const { sent, sender } = countingSender();
  const result = await enqueueNotification(userId, 'budget.breach', { title: 'T', body: 'B' }, sender);
  assert.deepEqual(sent, ['https://fcm.googleapis.com/fcm/send/a']);
  assert.equal(result.status, 'push_only');
  assert.equal(await models.Notification.count({ where: { userId } }), 0);
});

test('in-app OFF + push OFF: muted, nothing delivered', async () => {
  await setPref(false, false);
  const { sent, sender } = countingSender();
  const result = await enqueueNotification(userId, 'budget.breach', { title: 'T', body: 'B' }, sender);
  assert.equal(result.status, 'muted');
  assert.equal(sent.length, 0);
  assert.equal(await models.Notification.count({ where: { userId } }), 0);
});

test('in-app ON + push ON: both delivered', async () => {
  await setPref(true, true);
  const { sent, sender } = countingSender();
  const result = await enqueueNotification(userId, 'budget.breach', { title: 'T', body: 'B' }, sender);
  assert.equal(result.status, 'created');
  assert.equal(sent.length, 1);
  assert.equal(await models.Notification.count({ where: { userId } }), 1);
});

test('in-app ON + push OFF: in-app only', async () => {
  await setPref(true, false);
  const { sent, sender } = countingSender();
  const result = await enqueueNotification(userId, 'budget.breach', { title: 'T', body: 'B' }, sender);
  assert.equal(result.status, 'created');
  assert.equal(sent.length, 0);
});

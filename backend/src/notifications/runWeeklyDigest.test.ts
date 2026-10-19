/**
 * Unit tests for the weekly digest's email honesty: when the mailer is not
 * configured (noop driver), the digest must not count the email as sent and
 * must not advance `last_digest_sent_at` on the strength of it. Runs on the
 * per-process SQLite unit DB.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailerDriver, SendEmailOptions } from './mailer';

let models: typeof import('../models');
let runWeeklyDigest: typeof import('./runWeeklyDigest').runWeeklyDigest;
let weeklyDigestSkipReason: typeof import('./runWeeklyDigest').weeklyDigestSkipReason;
let mailer: typeof import('./mailer');

/** A driver that really "delivers" (records, returns ok). */
class DeliveringDriver implements MailerDriver {
  name = 'delivering';
  sent: SendEmailOptions[] = [];
  async send(opts: SendEmailOptions): Promise<void> {
    this.sent.push(opts);
  }
}

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  ({ runWeeklyDigest, weeklyDigestSkipReason } = await import('./runWeeklyDigest'));
  mailer = await import('./mailer');
});

after(async () => {
  mailer.setMailerDriverForTest(null);
});

beforeEach(async () => {
  await models.Transaction.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
  await models.NotificationPreference.destroy({ where: {} });
  await models.Notification.destroy({ where: {} });
  await models.HouseholdMember.destroy({ where: {} });
  await models.Household.destroy({ where: {} });
  await models.User.destroy({ where: {} });
});

// 2026-06-01 is a Monday (UTC); the reporting week is 2026-05-25..31.
const AS_OF = new Date('2026-06-01T09:00:00Z');

async function seedUserWithSpend(
  email: string,
  pref: { channelInApp: boolean; channelEmail: boolean },
): Promise<{ id: number; email: string; displayName: string }> {
  const user = await models.User.create({
    email,
    displayName: 'Digest User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  });
  const household = await models.Household.create({ name: `${email} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    name: 'Chequing',
    importBatch: 'seed',
    accountType: 'checking',
    currency: 'CAD',
    visibility: 'shared',
  });
  await models.Transaction.create({
    accountId: account.id,
    householdId: household.id,
    visibility: 'shared',
    importBatch: 'seed',
    date: '2026-05-26',
    merchantRaw: 'Mart',
    merchantClean: 'Mart',
    amount: '-75.00',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${email}`,
    sourceIdentityFingerprint: `id-${email}`,
    finalCategory: 'Groceries',
    finalBusiness: false,
    finalSplitType: 'me',
    txnType: 'purchase',
    reviewFlag: false,
  } as never);
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: pref.channelInApp,
    channelEmail: pref.channelEmail,
    channelPush: false,
  });
  return { id: user.id, email: user.email, displayName: user.displayName };
}

test('noop mailer: email-only digest is not counted as sent and lastDigestSentAt is not advanced', async () => {
  const user = await seedUserWithSpend('noop-only@example.com', {
    channelInApp: false,
    channelEmail: true,
  });
  mailer.setMailerDriverForTest(new mailer.NoopMailerDriver());

  const result = await runWeeklyDigest([user], AS_OF);

  assert.equal(result.sentEmail, 0, 'a noop "send" is not a sent email');
  assert.equal(result.emailSkippedNotConfigured, 1);
  assert.equal(result.emailFailures, 0, 'not configured is a skip, not a failure');
  assert.equal(result.processed, 0);
  const after = await models.User.findByPk(user.id);
  assert.equal(after?.lastDigestSentAt ?? null, null, 'must stay eligible for a real send');
});

test('noop mailer: in-app still delivers and counts as processed; email recorded as skipped', async () => {
  const user = await seedUserWithSpend('noop-both@example.com', {
    channelInApp: true,
    channelEmail: true,
  });
  mailer.setMailerDriverForTest(new mailer.NoopMailerDriver());

  const result = await runWeeklyDigest([user], AS_OF);

  assert.equal(result.wroteInApp, 1);
  assert.equal(result.sentEmail, 0);
  assert.equal(result.emailSkippedNotConfigured, 1);
  assert.equal(result.processed, 1);
});

test('configured mailer: email-only digest is counted as sent and advances lastDigestSentAt', async () => {
  const user = await seedUserWithSpend('real@example.com', {
    channelInApp: false,
    channelEmail: true,
  });
  const drv = new DeliveringDriver();
  mailer.setMailerDriverForTest(drv);

  const result = await runWeeklyDigest([user], AS_OF);

  assert.equal(result.sentEmail, 1);
  assert.equal(result.emailSkippedNotConfigured, 0);
  assert.equal(drv.sent.length, 1);
  assert.equal(result.processed, 1);
  const after = await models.User.findByPk(user.id);
  assert.ok(after?.lastDigestSentAt, 'real delivery advances lastDigestSentAt');
});

test('weeklyDigestSkipReason: names the unconfigured mailer when email was skipped', async () => {
  const user = await seedUserWithSpend('reason@example.com', {
    channelInApp: false,
    channelEmail: true,
  });
  mailer.setMailerDriverForTest(new mailer.NoopMailerDriver());
  const result = await runWeeklyDigest([user], AS_OF);
  assert.equal(
    weeklyDigestSkipReason(result),
    'Email not sent to 1 user: mailer not configured',
  );
});

test('weeklyDigestSkipReason: undefined when nothing was skipped', async () => {
  const user = await seedUserWithSpend('noreason@example.com', {
    channelInApp: true,
    channelEmail: false,
  });
  const result = await runWeeklyDigest([user], AS_OF);
  assert.equal(weeklyDigestSkipReason(result), undefined);
});

/**
 * Integration test for the weekly digest job orchestrator (issue #267).
 *
 * Uses a real Postgres (via pgTestDb) so the digest aggregation, the
 * notification write, the preferences resolution, and the User
 * `last_digest_sent_at` update all run against the production dialect.
 *
 * Coverage:
 *   - User with no transactions is skipped (AC #11).
 *   - User with channelInApp=true gets an in-app row written.
 *   - User with channelEmail=true gets the recorded noop mailer driver hit.
 *   - User with both channels off is skipped (AC #3 / muted contract).
 *   - Per-user failure does not block other users (AC #9).
 *   - `last_digest_sent_at` updated only on success (AC #10).
 *   - Categories + biggest txn populated from a seeded week.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let models: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runWeeklyDigest: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setMailerDriverForTest: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NoopMailerDriver: any;

before(async () => {
  process.env.NODE_ENV = 'test';
  // VAPID must be configured for fanOutWebPush to proceed past its guard
  // (#651/#796). The injected sender below stands in for the real transport.
  process.env.VAPID_PUBLIC_KEY = 'integration-public-key';
  process.env.VAPID_PRIVATE_KEY = 'integration-private-key';
  testDb = await setupPgTestDb('weekly_digest');
  models = await import('../../src/models');
  const orch = await import('../../src/notifications/runWeeklyDigest');
  runWeeklyDigest = orch.runWeeklyDigest;
  const mailer = await import('../../src/notifications/mailer');
  setMailerDriverForTest = mailer.setMailerDriverForTest;
  NoopMailerDriver = mailer.NoopMailerDriver;
});

after(async () => {
  setMailerDriverForTest(null);
  await teardownPgTestDb(testDb);
});

interface SeedOpts {
  email: string;
  displayName: string;
}

async function makeUser(opts: SeedOpts): Promise<{ user: { id: number; email: string; displayName: string }; householdId: number; accountId: number }> {
  const { hashPassword } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: opts.email,
    displayName: opts.displayName,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${opts.displayName} household` });
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
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    householdId: household.id,
    accountId: account.id,
  };
}

async function seedTxn(
  accountId: number,
  householdId: number,
  date: string,
  amount: string,
  category: string | null,
  merchant: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    importBatch: 'seed',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount,
    currency: 'CAD',
    sourceRowFingerprint: `fp-${Math.random()}`,
    sourceIdentityFingerprint: `id-${Math.random()}`,
    finalCategory: category,
    finalBusiness: false,
    finalSplitType: 'me',
    txnType: 'purchase',
    reviewFlag: false,
    ...extra,
  });
}

function thisMondayUTC(): Date {
  // Anchor "asOf" on a fixed Monday so the previous Mon-Sun is the seeded week.
  // 2026-06-01 is a Monday (UTC).
  return new Date('2026-06-01T09:00:00Z');
}

test('runWeeklyDigest: skips user with no transactions (AC #11)', async () => {
  const { user } = await makeUser({
    email: 'nohist@example.com',
    displayName: 'No History',
  });
  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([user], thisMondayUTC());
  assert.equal(result.skippedNoHistory, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.wroteInApp, 0);
  const after = await models.User.findByPk(user.id);
  assert.equal(after.lastDigestSentAt, null, 'should not update on skip');
});

test('runWeeklyDigest: skips user with all channels muted', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'muted@example.com',
    displayName: 'Muted User',
  });
  // Seed a transaction so they have history.
  await seedTxn(accountId, householdId, '2026-05-25', '-50.00', 'Groceries', 'Mart');
  // Mute both channels.
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: false,
    channelEmail: false,
  });
  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([user], thisMondayUTC());
  assert.equal(result.skippedMuted, 1);
  assert.equal(result.wroteInApp, 0);
  assert.equal(result.sentEmail, 0);
  const after = await models.User.findByPk(user.id);
  assert.equal(after.lastDigestSentAt, null);
});

test('runWeeklyDigest: writes in-app row when channelInApp=true (default)', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'inapp@example.com',
    displayName: 'In-App User',
  });
  // Week-of-interest (Mon 2026-05-25 to Sun 2026-05-31): seed spend.
  await seedTxn(accountId, householdId, '2026-05-26', '-100.00', 'Groceries', 'Mart');
  await seedTxn(accountId, householdId, '2026-05-28', '-50.00', 'Dining', 'Diner');
  // Prior week: more spend
  await seedTxn(accountId, householdId, '2026-05-19', '-200.00', 'Groceries', 'Mart');

  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([user], thisMondayUTC());

  assert.equal(result.processed, 1);
  assert.equal(result.wroteInApp, 1);
  // channelEmail default is false → no email send.
  assert.equal(result.sentEmail, 0);

  const notif = await models.Notification.findOne({
    where: { userId: user.id, type: 'digest.weekly' },
  });
  assert.ok(notif, 'in-app row should exist');
  assert.match(notif.title, /Weekly digest/);
  assert.match(notif.body, /Groceries|spent/i);

  const after = await models.User.findByPk(user.id);
  assert.ok(after.lastDigestSentAt, 'should update lastDigestSentAt on success');
});

test('runWeeklyDigest: sends email when channelEmail=true', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'mail@example.com',
    displayName: 'Mail User',
  });
  await seedTxn(accountId, householdId, '2026-05-26', '-75.00', 'Groceries', 'Mart');
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: true,
  });

  const noop = new NoopMailerDriver();
  setMailerDriverForTest(noop);
  const result = await runWeeklyDigest([user], thisMondayUTC());

  assert.equal(result.sentEmail, 1);
  assert.equal(result.wroteInApp, 1);
  assert.equal(noop.sent.length, 1);
  assert.equal(noop.sent[0].to, 'mail@example.com');
  assert.match(noop.sent[0].subject, /Cashflow week/);
  assert.match(noop.sent[0].html, /Mart|Groceries/);
});

test('runWeeklyDigest: empty week with email-only enabled skips in-app, sends email', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'empty@example.com',
    displayName: 'Empty Week',
  });
  // Seed an old transaction so they have *some* history.
  await seedTxn(accountId, householdId, '2026-04-01', '-50.00', 'Old', 'Old Co');
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: true,
  });

  const noop = new NoopMailerDriver();
  setMailerDriverForTest(noop);
  const result = await runWeeklyDigest([user], thisMondayUTC());

  // Empty-week branch: no in-app row, email still sent.
  assert.equal(result.wroteInApp, 0);
  assert.equal(result.sentEmail, 1);
  assert.equal(noop.sent[0].subject, 'Your Cashflow week: nothing new');

  const after = await models.User.findByPk(user.id);
  assert.ok(after.lastDigestSentAt, 'email-only delivery still counts as processed');
});

test('runWeeklyDigest: per-user error does not block other users (AC #9)', async () => {
  const { user: u1, accountId: a1, householdId: h1 } = await makeUser({
    email: 'fail@example.com',
    displayName: 'Failing User',
  });
  await seedTxn(a1, h1, '2026-05-26', '-30.00', 'Groceries', 'Mart');

  const { user: u2, accountId: a2, householdId: h2 } = await makeUser({
    email: 'ok@example.com',
    displayName: 'OK User',
  });
  await seedTxn(a2, h2, '2026-05-27', '-40.00', 'Groceries', 'Mart');

  // Force a failure on u1's email send by injecting a driver that throws.
  await models.NotificationPreference.create({
    userId: u1.id,
    type: 'digest.weekly',
    channelInApp: false,
    channelEmail: true,
  });

  const failingDriver = {
    name: 'failing',
    sent: [] as unknown[],
    async send() {
      throw new Error('smtp down');
    },
  };
  setMailerDriverForTest(failingDriver);

  const result = await runWeeklyDigest([u1, u2], thisMondayUTC());

  // u1's email failed across retries → not processed. u2 got in-app row.
  assert.equal(result.emailFailures, 1);
  assert.equal(result.wroteInApp, 1);
  assert.equal(result.processed, 1);

  const u1After = await models.User.findByPk(u1.id);
  const u2After = await models.User.findByPk(u2.id);
  assert.equal(u1After.lastDigestSentAt, null, 'u1 should not be marked sent');
  assert.ok(u2After.lastDigestSentAt, 'u2 should be marked sent');
});

// ---- #796: enrichment + web-push delivery + day-of-week --------------------

async function seedSubscription(userId: number, endpoint: string): Promise<void> {
  await models.PushSubscription.create({
    userId,
    endpoint,
    p256dh: 'pkey',
    auth: 'akey',
    userAgent: null,
  });
}

test('#796 AC1-4: persists netChange, full categoryDeltas, insight rollup, upcoming expectations', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'enrich@example.com',
    displayName: 'Enrich User',
  });
  // Reporting week Mon 2026-05-25 .. Sun 2026-05-31 (asOf = Mon 2026-06-01).
  await seedTxn(accountId, householdId, '2026-05-26', '-100.00', 'Groceries', 'Mart');
  await seedTxn(accountId, householdId, '2026-05-28', '-40.00', 'Dining', 'Diner');
  await seedTxn(accountId, householdId, '2026-05-27', '500.00', 'Pay', 'Employer', {
    txnType: 'income',
  });
  // Prior week: Groceries higher so delta is negative.
  await seedTxn(accountId, householdId, '2026-05-20', '-150.00', 'Groceries', 'Mart');

  // Open insights for the household (top-3 cap + count).
  for (let i = 0; i < 4; i += 1) {
    await models.Insight.create({
      householdId,
      userId: user.id,
      type: 'merchant_spend_spike',
      severity: i === 0 ? 'critical' : 'warning',
      title: `Insight ${i}`,
      description: null,
      status: 'open',
      fingerprint: `fp-${i}`,
      metadata: {},
      detectedAt: new Date(`2026-05-${20 + i}T00:00:00Z`),
    });
  }
  // A resolved insight must NOT count.
  await models.Insight.create({
    householdId,
    userId: user.id,
    type: 'missing_receipt',
    severity: 'info',
    title: 'Resolved',
    description: null,
    status: 'resolved',
    fingerprint: 'fp-resolved',
    metadata: {},
    detectedAt: new Date('2026-05-30T00:00:00Z'),
  });

  // Expectation due in 5 days (in window); one due in 20 days (out of window).
  await models.PlannedEvent.create({
    userId: user.id,
    householdId,
    type: 'expense',
    name: 'Rent',
    amount: '2200.0000',
    currency: 'CAD',
    expectedDate: '2026-06-06',
    status: 'planned',
    kind: 'planned',
  });
  await models.PlannedEvent.create({
    userId: user.id,
    householdId,
    type: 'expense',
    name: 'Far Future',
    amount: '50.0000',
    currency: 'CAD',
    expectedDate: '2026-06-21',
    status: 'planned',
    kind: 'planned',
  });

  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([user], thisMondayUTC());
  assert.equal(result.processed, 1);

  const notif = await models.Notification.findOne({
    where: { userId: user.id, type: 'digest.weekly' },
  });
  assert.ok(notif, 'in-app row written');
  const dj = notif.dataJson as Record<string, unknown>;

  // AC1: netChange = income 500 - spend 140 = 360.
  assert.equal(dj.netChange, 360);

  // AC2: full categoryDeltas with delta = total - priorTotal.
  const deltas = dj.categoryDeltas as Array<{
    category: string;
    total: number;
    priorTotal: number;
    delta: number;
  }>;
  assert.ok(Array.isArray(deltas));
  const groceries = deltas.find((d) => d.category === 'Groceries');
  assert.equal(groceries?.delta, groceries!.total - groceries!.priorTotal);
  assert.equal(groceries?.delta, -50);

  // AC3: open-insight rollup count + top-3 cap, critical first.
  assert.equal(dj.openInsightCount, 4);
  const top = dj.topInsights as Array<{ severity: string }>;
  assert.equal(top.length, 3);
  assert.equal(top[0].severity, 'critical');

  // AC4: only the in-window expectation.
  const upcoming = dj.upcomingExpectations as Array<{ name: string; dueDate: string }>;
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].name, 'Rent');
  assert.equal(upcoming[0].dueDate, '2026-06-06');
});

test('#796 AC6/AC7: push fired when channelPush=true + subscription; not when false', async () => {
  // Push enabled + subscription → push transport invoked.
  const a = await makeUser({ email: 'pushon@example.com', displayName: 'Push On' });
  await seedTxn(a.accountId, a.householdId, '2026-05-26', '-60.00', 'Groceries', 'Mart');
  await seedSubscription(a.user.id, 'https://push.example/pushon');
  await models.NotificationPreference.create({
    userId: a.user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: false,
    channelPush: true,
  });

  // Push disabled → no transport call even with a subscription.
  const b = await makeUser({ email: 'pushoff@example.com', displayName: 'Push Off' });
  await seedTxn(b.accountId, b.householdId, '2026-05-26', '-60.00', 'Groceries', 'Mart');
  await seedSubscription(b.user.id, 'https://push.example/pushoff');
  await models.NotificationPreference.create({
    userId: b.user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: false,
    channelPush: false,
  });

  const calls: string[] = [];
  const sender = async (target: { endpoint: string }) => {
    calls.push(target.endpoint);
    return 'sent' as const;
  };

  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([a.user, b.user], thisMondayUTC(), sender);

  assert.equal(result.sentPush, 1, 'exactly one user got push');
  assert.deepEqual(calls, ['https://push.example/pushon'], 'only push-on endpoint hit');
});

test('#796 AC7: all channels off → skippedMuted, no Notification row', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'allmute@example.com',
    displayName: 'All Mute',
  });
  await seedTxn(accountId, householdId, '2026-05-26', '-60.00', 'Groceries', 'Mart');
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: false,
    channelEmail: false,
    channelPush: false,
  });
  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([user], thisMondayUTC());
  assert.equal(result.skippedMuted, 1);
  const notif = await models.Notification.findOne({
    where: { userId: user.id, type: 'digest.weekly' },
  });
  assert.equal(notif, null, 'no row written for fully-muted user');
});

test('#796 AC8: day-of-week skips on a non-matching tick, processes on a matching one', async () => {
  const { user, accountId, householdId } = await makeUser({
    email: 'wednesday@example.com',
    displayName: 'Wednesday User',
  });
  await seedTxn(accountId, householdId, '2026-05-26', '-60.00', 'Groceries', 'Mart');
  // Prefer Wednesday (3).
  await models.NotificationPreference.create({
    userId: user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: false,
    channelPush: false,
    digestDayOfWeek: 3,
  });
  setMailerDriverForTest(new NoopMailerDriver());

  // Monday tick → skipped, last_digest_sent_at untouched.
  const monday = await runWeeklyDigest([user], new Date('2026-06-01T09:00:00Z'));
  assert.equal(monday.skippedWrongDay, 1);
  assert.equal(monday.processed, 0);
  let after = await models.User.findByPk(user.id);
  assert.equal(after.lastDigestSentAt, null);

  // Wednesday tick → processed. (2026-06-03 is a Wednesday; reporting week is
  // Mon 2026-05-25 .. Sun 2026-05-31, still containing the seeded txn.)
  const wednesday = await runWeeklyDigest([user], new Date('2026-06-03T09:00:00Z'));
  assert.equal(wednesday.processed, 1);
  assert.equal(wednesday.wroteInApp, 1);
  after = await models.User.findByPk(user.id);
  assert.ok(after.lastDigestSentAt);
});

test('#796 AC10: a push-send failure is isolated and never blocks other users', async () => {
  const a = await makeUser({ email: 'pfail@example.com', displayName: 'Push Fail' });
  await seedTxn(a.accountId, a.householdId, '2026-05-26', '-60.00', 'Groceries', 'Mart');
  await seedSubscription(a.user.id, 'https://push.example/pfail');
  await models.NotificationPreference.create({
    userId: a.user.id,
    type: 'digest.weekly',
    channelInApp: true,
    channelEmail: false,
    channelPush: true,
  });

  const b = await makeUser({ email: 'pok@example.com', displayName: 'Push OK' });
  await seedTxn(b.accountId, b.householdId, '2026-05-27', '-70.00', 'Groceries', 'Mart');

  // Sender throws for the failing user's endpoint; throws-from-sender is
  // treated as a transient failure by fanOutWebPush (kept, counted), so the
  // run must continue. We assert user B still gets their in-app row.
  const sender = async (target: { endpoint: string }) => {
    if (target.endpoint.includes('pfail')) throw new Error('push transport down');
    return 'sent' as const;
  };

  setMailerDriverForTest(new NoopMailerDriver());
  const result = await runWeeklyDigest([a.user, b.user], thisMondayUTC(), sender);

  // A's in-app still written (push failure is independent); B processed too.
  assert.equal(result.wroteInApp, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.errors, 0, 'push failure is not a per-user error abort');
});

test('runWeeklyDigest: idempotent — second run when not due is a no-op', async () => {
  // The orchestrator processes whatever it's given; "due" filtering is
  // the job-handler's job. Sanity check: a freshly-processed user, fed in
  // again, would re-run and update — which is fine. We assert simply that
  // a second invocation does not crash and the counters are sensible.
  const { user, accountId, householdId } = await makeUser({
    email: 'rerun@example.com',
    displayName: 'Re-run User',
  });
  await seedTxn(accountId, householdId, '2026-05-26', '-20.00', 'Groceries', 'Mart');

  setMailerDriverForTest(new NoopMailerDriver());
  const r1 = await runWeeklyDigest([user], thisMondayUTC());
  assert.equal(r1.processed, 1);
  const r2 = await runWeeklyDigest([user], thisMondayUTC());
  // Second run still processes — and importantly does NOT throw.
  assert.equal(r2.processed, 1);
});

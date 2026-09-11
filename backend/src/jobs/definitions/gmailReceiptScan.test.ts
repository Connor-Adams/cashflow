import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';

let models: typeof import('../../models');
let registry: typeof import('../registry');
let gmailReceiptScan: typeof import('./gmailReceiptScan');

before(async () => {
  models = await import('../../models');
  await models.sequelize.sync();
  registry = await import('../registry');
  gmailReceiptScan = await import('./gmailReceiptScan');
});

after(async () => {
  registry.stopAllJobs();
  await models.sequelize.close();
});

let userSeq = 0;

async function makeUser() {
  userSeq += 1;
  return models.User.create({
    email: `gmail-scan-${Date.now()}-${userSeq}@example.com`,
    displayName: `Gmail Scan Test User ${userSeq}`,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    passwordParams: '{}',
  });
}

async function makeHousehold(name: string) {
  return models.Household.create({ name });
}

async function makeMember(householdId: number, userId: number) {
  return models.HouseholdMember.create({ householdId, userId, role: 'owner' });
}

async function makeIntegration(userId: number, overrides: Partial<{ status: string }> = {}) {
  return models.UserEmailIntegration.create({
    userId,
    provider: 'google',
    accessTokenEncrypted: 'fake-token',
    status: overrides.status ?? 'connected',
  });
}

beforeEach(async () => {
  await models.UserEmailIntegration.destroy({ where: {}, truncate: true });
  await models.HouseholdMember.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.User.destroy({ where: {}, truncate: true });
});

test('the job is registered with a valid cron expression', () => {
  const def = registry.getJobDefinition('gmail_receipt_scan');
  assert.ok(def, 'job is registered');
  assert.equal(cron.validate(def!.cronDefault), true);
});

test('the job is enabled by default', () => {
  assert.equal(registry.getJobDefinition('gmail_receipt_scan')?.enabledDefault, true);
});

test('resolves householdId via HouseholdMember and scans per integration', async () => {
  const user = await makeUser();
  const household = await makeHousehold('Scan HH');
  await makeMember(household.id, user.id);
  await makeIntegration(user.id);

  const scanCalls: unknown[] = [];
  const matchCalls: unknown[] = [];

  const result = await gmailReceiptScan.runGmailReceiptScan({
    scanInbox: async (opts) => {
      scanCalls.push(opts);
      return {
        scannedMessages: 3,
        createdOrders: 2,
        duplicateOrders: 0,
        filteredBySubject: 0,
        skippedAlreadySeen: 0,
        failedExtractions: 0,
        byParser: {},
        aiExtractions: 0,
        aiCappedMessages: 0,
        messages: [],
        query: 'q',
        sinceDate: null,
      } as any;
    },
    runAmazonMatching: async (opts) => {
      matchCalls.push(opts);
      return {
        suggested: 0,
        autoAccepted: 1,
        scannedTransactions: 0,
        matchedDateFrom: null,
        matchedDateTo: null,
      };
    },
  });

  assert.equal(scanCalls.length, 1);
  assert.deepEqual(scanCalls[0], { userId: user.id, householdId: household.id, maxMessages: 200 });
  assert.equal(matchCalls.length, 1);
  assert.deepEqual(matchCalls[0], { householdId: household.id });
  assert.equal(result.summary?.created, 2);
  assert.equal(result.summary?.autoAccepted, 1);
  assert.equal(result.summary?.errors, 0);
});

test('runs Amazon matching once per household even with two integrations in it', async () => {
  const userA = await makeUser();
  const userB = await makeUser();
  const household = await makeHousehold('Shared HH');
  await makeMember(household.id, userA.id);
  await makeMember(household.id, userB.id);
  await makeIntegration(userA.id);
  await makeIntegration(userB.id);

  const matchCalls: unknown[] = [];

  await gmailReceiptScan.runGmailReceiptScan({
    scanInbox: async () => ({
      scannedMessages: 0,
      createdOrders: 0,
      duplicateOrders: 0,
      filteredBySubject: 0,
      skippedAlreadySeen: 0,
      failedExtractions: 0,
      byParser: {},
      aiExtractions: 0,
      aiCappedMessages: 0,
      messages: [],
      query: 'q',
      sinceDate: null,
    } as any),
    runAmazonMatching: async (opts) => {
      matchCalls.push(opts);
      return {
        suggested: 0,
        autoAccepted: 0,
        scannedTransactions: 0,
        matchedDateFrom: null,
        matchedDateTo: null,
      };
    },
  });

  assert.equal(matchCalls.length, 1);
  assert.deepEqual(matchCalls[0], { householdId: household.id });
});

test('skips an integration with no household membership without crashing', async () => {
  const user = await makeUser();
  await makeIntegration(user.id);

  let scanCalled = false;
  const result = await gmailReceiptScan.runGmailReceiptScan({
    scanInbox: async () => {
      scanCalled = true;
      throw new Error('should not be called');
    },
    runAmazonMatching: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(scanCalled, false);
  assert.equal(result.summary?.errors, 0);
});

test('a scanning failure in one household does not abort the run for others', async () => {
  const userOk = await makeUser();
  const userBad = await makeUser();
  const householdOk = await makeHousehold('OK HH');
  const householdBad = await makeHousehold('Bad HH');
  await makeMember(householdOk.id, userOk.id);
  await makeMember(householdBad.id, userBad.id);
  await makeIntegration(userOk.id);
  await makeIntegration(userBad.id);

  const matchCalls: number[] = [];

  const result = await gmailReceiptScan.runGmailReceiptScan({
    scanInbox: async (opts) => {
      if (opts.householdId === householdBad.id) {
        throw new Error('gmail blew up');
      }
      return {
        scannedMessages: 1,
        createdOrders: 1,
        duplicateOrders: 0,
        filteredBySubject: 0,
        skippedAlreadySeen: 0,
        failedExtractions: 0,
        byParser: {},
        aiExtractions: 0,
        aiCappedMessages: 0,
        messages: [],
        query: 'q',
        sinceDate: null,
      } as any;
    },
    runAmazonMatching: async (opts) => {
      matchCalls.push(opts.householdId);
      return {
        suggested: 0,
        autoAccepted: 0,
        scannedTransactions: 0,
        matchedDateFrom: null,
        matchedDateTo: null,
      };
    },
  });

  assert.deepEqual(matchCalls, [householdOk.id]);
  assert.equal(result.summary?.errors, 1);
  assert.equal(result.summary?.created, 1);
});

test('a matching failure is absorbed and does not abort the run', async () => {
  const user = await makeUser();
  const household = await makeHousehold('Match Fail HH');
  await makeMember(household.id, user.id);
  await makeIntegration(user.id);

  const result = await gmailReceiptScan.runGmailReceiptScan({
    scanInbox: async () => ({
      scannedMessages: 0,
      createdOrders: 0,
      duplicateOrders: 0,
      filteredBySubject: 0,
      skippedAlreadySeen: 0,
      failedExtractions: 0,
      byParser: {},
      aiExtractions: 0,
      aiCappedMessages: 0,
      messages: [],
      query: 'q',
      sinceDate: null,
    } as any),
    runAmazonMatching: async () => {
      throw new Error('matching blew up');
    },
  });

  assert.equal(result.summary?.errors, 1);
});

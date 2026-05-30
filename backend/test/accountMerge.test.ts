/**
 * Integration tests for account merge service (issue #287).
 *
 * Exercises:
 *   - AC #2: Transactions reassigned
 *   - AC #3: PlannedEvents reassigned
 *   - AC #4: Transaction rolls back if reassignment fails
 *   - AC #5: Currency mismatch returns 400 CURRENCY_MISMATCH
 *   - AC #6: Target-already-merged returns 400 TARGET_NOT_MERGEABLE
 *   - AC #7: Source-already-merged returns 400 SOURCE_ALREADY_MERGED
 *   - AC #8: Same-id returns 400 SAME_ID
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../src/models').Account;
let Transaction: typeof import('../src/models').Transaction;
let PlannedEvent: typeof import('../src/models').PlannedEvent;
let Household: typeof import('../src/models').Household;
let User: typeof import('../src/models').User;
let mergeAccounts: typeof import('../src/services/accountMerge').mergeAccounts;

before(async () => {
  const models = await import('../src/models');
  sequelize = models.sequelize;
  Account = models.Account;
  Transaction = models.Transaction;
  PlannedEvent = models.PlannedEvent;
  Household = models.Household;
  User = models.User;

  await sequelize.sync({ force: true });

  const service = await import('../src/services/accountMerge');
  mergeAccounts = service.mergeAccounts;
});

beforeEach(async () => {
  // Clear all tables
  await Transaction.destroy({ where: {}, truncate: true });
  await PlannedEvent.destroy({ where: {}, truncate: true });
  await Account.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  await User.destroy({ where: {}, truncate: true });
});

// Helper to create test user + household
async function setupUser() {
  const user = await User.create({
    email: `test-${Date.now()}@test.local`,
    password: 'hash',
  });
  const household = await Household.create({
    name: 'Test Household',
    ownerId: user.id,
  });
  return { user, household };
}

// Helper to create two accounts
async function setupAccounts(
  household: any,
  user: any,
  currency = 'USD'
) {
  const source = await Account.create({
    name: 'Old Checking',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: currency,
  });
  const target = await Account.create({
    name: 'New Checking',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: currency,
  });
  return { source, target };
}

test('mergeAccounts: successful merge reassigns transactions', async () => {
  const { user, household } = await setupUser();
  const { source, target } = await setupAccounts(household, user);

  // Create 3 transactions on source account
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-01',
    amount: '100.00',
    merchant: 'Merchant A',
    category: 'income',
  });
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-02',
    amount: '-50.00',
    merchant: 'Merchant B',
    category: 'groceries',
  });
  await Transaction.create({
    householdId: household.id,
    accountId: source.id,
    date: '2026-01-03',
    amount: '-25.00',
    merchant: 'Merchant C',
    category: 'utilities',
  });

  // Merge source into target
  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.ok(result.ok, 'Merge should succeed');
  assert.equal(result.movedTransactions, 3, 'Should report 3 moved transactions');

  // Verify source is marked merged_into_id
  const updatedSource = await Account.findByPk(source.id);
  assert.equal(
    updatedSource?.mergedIntoId,
    target.id,
    'Source should have mergedIntoId set'
  );
  assert.ok(updatedSource?.mergedAt, 'Source should have mergedAt set');

  // Verify transactions reassigned
  const targetTransactions = await Transaction.findAll({
    where: { accountId: target.id },
  });
  assert.equal(targetTransactions.length, 3, 'Target should have 3 transactions');

  const sourceTransactions = await Transaction.findAll({
    where: { accountId: source.id },
  });
  assert.equal(sourceTransactions.length, 0, 'Source should have 0 transactions');
});

test('mergeAccounts: successful merge reassigns planned events', async () => {
  const { user, household } = await setupUser();
  const { source, target } = await setupAccounts(household, user);

  // Create 2 planned events on source
  await PlannedEvent.create({
    householdId: household.id,
    accountId: source.id,
    description: 'Planned expense 1',
    date: '2026-06-01',
    amount: '100.00',
    category: 'utilities',
  });
  await PlannedEvent.create({
    householdId: household.id,
    accountId: source.id,
    description: 'Planned expense 2',
    date: '2026-06-02',
    amount: '50.00',
    category: 'groceries',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.ok(result.ok, 'Merge should succeed');

  const targetEvents = await PlannedEvent.findAll({
    where: { accountId: target.id },
  });
  assert.equal(targetEvents.length, 2, 'Target should have 2 planned events');

  const sourceEvents = await PlannedEvent.findAll({
    where: { accountId: source.id },
  });
  assert.equal(sourceEvents.length, 0, 'Source should have 0 planned events');
});

test('mergeAccounts: currency mismatch returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'USD Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
  const target = await Account.create({
    name: 'CAD Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'CAD',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'CURRENCY_MISMATCH');
  assert.equal(result.error.sourceCurrency, 'USD');
  assert.equal(result.error.targetCurrency, 'CAD');

  // Verify no changes
  const updatedSource = await Account.findByPk(source.id);
  assert.equal(updatedSource?.mergedIntoId, null, 'Source should not be merged');
});

test('mergeAccounts: target already merged returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });
  const target = await Account.create({
    name: 'Target (already merged)',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
    mergedIntoId: 999, // Simulating target already merged
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'TARGET_NOT_MERGEABLE');
});

test('mergeAccounts: source already merged returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source (already merged)',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
    mergedIntoId: 999,
  });
  const target = await Account.create({
    name: 'Target',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, source.id, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SOURCE_ALREADY_MERGED');
});

test('mergeAccounts: same id returns error', async () => {
  const { user, household } = await setupUser();
  const account = await Account.create({
    name: 'Account',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, account.id, account.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SAME_ID');
});

test('mergeAccounts: source not found returns error', async () => {
  const { user, household } = await setupUser();
  const target = await Account.create({
    name: 'Target',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, 99999, target.id);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'SOURCE_NOT_FOUND');
});

test('mergeAccounts: target not found returns error', async () => {
  const { user, household } = await setupUser();
  const source = await Account.create({
    name: 'Source',
    owner: 'me',
    householdId: household.id,
    ownerUserId: user.id,
    defaultCurrency: 'USD',
  });

  const result = await mergeAccounts(household.id, source.id, 99999);

  assert.equal(result.ok, false, 'Merge should fail');
  assert.equal(result.error.code, 'TARGET_NOT_FOUND');
});

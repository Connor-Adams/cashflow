import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Account } from '../models';
import { importCsvFile } from './runImport';
import { findOrCreateAccount, profileIdToBankCode } from './accountLookup';

const testHouseholdId = 999;

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

// profileIdToBankCode tests
test('profileIdToBankCode maps RBC profile to RBC', () => {
  assert.equal(profileIdToBankCode('rbc'), 'RBC');
});

test('profileIdToBankCode maps TD profiles to TD', () => {
  assert.equal(profileIdToBankCode('td_credit_card'), 'TD');
  assert.equal(profileIdToBankCode('td_banking'), 'TD');
});

test('profileIdToBankCode returns Unknown for unrecognized profile', () => {
  assert.equal(profileIdToBankCode('unknown_profile'), 'Unknown');
});

// findOrCreateAccount tests
test('findOrCreateAccount matches existing account with same bank account number', async () => {
  // Create an account with a bank account number
  const existing = await Account.create({
    name: 'RBC Chequing',
    owner: 'me',
    householdId: testHouseholdId,
    visibility: 'private',
    accountType: 'checking',
    bankAccountNumber: '02022-5016985',
  } as never);

  // Try to find/create with the same bank account number
  const result = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);

  assert.equal(result.matchedBy, 'bank_number');
  assert.equal(result.account.id, existing.id);
  assert.equal(result.account.bankAccountNumber, '02022-5016985');
});

test('findOrCreateAccount creates new account if no match found', async () => {
  const result = await findOrCreateAccount('12345-6789', 'rbc', testHouseholdId);

  assert.equal(result.matchedBy, 'created');
  assert(result.account.id && result.account.id > 0, 'account should have id');
  assert(result.account.name.includes('RBC'), 'name should contain RBC');
  assert(result.account.name.includes('6789'), 'name should contain last 4 digits');
  assert.equal(result.account.bankAccountNumber, '12345-6789');
  assert.equal(result.account.householdId, testHouseholdId);
});

test('findOrCreateAccount throws error when account number is empty', async () => {
  try {
    await findOrCreateAccount('', 'rbc', testHouseholdId);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.match((err as Error).message, /Cannot auto-match account/);
  }
});

test('findOrCreateAccount throws error when account number is null', async () => {
  try {
    await findOrCreateAccount(null, 'rbc', testHouseholdId);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.match((err as Error).message, /Cannot auto-match account/);
  }
});

test('findOrCreateAccount creates accounts with different bank codes for same household', async () => {
  const rbc1 = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);
  const td1 = await findOrCreateAccount('12345-678901', 'td_credit_card', testHouseholdId);

  assert.notEqual(rbc1.account.id, td1.account.id);
  assert(rbc1.account.name.includes('RBC'));
  assert(td1.account.name.includes('TD'));
});

test('findOrCreateAccount enforces unique constraint on (householdId, bankAccountNumber)', async () => {
  // Create first account
  await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);

  // Try to create another with same number in same household
  try {
    await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);
    assert.fail('Should have thrown unique constraint error');
  } catch (err) {
    // Expected
  }
});

test('findOrCreateAccount allows same bank account number in different households', async () => {
  const result1 = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);
  const result2 = await findOrCreateAccount('02022-5016985', 'rbc', 888);

  assert.notEqual(result1.account.id, result2.account.id);
  assert.equal(result1.account.householdId, testHouseholdId);
  assert.equal(result2.account.householdId, 888);
});

test('findOrCreateAccount uses last 4 digits for account name', async () => {
  const result = await findOrCreateAccount('9876543210-1234', 'rbc', testHouseholdId);
  assert(result.account.name.includes('1234'));
});

// A real DB failure during auto-match must surface, not masquerade as
// "CSV has no Account Number" (which sends the user chasing a non-problem).
const RBC_CSV_WITH_ACCOUNT_NUMBER =
  'Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$\n' +
  'Chequing,02022-5016985,1/15/2026,,COFFEE SHOP,,-4.50,\n';

test('importCsvFile: a DB error during Account Number auto-match propagates (not reported as "no Account Number")', async () => {
  const findOne = mock.method(Account, 'findOne', async () => {
    throw new Error('connection terminated unexpectedly');
  });
  try {
    await assert.rejects(
      importCsvFile({
        buffer: Buffer.from(RBC_CSV_WITH_ACCOUNT_NUMBER),
        fileName: 'export.csv',
        profileId: 'rbc',
        householdId: testHouseholdId,
      }),
      /connection terminated unexpectedly/,
    );
  } finally {
    findOne.mock.restore();
  }
});

test('importCsvFile: a CSV with an Account Number auto-matches/creates the account', async () => {
  const result = (await importCsvFile({
    buffer: Buffer.from(RBC_CSV_WITH_ACCOUNT_NUMBER),
    fileName: 'export.csv',
    profileId: 'rbc',
    householdId: testHouseholdId,
  })) as Record<string, unknown>;
  assert.notEqual(result.reason, 'unknown_account', JSON.stringify(result));
  const created = await Account.findOne({ where: { householdId: testHouseholdId } });
  assert.ok(created, 'auto-match should have created an account');
});

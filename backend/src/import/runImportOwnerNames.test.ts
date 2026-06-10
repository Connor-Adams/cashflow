/**
 * CSV imports must pass household owner names into enrichment, exactly like
 * the PDF path (commitStatementImport) and the backfill do. Without them the
 * detect-type own-name exclusion can never fire, so a self-named direct
 * deposit ("DIRECT DEPOSIT FROM ADAMS CONNOR") is misclassified as external
 * income and inflates income totals until a nightly backfill rewrites it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Household, HouseholdMember, Transaction, User } from '../models';
import { importCsvFile } from './runImport';

let HH: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedOwnerAndAccount(): Promise<number> {
  const household = await Household.create({ name: 'T' });
  HH = household.id;
  const user = await User.create({
    email: 'owner@example.com',
    displayName: 'Connor Adams',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  } as never);
  await HouseholdMember.create({
    householdId: HH,
    userId: user.id,
    role: 'owner',
  } as never);
  const account = await Account.create({
    name: 'Chequing',
    householdId: HH,
    accountType: 'checking',
  } as never);
  return account.id;
}

test('CSV import classifies a self-named direct deposit as transfer, not income', async () => {
  const accountId = await seedOwnerAndAccount();
  const csv = [
    'Date,Description,Amount',
    '2026-01-15,Direct deposit from ADAMS CONNOR DO,3977.31',
  ].join('\n');

  const result = await importCsvFile({
    buffer: Buffer.from(csv, 'utf8'),
    fileName: 'chequing.csv',
    profileId: 'generic_simple',
    accountId,
    householdId: HH,
  });
  assert.equal(result.inserted, 1, `row should import: ${JSON.stringify(result)}`);

  const txn = await Transaction.findOne({ where: { householdId: HH } });
  assert.ok(txn, 'transaction created');
  assert.equal(
    txn!.txnType,
    'transfer',
    'a deposit under a household member\'s own name is a self transfer, not income',
  );
});

test('CSV import still classifies an external direct deposit as income', async () => {
  const accountId = await seedOwnerAndAccount();
  const csv = [
    'Date,Description,Amount',
    '2026-01-15,Direct deposit from ADAMS GREENE HO,2500.00',
  ].join('\n');

  const result = await importCsvFile({
    buffer: Buffer.from(csv, 'utf8'),
    fileName: 'chequing2.csv',
    profileId: 'generic_simple',
    accountId,
    householdId: HH,
  });
  assert.equal(result.inserted, 1, `row should import: ${JSON.stringify(result)}`);

  const txn = await Transaction.findOne({ where: { householdId: HH } });
  assert.equal(txn!.txnType, 'income');
});

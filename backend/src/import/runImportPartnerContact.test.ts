/**
 * CSV import stamps partner/shared splits with the household's sole partner
 * contact. Without it, a settlement recorded against the partner never nets
 * against imported spend and Reports keeps showing "partner owes you $X".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Contact, Household, Rule, Transaction } from '../models';
import { importCsvFile } from './runImport';
import { resetTestDb } from '../../test/helpers/resetTestDb';

beforeEach(async () => {
  await resetTestDb(sequelize);
});

async function seed(partnerNames: string[]): Promise<{ householdId: number; accountId: number; partnerIds: number[] }> {
  const household = await Household.create({ name: 'T' } as never);
  const account = await Account.create({
    name: 'Card',
    householdId: household.id,
    accountType: 'credit_card',
  } as never);
  const partnerIds: number[] = [];
  for (const name of partnerNames) {
    const c = await Contact.create({ householdId: household.id, name, isPartner: true } as never);
    partnerIds.push(c.id);
  }
  await Contact.create({ householdId: household.id, name: 'A Friend', isPartner: false } as never);
  await Rule.create({
    householdId: household.id,
    merchantPattern: 'joint grocer',
    category: 'Groceries',
    splitType: 'shared',
  } as never);
  return { householdId: household.id, accountId: account.id, partnerIds };
}

async function importRows(householdId: number, accountId: number): Promise<void> {
  const csv = [
    'Date,Description,Amount',
    '2026-01-15,JOINT GROCER,-80.00',
    '2026-01-16,SOLO CAFE,-5.00',
  ].join('\n');
  const result = await importCsvFile({
    buffer: Buffer.from(csv, 'utf8'),
    fileName: `card-${householdId}.csv`,
    profileId: 'generic_simple',
    accountId,
    householdId,
  });
  assert.equal(result.inserted, 2, `rows should import: ${JSON.stringify(result)}`);
}

test('one partner: shared split is stamped with the partner; me row is not', async () => {
  const { householdId, accountId, partnerIds } = await seed(['Sam']);
  await importRows(householdId, accountId);
  const shared = await Transaction.findOne({ where: { householdId, merchantRaw: 'JOINT GROCER' } });
  const solo = await Transaction.findOne({ where: { householdId, merchantRaw: 'SOLO CAFE' } });
  assert.equal(shared!.ownershipType, 'shared');
  assert.equal(shared!.ownershipContactId, partnerIds[0]);
  assert.equal(solo!.ownershipType, 'me');
  assert.equal(solo!.ownershipContactId, null);
});

test('two partners: ambiguous, so the shared split stays unstamped', async () => {
  const { householdId, accountId } = await seed(['Sam', 'Alex']);
  await importRows(householdId, accountId);
  const shared = await Transaction.findOne({ where: { householdId, merchantRaw: 'JOINT GROCER' } });
  assert.equal(shared!.ownershipType, 'shared');
  assert.equal(shared!.ownershipContactId, null);
});

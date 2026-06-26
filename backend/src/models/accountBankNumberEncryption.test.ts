import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sequelize } from '../db';
import { Account, Household } from './';
import {
  decryptSecret,
  __resetKeyCacheForTests,
} from '../util/symmetricEncryption';

// A valid 64-hex (32-byte) key so encryptSecret/decryptSecret work in unit tests.
const TEST_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

before(() => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  __resetKeyCacheForTests();
});

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('bankAccountNumber is never persisted in plaintext', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await Account.create({
    name: 'RBC 1234',
    householdId: hh.id,
    bankAccountNumber: '12345678',
  } as never);

  // Read the raw row straight from the DB — no model getters.
  const [rows] = await sequelize.query(
    'SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE id = :id',
    { replacements: { id: acc.id } },
  );
  const raw = (rows as Array<{ enc: string | null; hash: string | null }>)[0];

  assert.ok(raw.enc, 'encrypted column should be populated');
  assert.notEqual(raw.enc, '12345678', 'must not store plaintext');
  assert.equal(
    decryptSecret(raw.enc as string),
    '12345678',
    'ciphertext must decrypt back to the plaintext',
  );
  assert.equal(raw.hash, sha256Hex('12345678'), 'hash column = sha256(plaintext)');
});

test('bankAccountNumber getter transparently decrypts on reload', async () => {
  const hh = await Household.create({ name: 'H' });
  await Account.create({
    name: 'RBC 1234',
    householdId: hh.id,
    bankAccountNumber: '98765432',
  } as never);

  const reloaded = await Account.findOne({ where: { name: 'RBC 1234' } });
  assert.ok(reloaded);
  assert.equal(reloaded.bankAccountNumber, '98765432');
});

test('null bankAccountNumber leaves both backing columns null', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await Account.create({
    name: 'No number',
    householdId: hh.id,
  } as never);

  const [rows] = await sequelize.query(
    'SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE id = :id',
    { replacements: { id: acc.id } },
  );
  const raw = (rows as Array<{ enc: string | null; hash: string | null }>)[0];
  assert.equal(raw.enc, null);
  assert.equal(raw.hash, null);
  assert.equal(acc.bankAccountNumber, null);
});

test('clearing bankAccountNumber clears both backing columns', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await Account.create({
    name: 'RBC 1234',
    householdId: hh.id,
    bankAccountNumber: '11112222',
  } as never);

  acc.bankAccountNumber = null;
  await acc.save();

  const [rows] = await sequelize.query(
    'SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE id = :id',
    { replacements: { id: acc.id } },
  );
  const raw = (rows as Array<{ enc: string | null; hash: string | null }>)[0];
  assert.equal(raw.enc, null);
  assert.equal(raw.hash, null);
});

test('two accounts with the same bank number in one household are rejected', async () => {
  const hh = await Household.create({ name: 'H' });
  await Account.create({
    name: 'First',
    householdId: hh.id,
    bankAccountNumber: '55556666',
  } as never);

  await assert.rejects(
    Account.create({
      name: 'Dup',
      householdId: hh.id,
      bankAccountNumber: '55556666',
    } as never),
  );
});

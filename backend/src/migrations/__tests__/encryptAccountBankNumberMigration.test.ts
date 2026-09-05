/**
 * Round-trip test for migration 20260626000001-encrypt-account-bank-number (#871).
 *
 * Seeds an `accounts` table with the pre-migration shape (plaintext
 * bank_account_number + the old plaintext unique index), runs up() and asserts:
 *   - the plaintext column is gone
 *   - the encrypted + hash columns exist and are populated for the seeded row
 *   - the ciphertext decrypts back to the original plaintext
 *   - the hash = sha256(plaintext)
 *   - the new hash-based unique index exists, the old one is gone
 * Then runs down() and asserts the plaintext column + original index are restored
 * and the value round-trips.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sequelize } from 'sequelize';
import {
  decryptSecret,
  __resetKeyCacheForTests,
} from '../../util/symmetricEncryption';

const TEST_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  __resetKeyCacheForTests();
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260626000001-encrypt-account-bank-number.js');

  // Seed the pre-migration shape.
  const qi = sequelize.getQueryInterface();
  await qi.createTable('accounts', {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: Sequelize.STRING, allowNull: false },
    household_id: { type: Sequelize.INTEGER, allowNull: true },
    bank_account_number: { type: Sequelize.STRING(64), allowNull: true },
  });
  await qi.addIndex('accounts', ['household_id', 'bank_account_number'], {
    name: 'accounts_household_bank_number_unique',
    unique: true,
    where: { bank_account_number: { [Sequelize.Op.ne]: null } },
  });
  await sequelize.query(
    `INSERT INTO accounts (name, household_id, bank_account_number) VALUES ('RBC 1234', 1, '12345678'), ('No number', 1, NULL)`,
  );
});

after(async () => {
  await sequelize.close();
});

test('up encrypts existing rows and drops the plaintext column', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);

  const desc = await sequelize.getQueryInterface().describeTable('accounts');
  assert.ok(desc.bank_account_number_encrypted, 'encrypted column should exist');
  assert.ok(desc.bank_account_number_hash, 'hash column should exist');
  assert.equal(
    desc.bank_account_number,
    undefined,
    'plaintext column should be dropped',
  );

  const [rows] = await sequelize.query(
    `SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE name = 'RBC 1234'`,
  );
  const row = (rows as Array<{ enc: string | null; hash: string | null }>)[0];
  assert.ok(row.enc, 'seeded row should have ciphertext');
  assert.notEqual(row.enc, '12345678', 'must not be plaintext');
  assert.equal(decryptSecret(row.enc as string), '12345678');
  assert.equal(row.hash, sha256Hex('12345678'));
});

test('up leaves null rows null', async () => {
  const [rows] = await sequelize.query(
    `SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE name = 'No number'`,
  );
  const row = (rows as Array<{ enc: string | null; hash: string | null }>)[0];
  assert.equal(row.enc, null);
  assert.equal(row.hash, null);
});

test('up swaps the unique index to the hash column', async () => {
  const indexes = await sequelize.getQueryInterface().showIndex('accounts');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('accounts_household_bank_number_hash_unique'),
    `expected hash unique index, got: ${names.join(', ')}`,
  );
  assert.ok(
    !names.includes('accounts_household_bank_number_unique'),
    `old plaintext index should be gone, got: ${names.join(', ')}`,
  );
});

test('down restores the plaintext column and value', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);

  const desc = await sequelize.getQueryInterface().describeTable('accounts');
  assert.ok(desc.bank_account_number, 'plaintext column should be restored');
  assert.equal(
    desc.bank_account_number_encrypted,
    undefined,
    'encrypted column should be dropped',
  );
  assert.equal(
    desc.bank_account_number_hash,
    undefined,
    'hash column should be dropped',
  );

  const [rows] = await sequelize.query(
    `SELECT bank_account_number AS num FROM accounts WHERE name = 'RBC 1234'`,
  );
  assert.equal(
    (rows as Array<{ num: string | null }>)[0].num,
    '12345678',
    'plaintext should round-trip back',
  );

  const indexes = await sequelize.getQueryInterface().showIndex('accounts');
  const names = (indexes as Array<{ name: string }>).map((i) => i.name);
  assert.ok(
    names.includes('accounts_household_bank_number_unique'),
    `original plaintext index should be restored, got: ${names.join(', ')}`,
  );
});

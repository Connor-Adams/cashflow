/**
 * Round-trip test for migration 20260626000001-encrypt-account-bank-number (#871).
 *
 * Seeds an `accounts` table with the pre-migration shape (plaintext
 * bank_account_number + the old plaintext unique index), runs up() and asserts:
 *   - the plaintext column is gone
 *   - the encrypted + hash columns exist and are populated for the seeded row
 *   - the ciphertext decrypts back to the original plaintext
 *   - the hash = the keyed blind index of the plaintext (HMAC, not a bare digest)
 *   - the new hash-based unique index exists, the old one is gone
 * Then runs down() and asserts the plaintext column + original index are restored
 * and the value round-trips.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import {
  blindIndex,
  decryptSecret,
  __resetKeyCacheForTests,
} from '../../util/symmetricEncryption';

const TEST_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...args: any[]) => Promise<void>; down: (...args: any[]) => Promise<void> };

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
  // Keyed blind index, not a guessable digest of the plaintext.
  assert.equal(row.hash, blindIndex('12345678'));
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

/**
 * Regression guard for the rebase of PR #1029 (#871).
 *
 * The tests above seed a FOUR-COLUMN `accounts` table with exactly one index, so
 * they could not see the bug that actually broke CI: on SQLite,
 * `queryInterface.removeColumn` is emulated by recreating the table from
 * `describeTable()`, and that rebuild
 *
 *   1. drops EVERY index on the table, and
 *   2. re-reports each composite UNIQUE index as a per-COLUMN `UNIQUE` flag —
 *      so `UNIQUE (household_id, short_code)` came back as
 *      `household_id INTEGER UNIQUE`, i.e. one account per household, ever.
 *
 * Creating a second account in a household then failed with
 * `SQLITE_CONSTRAINT: UNIQUE constraint failed: accounts.household_id`.
 *
 * This fixture mirrors the real post-migration `accounts` shape closely enough to
 * catch that: AUTOINCREMENT pk, a composite unique index, plain indexes, and two
 * accounts sharing a household.
 */
async function seedRealisticAccounts(db: Sequelize): Promise<void> {
  // Real target of the accounts FK — SQLite enforces it (Sequelize turns
  // `PRAGMA foreign_keys` on), so the referenced table has to exist.
  await db.query(
    `CREATE TABLE \`households\` (\`id\` INTEGER PRIMARY KEY AUTOINCREMENT, \`name\` VARCHAR(255) NOT NULL)`,
  );
  await db.query(`INSERT INTO households (id, name) VALUES (1, 'H')`);
  await db.query(
    `CREATE TABLE \`accounts\` (
       \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
       \`name\` VARCHAR(255) NOT NULL,
       \`short_code\` VARCHAR(64),
       \`household_id\` INTEGER REFERENCES \`households\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
       \`account_type\` VARCHAR(32) NOT NULL DEFAULT 'checking',
       \`bank_account_number\` VARCHAR(64)
     )`,
  );
  const qi = db.getQueryInterface();
  await qi.addIndex('accounts', ['household_id', 'short_code'], {
    name: 'idx_accounts_household_shortcode',
    unique: true,
  });
  await qi.addIndex('accounts', ['short_code'], { name: 'accounts_short_code' });
  await qi.addIndex('accounts', ['account_type'], { name: 'accounts_account_type' });
  await qi.addIndex('accounts', ['household_id', 'bank_account_number'], {
    name: 'accounts_household_bank_number_unique',
    unique: true,
    where: { bank_account_number: { [Sequelize.Op.ne]: null } },
  });
  // Two accounts in the SAME household — the shape the rebuild used to forbid.
  await db.query(
    `INSERT INTO accounts (name, short_code, household_id, bank_account_number)
     VALUES ('Chequing', 'CHQ', 1, '12345678'), ('Savings', 'SAV', 1, NULL)`,
  );
}

async function indexNames(db: Sequelize): Promise<string[]> {
  const [rows] = await db.query(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts' AND sql IS NOT NULL`,
  );
  return (rows as Array<{ name: string }>).map((r) => r.name).sort();
}

async function accountsDdl(db: Sequelize): Promise<string> {
  const [rows] = await db.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
  );
  return (rows as Array<{ sql: string }>)[0].sql;
}

test('up preserves the table’s other indexes and does not make household_id unique', async () => {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await seedRealisticAccounts(db);
    await migration.up(db.getQueryInterface(), Sequelize);

    // The bank-number index is swapped for the hash one; everything else survives.
    assert.deepEqual(await indexNames(db), [
      'accounts_account_type',
      'accounts_household_bank_number_hash_unique',
      'accounts_short_code',
      'idx_accounts_household_shortcode',
    ]);

    const ddl = await accountsDdl(db);
    assert.ok(
      !/`household_id`[^,]*UNIQUE/i.test(ddl),
      `household_id must not become column-level UNIQUE. DDL: ${ddl}`,
    );
    assert.ok(
      !/`short_code`[^,]*UNIQUE/i.test(ddl),
      `short_code must not become column-level UNIQUE. DDL: ${ddl}`,
    );
    assert.ok(/AUTOINCREMENT/i.test(ddl), `pk AUTOINCREMENT must survive. DDL: ${ddl}`);
    assert.ok(
      /ON DELETE CASCADE/i.test(ddl),
      `household_id FK actions must survive. DDL: ${ddl}`,
    );

    // The actual production symptom: a THIRD account in household 1.
    await db.query(
      `INSERT INTO accounts (name, short_code, household_id) VALUES ('TFSA', 'TFS', 1)`,
    );
    const [count] = await db.query(
      `SELECT COUNT(*) AS n FROM accounts WHERE household_id = 1`,
    );
    assert.equal(Number((count as Array<{ n: number }>)[0].n), 3);
  } finally {
    await db.close();
  }
});

test('down preserves the table’s other indexes too', async () => {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    await seedRealisticAccounts(db);
    await migration.up(db.getQueryInterface(), Sequelize);
    await migration.down(db.getQueryInterface(), Sequelize);

    assert.deepEqual(await indexNames(db), [
      'accounts_account_type',
      'accounts_household_bank_number_unique',
      'accounts_short_code',
      'idx_accounts_household_shortcode',
    ]);
    const ddl = await accountsDdl(db);
    assert.ok(
      !/`household_id`[^,]*UNIQUE/i.test(ddl),
      `household_id must not become column-level UNIQUE. DDL: ${ddl}`,
    );

    // Plaintext round-tripped back, and the household still holds both accounts.
    const [rows] = await db.query(
      `SELECT name, bank_account_number AS num FROM accounts ORDER BY name`,
    );
    assert.deepEqual(rows, [
      { name: 'Chequing', num: '12345678' },
      { name: 'Savings', num: null },
    ]);
  } finally {
    await db.close();
  }
});

import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sequelize } from '../db';
import { Account, Household } from './';
import { hashBankAccountNumber } from './Account';
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

type RawBankColumns = { enc: string | null; hash: string | null };

/** The two backing columns straight from the DB — no model getters involved. */
async function rawBankColumns(accountId: number): Promise<RawBankColumns> {
  const [rows] = await sequelize.query(
    'SELECT bank_account_number_encrypted AS enc, bank_account_number_hash AS hash FROM accounts WHERE id = :id',
    { replacements: { id: accountId } },
  );
  return (rows as RawBankColumns[])[0];
}

async function makeAccount(
  householdId: number,
  name: string,
  bankAccountNumber?: string | null,
): Promise<Account> {
  return Account.create({
    name,
    householdId,
    ...(bankAccountNumber === undefined ? {} : { bankAccountNumber }),
  } as never);
}

/** One account in each of two households, both holding the same bank number. */
async function makeTwoHouseholdsSharingNumber(value: string): Promise<void> {
  const a = await Household.create({ name: 'A' });
  const b = await Household.create({ name: 'B' });
  await makeAccount(a.id, 'A1', value);
  await makeAccount(b.id, 'B1', value);
}

test('bankAccountNumber is never persisted in plaintext', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await makeAccount(hh.id, 'RBC 1234', '12345678');

  // Read the raw row straight from the DB — no model getters.
  const raw = await rawBankColumns(acc.id);

  assert.ok(raw.enc, 'encrypted column should be populated');
  assert.notEqual(raw.enc, '12345678', 'must not store plaintext');
  assert.equal(
    decryptSecret(raw.enc as string),
    '12345678',
    'ciphertext must decrypt back to the plaintext',
  );
  assert.equal(
    raw.hash,
    hashBankAccountNumber('12345678'),
    'hash column = keyed blind index of the plaintext',
  );
});

test('bankAccountNumber getter transparently decrypts on reload', async () => {
  const hh = await Household.create({ name: 'H' });
  await makeAccount(hh.id, 'RBC 1234', '98765432');

  const reloaded = await Account.findOne({ where: { name: 'RBC 1234' } });
  assert.ok(reloaded);
  assert.equal(reloaded.bankAccountNumber, '98765432');
});

test('null bankAccountNumber leaves both backing columns null', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await makeAccount(hh.id, 'No number');

  const raw = await rawBankColumns(acc.id);
  assert.equal(raw.enc, null);
  assert.equal(raw.hash, null);
  assert.equal(acc.bankAccountNumber, null);
});

test('clearing bankAccountNumber clears both backing columns', async () => {
  const hh = await Household.create({ name: 'H' });
  const acc = await makeAccount(hh.id, 'RBC 1234', '11112222');

  acc.bankAccountNumber = null;
  await acc.save();

  const raw = await rawBankColumns(acc.id);
  assert.equal(raw.enc, null);
  assert.equal(raw.hash, null);
});

test('two accounts with the same bank number in one household are rejected', async () => {
  const hh = await Household.create({ name: 'H' });
  await makeAccount(hh.id, 'First', '55556666');

  await assert.rejects(makeAccount(hh.id, 'Dup', '55556666'));
});

test('many accounts with no bank number coexist in one household', async () => {
  // The partial unique index is on the HASH column and excludes NULL, so a
  // household may hold any number of accounts without a bank number — which is
  // almost every account. Pinned explicitly because the only thing that caught
  // the last regression here was two unrelated portfolio tests.
  const hh = await Household.create({ name: 'H' });
  for (const name of ['A', 'B', 'C', 'D']) {
    await makeAccount(hh.id, name);
  }
  assert.equal(await Account.count({ where: { householdId: hh.id } }), 4);
});

test('empty-string bankAccountNumber is stored as null, not as ciphertext', async () => {
  // Two accounts with '' must not collide — '' has to normalise to NULL rather
  // than encrypting to a concrete hash value.
  const hh = await Household.create({ name: 'H' });
  const first = await makeAccount(hh.id, 'Blank 1', '');
  await makeAccount(hh.id, 'Blank 2', '');

  const raw = await rawBankColumns(first.id);
  assert.equal(raw.enc, null);
  assert.equal(raw.hash, null);
  assert.equal(await Account.count({ where: { householdId: hh.id } }), 2);
});

test('the same bank number in two different households is allowed', async () => {
  await makeTwoHouseholdsSharingNumber('4242');
  assert.equal(await Account.count(), 2);
});

test('ciphertext is randomised — the same number encrypts differently per row', async () => {
  // A deterministic cipher would let anyone with DB access see which accounts
  // share a bank number straight off the ciphertext column.
  await makeTwoHouseholdsSharingNumber('4242');

  const [rows] = await sequelize.query(
    'SELECT bank_account_number_encrypted AS enc FROM accounts ORDER BY id',
  );
  const [first, second] = rows as Array<{ enc: string }>;
  assert.notEqual(first.enc, second.enc, 'IV must be fresh per encrypt');
  assert.equal(decryptSecret(first.enc), '4242');
  assert.equal(decryptSecret(second.enc), '4242');
});

test('the dedup blind index is KEYED, not a bare sha256 of the plaintext', async () => {
  // Bank account numbers are low entropy (a handful of digits). An unkeyed
  // sha256 column is therefore reversible by exhaustive search, which would
  // hand back the plaintext this PR exists to hide. The blind index must be an
  // HMAC under EMAIL_INTEGRATION_ENCRYPTION_KEY: still deterministic (so the
  // dedup unique index and accountLookup's hash query keep working) but useless
  // to someone holding only the database.
  const hh = await Household.create({ name: 'H' });
  const acc = await makeAccount(hh.id, 'RBC', '12345678');

  const stored = (await rawBankColumns(acc.id)).hash as string;

  assert.notEqual(
    stored,
    sha256Hex('12345678'),
    'blind index must not be a guessable unkeyed digest of the plaintext',
  );
  assert.equal(stored, hashBankAccountNumber('12345678'), 'helper must match what is stored');
  assert.match(stored, /^[0-9a-f]{64}$/);

  // Keyed: a different key yields a different blind index for the same input.
  const withTestKey = hashBankAccountNumber('12345678');
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
  __resetKeyCacheForTests();
  try {
    assert.notEqual(
      hashBankAccountNumber('12345678'),
      withTestKey,
      'blind index must depend on the key',
    );
  } finally {
    process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
    __resetKeyCacheForTests();
  }
});

test('an explicit attributes list including bankAccountNumber still decrypts', async () => {
  // simplefin/links.ts and simplefin/service.ts select
  // `attributes: ['id', 'name', 'bankAccountNumber']`. The getter reads the
  // ciphertext column, so the VIRTUAL's declared dependency has to pull
  // bank_account_number_encrypted into the SELECT. If it ever stops doing so the
  // getter silently returns null and SimpleFIN auto-linking quietly matches
  // nothing — no error, just no links.
  const hh = await Household.create({ name: 'H' });
  await makeAccount(hh.id, 'Chequing', '000123456789');

  const [found] = await Account.findAll({
    where: { householdId: hh.id },
    attributes: ['id', 'name', 'bankAccountNumber'],
  });
  assert.equal(found.bankAccountNumber, '000123456789');
});

test('findOrCreateAccount-style lookup by blind index finds the existing row', async () => {
  // accountLookup dedups on the hash column because the plaintext is no longer
  // queryable. Pins that the value the setter stored is the value the exported
  // helper produces, so the import path keeps deduping instead of creating a
  // duplicate account on every statement.
  const hh = await Household.create({ name: 'H' });
  const created = await makeAccount(hh.id, 'RBC Chequing', '02022-5016985');

  const found = await Account.findOne({
    where: {
      householdId: hh.id,
      bankAccountNumberHash: hashBankAccountNumber('02022-5016985'),
    },
  });
  assert.ok(found, 'lookup by blind index should find the account');
  assert.equal(found.id, created.id);
});

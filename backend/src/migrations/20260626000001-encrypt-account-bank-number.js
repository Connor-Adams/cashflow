'use strict';

/**
 * Encrypt accounts.bank_account_number at rest (#871).
 *
 * The column was STRING(64) plaintext — financial-account PII readable by anyone
 * with DB access. This migration moves it to the repo's encrypted-column pattern:
 *
 *   - bank_account_number_encrypted (TEXT)  — AES-256-GCM envelope, base64
 *   - bank_account_number_hash      (CHAR-ish STRING(64)) — sha256(plaintext) hex
 *
 * The hash column carries the dedup UNIQUE(household_id, ...) constraint, because
 * the encrypted column can't be unique (every encrypt uses a fresh random IV).
 *
 * Existing rows are backfill-encrypted here. Encryption is a FROZEN inline copy
 * of util/symmetricEncryption.encryptSecret (envelope: version(1)||iv(12)||
 * tag(16)||cipher, base64) — migrations must not depend on mutable app code, and
 * the envelope format is versioned (0x01) so app-side decrypt reads these rows.
 *
 * Dual-dialect (SQLite + Postgres): column adds via queryInterface, backfill via
 * a row-by-row read/encrypt/write loop (no SQL crypto), index swap via
 * add/removeIndex. down() decrypts back to plaintext and restores the original
 * column + index, so the round-trip is reversible.
 *
 * Requires EMAIL_INTEGRATION_ENCRYPTION_KEY (64-hex / 32 bytes) — same key the
 * app uses. If unset, up() throws before mutating data (fail fast); down()
 * likewise needs it to decrypt.
 */
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');

const VERSION_BYTE = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

function getKey() {
  const raw = process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !KEY_HEX_RE.test(raw.trim())) {
    throw new Error(
      'EMAIL_INTEGRATION_ENCRYPTION_KEY must be a 64-character hex string (32 bytes) ' +
        'to run the bank-account-number encryption migration. Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(raw.trim(), 'hex');
}

function encryptSecret(plaintext, key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, enc]).toString('base64');
}

function decryptSecret(envelopeBase64, key) {
  const envelope = Buffer.from(envelopeBase64, 'base64');
  if (envelope.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('Encrypted envelope too short to be valid');
  }
  if (envelope[0] !== VERSION_BYTE) {
    throw new Error(`Unsupported encryption envelope version: ${envelope[0]}`);
  }
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const cipher = envelope.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const OLD_INDEX = 'accounts_household_bank_number_unique';
const NEW_INDEX = 'accounts_household_bank_number_hash_unique';

module.exports = {
  async up(queryInterface, Sequelize) {
    const key = getKey();
    const sequelize = queryInterface.sequelize;

    // 1. Add the two new columns (nullable).
    await queryInterface.addColumn('accounts', 'bank_account_number_encrypted', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('accounts', 'bank_account_number_hash', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });

    // 2. Backfill-encrypt existing plaintext rows.
    const [rows] = await sequelize.query(
      `SELECT id, bank_account_number FROM accounts WHERE bank_account_number IS NOT NULL`,
    );
    for (const row of rows) {
      const plaintext = String(row.bank_account_number);
      await sequelize.query(
        `UPDATE accounts SET bank_account_number_encrypted = :enc, bank_account_number_hash = :hash WHERE id = :id`,
        {
          replacements: {
            enc: encryptSecret(plaintext, key),
            hash: sha256Hex(plaintext),
            id: row.id,
          },
        },
      );
    }

    // 3. Drop the old plaintext index, THEN the plaintext column. Order matters
    //    on SQLite: removeColumn recreates the table and re-applies whatever
    //    indexes exist; doing the column drop with no bank-number index present
    //    avoids the partial-index WHERE clause being lost during recreation.
    await queryInterface.removeIndex('accounts', OLD_INDEX);
    await queryInterface.removeColumn('accounts', 'bank_account_number');

    // 4. Add the new hash-based unique index (after the table is in final shape).
    await queryInterface.addIndex('accounts', ['household_id', 'bank_account_number_hash'], {
      name: NEW_INDEX,
      unique: true,
      where: { bank_account_number_hash: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface, Sequelize) {
    const key = getKey();
    const sequelize = queryInterface.sequelize;

    // 1. Drop the hash index first (same SQLite recreation concern as up()).
    await queryInterface.removeIndex('accounts', NEW_INDEX);

    // 2. Re-add the plaintext column.
    await queryInterface.addColumn('accounts', 'bank_account_number', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });

    // 3. Decrypt back into plaintext.
    const [rows] = await sequelize.query(
      `SELECT id, bank_account_number_encrypted FROM accounts WHERE bank_account_number_encrypted IS NOT NULL`,
    );
    for (const row of rows) {
      await sequelize.query(
        `UPDATE accounts SET bank_account_number = :plain WHERE id = :id`,
        {
          replacements: {
            plain: decryptSecret(String(row.bank_account_number_encrypted), key),
            id: row.id,
          },
        },
      );
    }

    // 4. Drop the encrypted + hash columns.
    await queryInterface.removeColumn('accounts', 'bank_account_number_hash');
    await queryInterface.removeColumn('accounts', 'bank_account_number_encrypted');

    // 5. Restore the original plaintext unique index (table now in final shape).
    await queryInterface.addIndex('accounts', ['household_id', 'bank_account_number'], {
      name: OLD_INDEX,
      unique: true,
      where: { bank_account_number: { [Sequelize.Op.ne]: null } },
    });
  },
};

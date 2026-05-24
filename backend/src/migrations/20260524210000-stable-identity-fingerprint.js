'use strict';

const crypto = require('crypto');

/**
 * Mirrors stableIdentityFingerprint() in backend/src/import/fingerprint.ts.
 * Field order MUST match the TS function exactly — JSON.stringify is
 * insertion-order dependent and the produced hash depends on it.
 */
function computeIdentityFingerprint(row) {
  const data = {
    accountId: row.account_id,
    date: row.date,
    amount: String(parseFloat(row.amount)),
    currency: String(row.currency || '').toUpperCase(),
    merchantRaw: String(row.merchant_raw || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Adds `source_identity_fingerprint` — a SHA256 over the bank-stable bits
 * of a transaction (accountId, date, amount, currency, merchantRaw). This
 * becomes the primary dedup key in `findExistingForDedup`. Unlike
 * `source_row_fingerprint`, the identity hash deliberately excludes both
 * `merchantClean` (drifts as normalizeMerchant evolves) and
 * `sourceReference` (Amex flips NULL → AT… when pending txns clear) so
 * re-importing the same CSV no longer creates duplicates.
 *
 * Adds a non-unique index on `(account_id, source_identity_fingerprint)`
 * for dedup-lookup speed. The legacy unique index on
 * `(account_id, source_row_fingerprint)` stays as a safety-net.
 *
 * Dialect notes:
 *   - Postgres: column is added NULL, backfilled, then SET NOT NULL via
 *     raw ALTER TABLE — `queryInterface.changeColumn` on Postgres is fine
 *     but the dialect-split keeps the migration shape symmetric with the
 *     SQLite branch.
 *   - SQLite: ALTER COLUMN … SET NOT NULL is not supported and
 *     `queryInterface.changeColumn` rebuilds the table in a way that
 *     drops compound unique indexes and accidentally adds column-level
 *     UNIQUE constraints. We leave the column as NULL at the DB level in
 *     SQLite; Sequelize enforces NOT NULL at the application layer via
 *     the model declaration. Test DBs use SQLite, so this keeps the
 *     existing safety-net unique index on
 *     (account_id, source_row_fingerprint) intact.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const dialect = sequelize.getDialect();

    // 1. Add the column as nullable so the backfill can populate it.
    await queryInterface.addColumn('transactions', 'source_identity_fingerprint', {
      type: Sequelize.STRING(128),
      allowNull: true,
    });

    // 2. Batch-backfill in chunks of 500. Per-batch transactions keep
    //    lock-hold short on Postgres against large `transactions` tables.
    const BATCH = 500;
    let lastId = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [rows] = await sequelize.query(
        `SELECT id, account_id, date, amount, currency, merchant_raw
         FROM transactions
         WHERE id > :lastId
         ORDER BY id ASC
         LIMIT :batch`,
        { replacements: { lastId, batch: BATCH } }
      );
      if (rows.length === 0) break;

      await sequelize.transaction(async (t) => {
        for (const row of rows) {
          const fp = computeIdentityFingerprint(row);
          await sequelize.query(
            'UPDATE transactions SET source_identity_fingerprint = ? WHERE id = ?',
            { replacements: [fp, row.id], transaction: t }
          );
        }
      });

      lastId = rows[rows.length - 1].id;
      if (rows.length < BATCH) break;
    }

    // 3. Lock down the column on Postgres. SQLite skips this — see header.
    if (dialect === 'postgres') {
      await sequelize.query(
        'ALTER TABLE transactions ALTER COLUMN source_identity_fingerprint SET NOT NULL'
      );
    }

    // 4. Non-unique index. Pre-insert dedup queries via
    //    findExistingForDedup hit (account_id, source_identity_fingerprint)
    //    so this dramatically beats a sequential scan on large
    //    transactions tables. NON-unique by design: legitimate
    //    same-day/same-amount/same-merchant repeats (e.g. two Starbucks
    //    runs on the same day) share an identity hash and are
    //    distinguished by `source_reference` at the application layer.
    await queryInterface.addIndex(
      'transactions',
      ['account_id', 'source_identity_fingerprint'],
      { name: 'transactions_account_identity_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transactions',
      'transactions_account_identity_idx'
    );
    await queryInterface.removeColumn('transactions', 'source_identity_fingerprint');
  },
};

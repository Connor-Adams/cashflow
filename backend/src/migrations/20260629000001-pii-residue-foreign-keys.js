'use strict';

/**
 * Adds the missing DB-level FOREIGN KEYs that prevent PII residue on delete
 * (#868). Two PII-bearing tables shipped with ORM associations only and no
 * real DB FK, so Postgres performed no cascade and the bulk-delete paths
 * actually used (e.g. account delete) orphaned their rows forever:
 *
 *   - `transaction_revisions` (20260604000001): field-level before/after
 *     snapshots (merchant, amount, category, notes). The Sequelize
 *     `Transaction.hasMany(TransactionRevision, {onDelete:'CASCADE', hooks:true})`
 *     cascade fires only on instance `.destroy()`, NOT on the bulk
 *     `Transaction.destroy({where:{accountId}})` used by account delete
 *     (routes/accounts.ts) and income unlink (routes/income.ts). Without a DB
 *     FK the revision rows survive with a dangling transaction_id — invisible
 *     to tenant queries but present in a DB dump.
 *   - `account_statements` (20260605000060): per-account opening/closing
 *     balances, source filename, variance notes. account_id / household_id
 *     were bare INTEGER NOT NULL with indexes but no `references` → no
 *     referential integrity, orphaned on account deletion.
 *
 * Fixes:
 *   - transaction_revisions.transaction_id → transactions(id) ON DELETE CASCADE
 *   - account_statements.account_id      → accounts(id)      ON DELETE CASCADE
 *   - account_statements.household_id    → households(id)    ON DELETE CASCADE
 *
 * Backfill (Connor's verification note): an FK fixes residue going FORWARD but
 * does not touch rows already orphaned in existing deployments. We therefore
 * purge pre-existing orphans BEFORE adding each constraint — otherwise the
 * ADD CONSTRAINT would fail validation against a dangling row. The DELETE also
 * satisfies the issue's "no orphaned rows remain" acceptance criterion for
 * already-deployed data.
 *
 * Dialect notes (mirrors 20260618000001-entity-id-foreign-keys):
 *   - Postgres (prod / integration suite): real DELETE + ALTER TABLE ADD
 *     CONSTRAINT via raw SQL. Idempotent — each constraint is dropped first.
 *   - SQLite (unit-test harness): cannot ALTER TABLE ADD CONSTRAINT without a
 *     full table rebuild, which the repo deliberately avoids. On SQLite this
 *     migration is a safe no-op; the referential intent is carried by the
 *     associations in models/index.ts and the real FK is enforced on Postgres
 *     only. The integration suite exercises the DDL below against Postgres.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;

    // 1. Purge already-orphaned rows so ADD CONSTRAINT validates cleanly and
    //    no historic PII residue survives in existing deployments.
    await sequelize.query(
      'DELETE FROM transaction_revisions WHERE transaction_id NOT IN (SELECT id FROM transactions)',
    );
    await sequelize.query(
      'DELETE FROM account_statements WHERE account_id NOT IN (SELECT id FROM accounts)',
    );
    await sequelize.query(
      'DELETE FROM account_statements WHERE household_id NOT IN (SELECT id FROM households)',
    );

    // 2. Add the real FKs. Drop-first keeps the migration idempotent.
    await sequelize.query(
      'ALTER TABLE transaction_revisions ' +
        'DROP CONSTRAINT IF EXISTS transaction_revisions_transaction_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE transaction_revisions ADD CONSTRAINT transaction_revisions_transaction_id_fkey ' +
        'FOREIGN KEY (transaction_id) REFERENCES transactions(id) ' +
        'ON UPDATE CASCADE ON DELETE CASCADE',
    );

    await sequelize.query(
      'ALTER TABLE account_statements ' +
        'DROP CONSTRAINT IF EXISTS account_statements_account_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE account_statements ADD CONSTRAINT account_statements_account_id_fkey ' +
        'FOREIGN KEY (account_id) REFERENCES accounts(id) ' +
        'ON UPDATE CASCADE ON DELETE CASCADE',
    );

    await sequelize.query(
      'ALTER TABLE account_statements ' +
        'DROP CONSTRAINT IF EXISTS account_statements_household_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE account_statements ADD CONSTRAINT account_statements_household_id_fkey ' +
        'FOREIGN KEY (household_id) REFERENCES households(id) ' +
        'ON UPDATE CASCADE ON DELETE CASCADE',
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    if (sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
      'ALTER TABLE account_statements DROP CONSTRAINT IF EXISTS account_statements_household_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE account_statements DROP CONSTRAINT IF EXISTS account_statements_account_id_fkey',
    );
    await sequelize.query(
      'ALTER TABLE transaction_revisions DROP CONSTRAINT IF EXISTS transaction_revisions_transaction_id_fkey',
    );
  },
};

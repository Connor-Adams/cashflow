'use strict';

/**
 * Record whether a transaction is a provisional feed row or an authoritative
 * statement row.
 *
 * Two sources now write cash transactions for the same account. The nightly
 * SimpleFIN sync gives same-day visibility but reports the *authorised* amount:
 * a pending card charge can change value before it settles, and some never
 * settle at all. The statement import is the bank's own closed record of a
 * period. Both are wanted — the feed for accurate daily views, the statement as
 * the final word — but only if the app knows which is which.
 *
 * Without this column they are indistinguishable. `import_batch` encodes the
 * run, not the trust level, and `source_reference` encodes identity, not
 * provenance. `import_history.profile_id` records 'simplefin' per import but is
 * a row removed from the transaction, so a query over transactions cannot tell
 * a pending authorisation from a settled charge.
 *
 * Values:
 *   'provisional'   — a feed row that a statement may later correct or remove
 *   'authoritative' — a statement/CSV/PDF row, or anything predating this column
 *
 * The backfill keys on `import_batch LIKE 'simplefin-%'`, which is the batch
 * shape `simplefin/sync.ts` builds (`simplefin-<integrationId>-<accountId>-<ms>`).
 * Everything else is existing statement-derived data and is authoritative by
 * construction — verified at write time: all 5,408 rows carried an import_batch
 * and none came from a manual-entry path, because no such route exists.
 *
 * NOT NULL with a DEFAULT of 'authoritative' is deliberate. Every current writer
 * goes through commitStatementImport, so a writer that forgets to set the tier
 * gets the conservative value — a row that a later statement will leave alone —
 * rather than one silently eligible for deletion.
 *
 * Spine note: a provenance field on the existing Transaction primitive. Not a
 * new status machine, and not a new table — the same noun with a trust level
 * attached, which is the "new behaviour → add a field" case in CLAUDE.md.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'source_tier', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'authoritative',
    });

    await queryInterface.sequelize.query(
      `UPDATE transactions
          SET source_tier = 'provisional'
        WHERE import_batch LIKE 'simplefin-%'`,
    );

    // Supersession scans provisional rows for one account over a date window.
    await queryInterface.addIndex('transactions', ['account_id', 'source_tier', 'date'], {
      name: 'transactions_account_tier_date',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('transactions', 'transactions_account_tier_date');
    await queryInterface.removeColumn('transactions', 'source_tier');
  },
};

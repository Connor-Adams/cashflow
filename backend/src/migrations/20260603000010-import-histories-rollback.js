'use strict';

/**
 * Import-rollback bookkeeping columns (#233).
 *
 * Adds two NULLABLE columns to `import_histories` so a rollback operation can
 * be recorded historically without removing the row itself — preserving the
 * audit trail (file name, source hash, started/finished timestamps) while
 * signalling the batch's transactions have been removed.
 *
 *  - `rolled_back_at`  TIMESTAMP    set the moment the batch's transactions
 *                                  are deleted; NULL on healthy batches.
 *  - `rolled_back_by_user_id` INT   actor attribution; NULL on healthy
 *                                  batches and on legacy rollbacks that pre-
 *                                  date this column.
 *
 * The existing `status` column is reused: a rolled-back batch carries
 * `status='rolled_back'`. This keeps the history table's status filter as the
 * single source of truth (no new `is_rolled_back` boolean to keep in sync).
 *
 * No index is required: rollback lookups always join through
 * (household_id, batch_label) which is already covered by the batch-label
 * scoping in `householdWhere`. The new columns are queried per-row, not
 * scanned.
 *
 * Migration is fully reversible — `down` removes both columns. The migration
 * round-trip test (`importHistoriesRollbackMigration.test.ts`) exercises the
 * up/down cycle on SQLite to keep the test harness honest.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('import_histories', 'rolled_back_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('import_histories', 'rolled_back_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('import_histories', 'rolled_back_by_user_id');
    await queryInterface.removeColumn('import_histories', 'rolled_back_at');
  },
};

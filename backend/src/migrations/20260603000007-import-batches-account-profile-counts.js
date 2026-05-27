'use strict';

/**
 * Import batch manager (#231) — extend `import_histories` so each batch
 * record carries the structured metadata needed by the batch detail view.
 *
 * Columns added (all NULL-safe so existing rows stay valid):
 *  - account_id (FK → accounts): which account the batch targeted. NULL for
 *    legacy rows or batches that didn't resolve an account (e.g. invalid
 *    filename failures).
 *  - profile_id (string): which CSV profile (`generic_simple`,
 *    `generic_passthrough`, `auto`, etc.) was used. NULL for non-CSV imports.
 *  - inserted_count (integer): how many transactions were actually inserted
 *    in this run. Mirrors the per-run `inserted` value returned from
 *    importCsvFile. NULL for legacy rows where `row_count` is the only count
 *    that was captured.
 *  - skipped_duplicate_count (integer): duplicates that matched an existing
 *    transaction by fingerprint or unique-violation path. NULL for legacy
 *    rows.
 *  - row_errors_count (integer): rows that failed parsing/mapping. NULL for
 *    legacy rows.
 *
 * Index on `(household_id, started_at DESC)` so the batch list query
 * (latest-first per household) stays cheap as the table grows.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('import_histories', 'account_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'accounts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('import_histories', 'profile_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('import_histories', 'inserted_count', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn(
      'import_histories',
      'skipped_duplicate_count',
      {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
    );
    await queryInterface.addColumn('import_histories', 'row_errors_count', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addIndex(
      'import_histories',
      ['household_id', 'started_at'],
      { name: 'import_histories_household_started_at' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'import_histories',
      'import_histories_household_started_at',
    );
    await queryInterface.removeColumn('import_histories', 'row_errors_count');
    await queryInterface.removeColumn(
      'import_histories',
      'skipped_duplicate_count',
    );
    await queryInterface.removeColumn('import_histories', 'inserted_count');
    await queryInterface.removeColumn('import_histories', 'profile_id');
    await queryInterface.removeColumn('import_histories', 'account_id');
  },
};

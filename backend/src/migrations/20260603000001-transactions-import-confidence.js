'use strict';

/**
 * Per-transaction import-confidence sidecar columns (#214).
 *
 * `import_confidence` is a small enum ('clean' | 'needs_review') describing
 * the deterministic state assigned during import after CSV parse, rule
 * application, dedup, and review-flag classification. Existing rows stay
 * NULL until they are touched by a future import or a backfill — NULL is
 * treated as "unknown" by the aggregator so backward compatibility holds.
 *
 * `import_confidence_flags` is a JSON-encoded array of flag tokens
 * (e.g. ["missing_category", "needs_review"]). Stored as TEXT rather than
 * JSONB so the same column shape works against the SQLite-backed migration
 * round-trip tests. Always JSON.stringify'd or NULL.
 *
 * Index on `import_confidence` keeps the "filter the Review Inbox by
 * confidence state" query cheap.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'import_confidence', {
      type: Sequelize.STRING(16),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('transactions', 'import_confidence_flags', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addIndex('transactions', ['import_confidence'], {
      name: 'transactions_import_confidence',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transactions',
      'transactions_import_confidence',
    );
    await queryInterface.removeColumn('transactions', 'import_confidence_flags');
    await queryInterface.removeColumn('transactions', 'import_confidence');
  },
};

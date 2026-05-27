'use strict';

/**
 * Transaction revisions table — version history for transaction edits
 * (#229).
 *
 * Captures field-level before/after snapshots whenever a tracked Transaction
 * field changes. A Sequelize `beforeUpdate` hook on the Transaction model
 * records the diff inside the same SQL transaction as the parent save.
 *
 * Why an event log instead of full row snapshots:
 *  - Storage stays bounded; a category edit writes one tiny diff row.
 *  - Restore is per-field (the AC only requires restoring supported
 *    scalars), so we don't need a complete prior snapshot to rebuild.
 *  - Mirrors `transaction_signals` and `ai_suggestions` — both already keep
 *    per-event JSON rows linked to a parent transaction.
 *
 * Schema decisions:
 *  - `changes` is JSON-encoded TEXT (not JSONB) so the migration round-trips
 *    against the in-memory SQLite test harness used by the migration suite.
 *    The route layer serializes/deserializes via JSON.stringify / JSON.parse.
 *  - `source` is a STRING(32) enum tag — easier to extend than a PG enum.
 *    Documented values: 'user_edit', 'bulk_patch', 'ai_suggestion', 'import',
 *    'enrichment', 'refund_link', 'system'. Routes validate.
 *  - `changed_by_user_id` is NULLABLE so background jobs and imports (which
 *    have no human actor) can still emit revisions.
 *  - `ai_suggestion_id` links to ai_suggestions when source='ai_suggestion'
 *    so the timeline can render "AI suggested X — accepted by you" with a
 *    clickable provenance link.
 *  - Indexes on `transaction_id` (timeline lookup) and `household_id` (cross-
 *    transaction audit query) are the only ones we need for v1.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('transaction_revisions', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      changed_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'user_edit',
      },
      ai_suggestion_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      changes: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('transaction_revisions', ['transaction_id'], {
      name: 'transaction_revisions_transaction_id',
    });
    await queryInterface.addIndex('transaction_revisions', ['household_id'], {
      name: 'transaction_revisions_household_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('transaction_revisions');
  },
};

'use strict';

/**
 * Issue #222 — Transfer reconciliation.
 *
 * Adds two nullable columns to `transactions`:
 *   - `transfer_purpose` STRING(32): the classified business purpose of a
 *     transfer (e.g. owner_draw, owner_contribution, reimbursement,
 *     investment, internal, income). Null for non-transfers and for
 *     transfers that have not yet been classified.
 *   - `transfer_linked_at` TIMESTAMP: when the transfer pair was linked
 *     (manually via /api/transfers/link, or automatically by the
 *     enrichment pipeline). Distinct from `updated_at` so we can show
 *     "linked X days ago" in the UI without conflating it with unrelated
 *     edits.
 *
 * Both nullable so the column add is safe for existing rows. No backfill
 * needed: auto-detected transfers will pick up `transfer_linked_at` on
 * the next enrichment pass; users will set `transfer_purpose` manually.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'transfer_purpose', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'transfer_linked_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    // Index the unmatched-transfer queue lookup. Partial index keeps it tiny:
    // we only care about transfers without a linked sibling.
    await queryInterface.addIndex('transactions', ['txn_type', 'linked_transaction_id'], {
      name: 'transactions_txn_type_linked_transaction_id',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transactions',
      'transactions_txn_type_linked_transaction_id',
    );
    await queryInterface.removeColumn('transactions', 'transfer_linked_at');
    await queryInterface.removeColumn('transactions', 'transfer_purpose');
  },
};

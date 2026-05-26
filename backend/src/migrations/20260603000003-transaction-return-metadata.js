'use strict';

/**
 * Per-transaction return/warranty metadata sidecar (1:1 with transactions).
 * Kept in a separate table because the vast majority of transactions never
 * need return/warranty tracking; placing nullable columns directly on the hot
 * `transactions` table would bloat row cache.
 *
 * `transaction_id` is the PK so the 1:1 mapping is enforced by uniqueness;
 * no separate index needed. Helper indexes are added on
 *   - `return_deadline` (drives "still in return window" and "expiring soon" views)
 *   - `warranty_end_date` (drives "warranty-covered purchases" view)
 *   - `receipt_status` (drives "missing receipts" view)
 *
 * Values for `receipt_status`:
 *   'unknown'    — default; user hasn't classified
 *   'have'       — user has the receipt (paper or attached digitally)
 *   'missing'    — user knows the receipt is missing and wants to flag it
 *   'not_needed' — small purchase / no warranty / out of return window
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('transaction_return_metadata', {
      transaction_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      return_deadline: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      warranty_end_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      receipt_status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'unknown',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'transaction_return_metadata',
      ['return_deadline'],
      { name: 'transaction_return_metadata_return_deadline' },
    );
    await queryInterface.addIndex(
      'transaction_return_metadata',
      ['warranty_end_date'],
      { name: 'transaction_return_metadata_warranty_end_date' },
    );
    await queryInterface.addIndex(
      'transaction_return_metadata',
      ['receipt_status'],
      { name: 'transaction_return_metadata_receipt_status' },
    );
  },
  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transaction_return_metadata',
      'transaction_return_metadata_receipt_status',
    );
    await queryInterface.removeIndex(
      'transaction_return_metadata',
      'transaction_return_metadata_warranty_end_date',
    );
    await queryInterface.removeIndex(
      'transaction_return_metadata',
      'transaction_return_metadata_return_deadline',
    );
    await queryInterface.dropTable('transaction_return_metadata');
  },
};

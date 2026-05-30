'use strict';

/**
 * Large purchase review sidecar (issue #244). 1:1 with `transactions`
 * (`transaction_id` is the primary key). Stored as a sidecar — most
 * transactions don't need a review record — so we keep nullable cols off
 * the hot transactions table, mirroring `transaction_return_metadata`.
 *
 * Status vocabulary:
 *   'pending'   — flagged, not yet reviewed (default)
 *   'reviewed'  — user completed the checklist and confirmed it's fine
 *   'dismissed' — user explicitly dismissed without full review
 *
 * FK delete semantics:
 *   transaction_id   CASCADE — sidecar is meaningless without its transaction
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('transaction_large_purchase_reviews', {
      transaction_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
      },
      category_confirmed: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      business_relevant: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      receipt_confirmed: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      warranty_tracked: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      reimbursement_tracked: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      reviewed_at: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      'transaction_large_purchase_reviews',
      ['status'],
      { name: 'transaction_large_purchase_reviews_status' },
    );
    await queryInterface.addIndex(
      'transaction_large_purchase_reviews',
      ['reviewed_at'],
      { name: 'transaction_large_purchase_reviews_reviewed_at' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transaction_large_purchase_reviews',
      'transaction_large_purchase_reviews_reviewed_at',
    );
    await queryInterface.removeIndex(
      'transaction_large_purchase_reviews',
      'transaction_large_purchase_reviews_status',
    );
    await queryInterface.dropTable('transaction_large_purchase_reviews');
  },
};

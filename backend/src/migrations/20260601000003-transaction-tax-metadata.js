'use strict';

/**
 * Per-transaction tax metadata sidecar (1:1 with transactions). Kept in a
 * separate table because most transactions never need tax metadata; storing
 * nullable columns directly on transactions would balloon the hot table.
 *
 * `transaction_id` is the primary key (1:1 enforced by PK), so there's no
 * separate unique index needed. Reviewed/receipt-required flags drive the
 * hygiene dashboard queues.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('transaction_tax_metadata', {
      transaction_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tax_tag_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tax_tags', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      deductible_percent: {
        // 0.0000 to 1.0000 — stored as a fraction so summing/multiplying is
        // straightforward in JS-land Decimal math.
        type: Sequelize.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 1,
      },
      hst_gst_amount: {
        // Tax portion baked into the transaction amount. Optional — many
        // transactions are zero-rated or out-of-scope.
        type: Sequelize.DECIMAL(14, 4),
        allowNull: true,
      },
      receipt_required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reviewed_for_tax: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('transaction_tax_metadata', ['tax_tag_id'], {
      name: 'transaction_tax_metadata_tax_tag_id',
    });
    await queryInterface.addIndex('transaction_tax_metadata', ['reviewed_for_tax'], {
      name: 'transaction_tax_metadata_reviewed_for_tax',
    });
    await queryInterface.addIndex('transaction_tax_metadata', ['receipt_required'], {
      name: 'transaction_tax_metadata_receipt_required',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transaction_tax_metadata',
      'transaction_tax_metadata_receipt_required',
    );
    await queryInterface.removeIndex(
      'transaction_tax_metadata',
      'transaction_tax_metadata_reviewed_for_tax',
    );
    await queryInterface.removeIndex(
      'transaction_tax_metadata',
      'transaction_tax_metadata_tax_tag_id',
    );
    await queryInterface.dropTable('transaction_tax_metadata');
  },
};

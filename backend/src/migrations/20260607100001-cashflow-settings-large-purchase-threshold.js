'use strict';

/**
 * Adds `large_purchase_threshold` to `cashflow_settings` for #244.
 *
 * Drives the large purchase review workflow. When a transaction's
 * abs(amount) >= this threshold the transaction is flagged for review.
 * Default 500.00 (in the user's primary currency — no FX conversion).
 * Set to 0 to effectively disable flagging.
 *
 * DECIMAL(14,4), NOT NULL, default 500.0000. Route layer enforces 0..1_000_000.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('cashflow_settings', 'large_purchase_threshold', {
      type: Sequelize.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 500.0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cashflow_settings', 'large_purchase_threshold');
  },
};

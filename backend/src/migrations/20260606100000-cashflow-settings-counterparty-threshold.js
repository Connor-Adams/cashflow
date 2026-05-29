'use strict';

/**
 * Adds `counterparty_promotion_threshold` to `cashflow_settings` for #373.
 *
 * Drives the "promote counterparty to Contact" suggestion detector. When
 * a household has N+ unlinked transactions in the trailing 90 days sharing
 * the same normalized `counterparty_raw`, the AI Inbox surfaces a
 * suggestion to create a Contact and bulk-link them. N defaults to 3 to
 * match the issue acceptance criteria; users can raise it via the
 * settings PATCH endpoint to dampen noise.
 *
 * INTEGER, NOT NULL, default 3. Route layer enforces 2..50.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('cashflow_settings', 'counterparty_promotion_threshold', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 3,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(
      'cashflow_settings',
      'counterparty_promotion_threshold',
    );
  },
};

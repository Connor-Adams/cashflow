'use strict';

/**
 * Adds `assumed_annual_return_rate` to `cashflow_settings` for #654.
 *
 * Drives the safe-to-spend surplus "pay off debt vs. invest it" comparison:
 * the assumed annual return (decimal, 0.05 == 5%) used to project the future
 * value of investing the surplus. DECIMAL(5,4), NOT NULL, default 0.0500.
 * Route layer enforces 0 <= rate <= 1.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('cashflow_settings', 'assumed_annual_return_rate', {
      type: Sequelize.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0.05,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cashflow_settings', 'assumed_annual_return_rate');
  },
};

'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('portfolio_forward_projections', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      qty_basis: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      annual_dividend_per_share: { type: Sequelize.DECIMAL(20, 8), allowNull: false, defaultValue: 0 },
      annual_interest_per_share: { type: Sequelize.DECIMAL(20, 8), allowNull: false, defaultValue: 0 },
      projected_annual_income_native: { type: Sequelize.DECIMAL(20, 2), allowNull: false, defaultValue: 0 },
      currency: { type: Sequelize.STRING(8), allowNull: false },
      cadence_label: { type: Sequelize.STRING(16), allowNull: false },
      median_spacing_days: { type: Sequelize.INTEGER, allowNull: true },
      cv_pct: { type: Sequelize.DECIMAL(8, 4), allowNull: true },
      unreliable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      next_ex_div_dates: { type: Sequelize.JSON, allowNull: false, defaultValue: [] },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      stale_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'portfolio_forward_projections',
      ['household_id', 'security_id'],
      { name: 'pfp_household_security_unique', unique: true },
    );
    await queryInterface.addIndex(
      'portfolio_forward_projections',
      ['household_id', 'stale_at'],
      { name: 'idx_pfp_household_stale' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('portfolio_forward_projections');
  },
};

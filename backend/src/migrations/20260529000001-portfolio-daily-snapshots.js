'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('portfolio_daily_snapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      market_value_native: { type: Sequelize.DECIMAL(20, 4), allowNull: false },
      currency: { type: Sequelize.STRING(8), allowNull: false },
      fx_rate_to_cad: { type: Sequelize.DECIMAL(12, 6), allowNull: false },
      market_value_cad: { type: Sequelize.DECIMAL(20, 4), allowNull: false },
      cash_flow_native: { type: Sequelize.DECIMAL(20, 4), allowNull: false, defaultValue: 0 },
      cash_flow_cad: { type: Sequelize.DECIMAL(20, 4), allowNull: false, defaultValue: 0 },
      is_partial: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      missing_data_reasons: { type: isPostgres ? Sequelize.JSONB : Sequelize.JSON, allowNull: true },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['household_id', 'account_id', 'date'],
      { name: 'uq_pds_household_account_date', unique: true },
    );
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['household_id', 'date'],
      { name: 'idx_pds_household_date' },
    );
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['account_id', 'date'],
      { name: 'idx_pds_account_date' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('portfolio_daily_snapshots');
  },
};

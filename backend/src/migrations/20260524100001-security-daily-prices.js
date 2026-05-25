'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('security_daily_prices', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      open: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      high: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      low: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      close: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      adj_close: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      volume: { type: Sequelize.BIGINT, allowNull: true },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('security_daily_prices', ['security_id', 'date'], {
      name: 'security_daily_prices_security_date_unique',
      unique: true,
    });
    await queryInterface.addIndex('security_daily_prices', ['security_id', 'date'], {
      name: 'security_daily_prices_security_date_desc',
      // sqlite ignores DESC; ordering done at query time
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('security_daily_prices');
  },
};

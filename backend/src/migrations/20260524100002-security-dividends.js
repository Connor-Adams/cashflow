'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('security_dividends', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      ex_dividend_date: { type: Sequelize.DATEONLY, allowNull: false },
      declaration_date: { type: Sequelize.DATEONLY, allowNull: true },
      record_date: { type: Sequelize.DATEONLY, allowNull: true },
      payment_date: { type: Sequelize.DATEONLY, allowNull: true },
      amount: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('security_dividends', ['security_id', 'ex_dividend_date'], {
      name: 'security_dividends_security_exdate_unique',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('security_dividends');
  },
};

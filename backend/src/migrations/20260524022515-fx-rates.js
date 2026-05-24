'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('fx_rates', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      from_currency: { type: Sequelize.STRING(3), allowNull: false },
      to_currency: { type: Sequelize.STRING(3), allowNull: false },
      rated_date: { type: Sequelize.STRING(10), allowNull: false },
      rate: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      source: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'bank_of_canada',
      },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      'fx_rates',
      ['from_currency', 'to_currency', 'rated_date'],
      { name: 'fx_rates_from_to_date' }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('fx_rates', 'fx_rates_from_to_date');
    await queryInterface.dropTable('fx_rates');
  },
};

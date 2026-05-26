'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('households', 'benchmark_symbol', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'SPY',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('households', 'benchmark_symbol');
  },
};

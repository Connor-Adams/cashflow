'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'tax_treatment', {
      type: Sequelize.STRING(24),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'tax_treatment');
  },
};

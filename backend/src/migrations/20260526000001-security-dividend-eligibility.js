'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('securities', 'dividend_eligibility', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'eligible',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('securities', 'dividend_eligibility');
  },
};

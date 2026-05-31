'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'income_source', {
      type: Sequelize.STRING(32),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('transactions', 'gross_amount', {
      type: Sequelize.DECIMAL(15, 4),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('transactions', 'tax_withheld', {
      type: Sequelize.DECIMAL(15, 4),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'income_source');
    await queryInterface.removeColumn('transactions', 'gross_amount');
    await queryInterface.removeColumn('transactions', 'tax_withheld');
  },
};

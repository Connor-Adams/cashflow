'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'opening_balance', {
      type: Sequelize.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('accounts', 'opening_balance_date', {
      type: Sequelize.DATEONLY,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('accounts', 'opening_balance_date');
    await queryInterface.removeColumn('accounts', 'opening_balance');
  },
};

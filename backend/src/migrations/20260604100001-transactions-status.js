'use strict';

const INDEX_NAME = 'transactions_status_account_id_date';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'status', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'posted',
    });
    await queryInterface.addIndex('transactions', ['status', 'account_id', 'date'], {
      name: INDEX_NAME,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('transactions', INDEX_NAME);
    await queryInterface.removeColumn('transactions', 'status');
  },
};


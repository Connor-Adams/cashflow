'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('transactions', ['entity_id', 'date'], {
      name: 'transactions_entity_date',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('transactions', 'transactions_entity_date');
    await queryInterface.removeColumn('transactions', 'entity_id');
  },
};

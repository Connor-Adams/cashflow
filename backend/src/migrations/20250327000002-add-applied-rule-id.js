'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'applied_rule_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'rules', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('transactions', ['applied_rule_id'], {
      name: 'transactions_applied_rule_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transactions',
      'transactions_applied_rule_id'
    );
    await queryInterface.removeColumn('transactions', 'applied_rule_id');
  },
};

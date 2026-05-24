'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('instalment_payments', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      quarter: { type: Sequelize.INTEGER, allowNull: true }, // 1-4, nullable for non-quarterly
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      paid_on: { type: Sequelize.STRING(10), allowNull: false }, // YYYY-MM-DD
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('instalment_payments', ['entity_id', 'year'], {
      name: 'instalment_payments_entity_year',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('instalment_payments', 'instalment_payments_entity_year');
    await queryInterface.dropTable('instalment_payments');
  },
};

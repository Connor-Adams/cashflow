'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('shareholder_loans', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      kind: { type: Sequelize.STRING(24), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('shareholder_loans', ['entity_id', 'date'], {
      name: 'shareholder_loans_entity_date',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('shareholder_loans', 'shareholder_loans_entity_date');
    await queryInterface.dropTable('shareholder_loans');
  },
};

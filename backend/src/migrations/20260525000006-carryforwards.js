'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('carryforwards', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      kind: { type: Sequelize.STRING(24), allowNull: false },
      as_of_year: { type: Sequelize.INTEGER, allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('carryforwards', ['entity_id', 'kind', 'as_of_year'], {
      name: 'carryforwards_entity_kind_year',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('carryforwards', 'carryforwards_entity_kind_year');
    await queryInterface.dropTable('carryforwards');
  },
};

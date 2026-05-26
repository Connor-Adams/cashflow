'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('scenarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      parent_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'scenarios', key: 'id' }, onDelete: 'RESTRICT' },
      entity_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'tax_entities', key: 'id' }, onDelete: 'CASCADE' },
      year: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      kind: { type: Sequelize.STRING(20), allowNull: false }, // 'baseline' | 'fork' | 'projection_root'
      overrides: { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
      assumptions: { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
      next_year_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'scenarios', key: 'id' }, onDelete: 'SET NULL' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('scenarios', ['parent_id']);
    await queryInterface.addIndex('scenarios', ['entity_id', 'year']);
    await queryInterface.addConstraint('scenarios', {
      fields: ['entity_id', 'year', 'name'],
      type: 'unique',
      name: 'scenarios_entity_year_name_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('scenarios');
  },
};

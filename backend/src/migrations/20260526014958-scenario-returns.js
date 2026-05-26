'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('scenario_returns', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      scenario_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'scenarios', key: 'id' }, onDelete: 'CASCADE' },
      facts_hash: { type: Sequelize.STRING(64), allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      lines: { type: Sequelize.JSON, allowNull: false },
      totals: { type: Sequelize.JSON, allowNull: false },
      warnings: { type: Sequelize.JSON, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addConstraint('scenario_returns', {
      fields: ['scenario_id', 'facts_hash'],
      type: 'unique',
      name: 'scenario_returns_scenario_hash_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('scenario_returns');
  },
};

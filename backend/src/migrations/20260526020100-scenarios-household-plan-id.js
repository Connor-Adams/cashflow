'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('scenarios', 'household_plan_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'household_plans', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('scenarios', ['household_plan_id']);
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('scenarios', 'household_plan_id');
  },
};

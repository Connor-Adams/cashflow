'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('jobs', {
      name: { type: Sequelize.STRING(128), primaryKey: true, allowNull: false },
      enabled_override: { type: Sequelize.BOOLEAN, allowNull: true },
      cron_override: { type: Sequelize.STRING(128), allowNull: true },
      last_run_at: { type: Sequelize.DATE, allowNull: true },
      last_finished_at: { type: Sequelize.DATE, allowNull: true },
      last_status: { type: Sequelize.STRING(32), allowNull: true },
      last_duration_ms: { type: Sequelize.INTEGER, allowNull: true },
      last_error: { type: Sequelize.STRING(1024), allowNull: true },
      last_result_json: { type: Sequelize.STRING(2048), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('jobs');
  },
};

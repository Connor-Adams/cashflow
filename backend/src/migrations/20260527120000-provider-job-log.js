'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('provider_job_log', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      provider: { type: Sequelize.STRING(64), allowNull: false },
      function: { type: Sequelize.STRING(64), allowNull: false },
      symbol: { type: Sequelize.STRING(64), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false },
      http_status: { type: Sequelize.INTEGER, allowNull: true },
      error_message: { type: Sequelize.STRING(1024), allowNull: true },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      'provider_job_log',
      ['provider', 'function', 'symbol', 'fetched_at'],
      { name: 'provider_job_log_staleness' },
    );

    await queryInterface.addIndex(
      'provider_job_log',
      ['provider', 'fetched_at'],
      { name: 'provider_job_log_budget' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('provider_job_log', 'provider_job_log_budget');
    await queryInterface.removeIndex('provider_job_log', 'provider_job_log_staleness');
    await queryInterface.dropTable('provider_job_log');
  },
};

'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('securities', 'metadata', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn('securities', 'metadata_fetched_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('securities', 'metadata_fetched_at');
    await queryInterface.removeColumn('securities', 'metadata');
  },
};

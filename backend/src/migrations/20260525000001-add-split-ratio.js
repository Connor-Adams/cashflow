'use strict';

// Adds split_ratio to investment_activities so the ACB engine can apply
// stock splits and reverse splits. Nullable — existing rows have no ratio,
// and only activities with activity_type='split' are expected to populate it.

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('investment_activities', 'split_ratio', {
      type: Sequelize.DECIMAL(10, 6),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('investment_activities', 'split_ratio');
  },
};

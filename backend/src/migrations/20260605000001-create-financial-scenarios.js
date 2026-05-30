'use strict';

/**
 * Financial scenario planner (issue #213).
 *
 * NOTE: a `scenarios` table already exists in the tax domain
 * (20260526014957-scenarios.js) — this feature deliberately uses
 * `financial_scenarios` to avoid colliding with it.
 *
 * Stores user-modelled hypothetical financial changes. `assumptions_json`
 * holds the array of assumption objects the planner replays; `result_json`
 * caches the most recent computed {base, scenario, deltas} so a list view can
 * render without recomputing every row.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('financial_scenarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(255), allowNull: false },
      // Nullable per the issue spec — there is no forecast table to FK to yet,
      // but the column is reserved so a saved forecast can be referenced later.
      base_forecast_id: { type: Sequelize.INTEGER, allowNull: true },
      assumptions_json: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: [],
      },
      // Cached computed result; null until first computed (always populated on
      // create today, but nullable keeps the door open to lazy compute).
      result_json: { type: Sequelize.JSON, allowNull: true },
      horizon_days: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 90,
      },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('financial_scenarios', ['household_id', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('financial_scenarios');
  },
};

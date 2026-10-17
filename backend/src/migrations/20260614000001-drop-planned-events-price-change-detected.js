'use strict';
/** Expectation/Observation cleanup: the subscription price-increase signal now
 * lives in an Insight (type='subscription_price_increase'), not this boolean.
 *
 * The drop goes through `dropColumn`, NOT `queryInterface.removeColumn`: on
 * SQLite the latter rebuilds `planned_events` from `describeTable()` and smears
 * the partial unique `(household_id, normalized_name, currency)` into a
 * column-level `UNIQUE` on each of the three, which caps the table at one row
 * per currency and makes the rebuild's own data copy throw as soon as two
 * subscriptions in a household share one. See the helper for the full list of
 * what that round-trip loses. No index references this column, so the native
 * drop needs no index shuttling. */
/** @type {import('sequelize-cli').Migration} */
const { dropColumn } = require('./helpers/sqliteDropColumn');

module.exports = {
  async up(queryInterface) {
    await dropColumn(queryInterface, 'planned_events', 'price_change_detected');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('planned_events', 'price_change_detected', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
};

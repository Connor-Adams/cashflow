'use strict';
/** Expectation/Observation cleanup: the subscription price-increase signal now
 * lives in an Insight (type='subscription_price_increase'), not this boolean. */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('planned_events', 'price_change_detected');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('planned_events', 'price_change_detected', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
};

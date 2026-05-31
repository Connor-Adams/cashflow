'use strict';
/** Expectation fold — Phase A1, M3. Drop subscriptions now that all reads/writes go
 * through planned_events (kind='subscription'). down() recreates the empty table shape
 * for schema rollback only. */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('subscriptions');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.createTable('subscriptions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      merchant_name: { type: Sequelize.STRING(255), allowNull: false },
      normalized_name: { type: Sequelize.STRING(255), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      cadence: { type: Sequelize.STRING(16), allowNull: false },
      last_charge_date: { type: Sequelize.DATEONLY, allowNull: false },
      next_expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active' },
      category: { type: Sequelize.STRING(128), allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      price_change_detected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('subscriptions', ['household_id', 'normalized_name', 'currency'], { name: 'subscriptions_household_name_currency_unique', unique: true });
    await queryInterface.addIndex('subscriptions', ['household_id', 'status'], { name: 'subscriptions_household_status' });
  },
};

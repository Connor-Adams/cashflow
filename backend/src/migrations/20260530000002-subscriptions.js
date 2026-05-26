'use strict';

/**
 * subscriptions: promote recurring-charge detection into a managed
 * subscription registry (Cashflow #205). Detection still runs through the
 * pure detector in routes/recurring.ts; refresh-on-read upserts groups into
 * this table so users can mark items active/cancelled/ignored/unknown,
 * record cancellation URLs and notes, and see price-increase flags.
 *
 * `status` and `cadence` are stored as string columns (not real PG enums)
 * so extending the sets later — for example adding "trial" — does not need
 * a destructive ALTER TYPE migration. The route layer validates against the
 * allowed lists at write time.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
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
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'active',
      },
      category: { type: Sequelize.STRING(128), allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      price_change_detected: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'subscriptions',
      ['household_id', 'normalized_name', 'currency'],
      { name: 'subscriptions_household_name_currency_unique', unique: true },
    );
    await queryInterface.addIndex(
      'subscriptions',
      ['household_id', 'status'],
      { name: 'subscriptions_household_status' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'subscriptions',
      'subscriptions_household_status',
    );
    await queryInterface.removeIndex(
      'subscriptions',
      'subscriptions_household_name_currency_unique',
    );
    await queryInterface.dropTable('subscriptions');
  },
};

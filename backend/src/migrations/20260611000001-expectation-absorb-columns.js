'use strict';

/**
 * Expectation fold — Phase A1, M1 (spec 2026-05-31-cashflow-spine-folds-design.md).
 * Add the discriminator + subscription-absorbing columns to planned_events, plus a
 * partial unique index over (household_id, normalized_name, currency) scoped to
 * kind='subscription'. Additive + reversible — no data copy here (see M2).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = {
      kind: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'planned' },
      cadence: { type: Sequelize.STRING(16), allowNull: true },
      normalized_name: { type: Sequelize.STRING(255), allowNull: true },
      last_charge_date: { type: Sequelize.DATEONLY, allowNull: true },
      next_expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      annualized_cost: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      price_change_detected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      cancellation_url: { type: Sequelize.TEXT, allowNull: true },
      category: { type: Sequelize.STRING(128), allowNull: true },
      status_uncertain: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    };
    for (const [name, def] of Object.entries(cols)) {
      await queryInterface.addColumn('planned_events', name, def);
    }
    await queryInterface.addIndex(
      'planned_events',
      ['household_id', 'normalized_name', 'currency'],
      {
        name: 'planned_events_subscription_identity_unique',
        unique: true,
        where: { kind: 'subscription' },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'planned_events',
      'planned_events_subscription_identity_unique',
    );
    for (const name of [
      'kind', 'cadence', 'normalized_name', 'last_charge_date', 'next_expected_date',
      'annualized_cost', 'price_change_detected', 'cancellation_url', 'category',
      'status_uncertain',
    ]) {
      await queryInterface.removeColumn('planned_events', name);
    }
  },
};

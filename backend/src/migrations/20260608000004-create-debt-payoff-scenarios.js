'use strict';

/**
 * Saved debt-payoff scenarios — `debt_payoff_scenarios` (#202).
 *
 * Persists a named payoff configuration the user can revisit. The computed
 * amortization schedule is NOT stored — it is re-derived on read from the
 * current liabilities so the plan stays current as balances change. We only
 * persist the inputs:
 *
 *   - strategy              'avalanche' | 'snowball' | 'custom'. STRING(16) so
 *                           the vocab can grow without a destructive migration.
 *   - extra_monthly_payment additional payment above the sum of minimums.
 *   - payload_json          TEXT JSON blob holding strategy extras — for
 *                           'custom' the ordered debt-id list, plus an optional
 *                           snapshot of the liabilities the plan was built from.
 *
 * FK delete semantics:
 *   household_id CASCADE  — household teardown removes its scenarios.
 *   user_id      SET NULL — keep the (household-scoped) scenario if the
 *                           creating user is removed.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('debt_payoff_scenarios', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      strategy: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'avalanche',
      },
      extra_monthly_payment: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
        defaultValue: 0,
      },
      payload_json: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'debt_payoff_scenarios', ['household_id'], {
      name: 'debt_payoff_scenarios_household_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('debt_payoff_scenarios');
  },
};

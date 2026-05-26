'use strict';

/**
 * Financial goals / sinking funds (issue #203).
 *
 * Household-scoped savings targets (emergency fund, taxes, vacation, car
 * down payment, annual insurance, etc.) with a current balance, optional
 * target date, and optional desired monthly contribution. Drives required-
 * contribution math (`backend/src/goals/projection.ts`) and feeds the
 * upcoming safe-to-spend feature (issue #199) via
 * `requiredMonthlyContributionsByCurrency`.
 *
 * Schema choices:
 * - `status` is STRING(32) (not a native enum) so the value set can grow
 *   without a destructive migration. Validation lives in the route layer.
 *   Today: `active | paused | completed`. Completed goals are archived
 *   (status flip), not auto-deleted; users may still hard-delete via the
 *   DELETE endpoint.
 * - `target_amount` and `current_amount` are DECIMAL(14,4) to match other
 *   money fields (transactions, planned_events, budgets) — keeps lossless
 *   arithmetic across currencies.
 * - `target_date` is nullable: a goal can be open-ended ("save for any
 *   emergency, no deadline"). In that case the projection endpoint returns
 *   `onTrackStatus: 'no_deadline'` and no required-monthly figure.
 * - `monthly_contribution` is nullable: it's the user-declared intended
 *   contribution, separate from the system-computed required contribution.
 *   Optional so the user can let the deadline drive the math.
 * - `linked_account_id` is nullable; ON DELETE SET NULL so dropping an
 *   account does not nuke the planning intent.
 * - `priority` is INTEGER (default 0) — used purely for sort/display order
 *   in the UI. Higher numbers float to the top.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('financial_goals', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      target_amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      current_amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      target_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      monthly_contribution: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: true,
      },
      linked_account_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      priority: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'active',
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'financial_goals', ['household_id'], {
      name: 'financial_goals_household_id',
    });
    await addIndex(queryInterface, 'financial_goals', ['user_id'], {
      name: 'financial_goals_user_id',
    });
    await addIndex(
      queryInterface,
      'financial_goals',
      ['household_id', 'status'],
      { name: 'financial_goals_household_status' },
    );
    await addIndex(queryInterface, 'financial_goals', ['linked_account_id'], {
      name: 'financial_goals_linked_account_id',
    });
    await addIndex(
      queryInterface,
      'financial_goals',
      ['household_id', 'status', 'currency'],
      { name: 'financial_goals_household_status_currency' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('financial_goals');
  },
};

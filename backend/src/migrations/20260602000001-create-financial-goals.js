'use strict';

/**
 * Financial goals & sinking funds (issue #203).
 *
 * Stores user-defined savings targets with optional target dates and
 * monthly contribution intent. Downstream features (safe-to-spend #199,
 * forecast #198, calendar #200) read required contributions to factor
 * goal progress into available cash projections.
 *
 * Schema choices:
 * - `status` is STRING(32) so the value set can grow (active|paused|
 *   completed today; future values like 'cancelled' welcome) without a
 *   destructive migration. The route layer validates against the known set.
 * - `target_amount` / `current_amount` / `monthly_contribution` are
 *   DECIMAL(14,4) to match the existing precision used by transactions,
 *   budgets, planned events — keeps lossless arithmetic and avoids float
 *   drift when summing contributions.
 * - `target_date` is nullable: a "build $5000 emergency fund" goal has no
 *   deadline; an "annual insurance premium of $1200 due 2026-12-01" does.
 * - `monthly_contribution` is nullable: when null we treat the goal as
 *   "I want to reach this by target_date" and the projection endpoint
 *   computes the required contribution. When set, it represents the user's
 *   declared monthly contribution intent; status (on-track / behind / ahead)
 *   is derived from contribution vs required.
 * - `linked_account_id` is nullable FK with ON DELETE SET NULL — deleting
 *   an account should NOT cascade-delete the goal. The user may rebind to
 *   another account later.
 * - `priority` is INTEGER (0 default) for client-side sorting; higher
 *   numbers sort to the top. Not a unique key.
 * - Indexes target the common access patterns: list by household, filter
 *   by status, sort by priority.
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
    await addIndex(queryInterface, 'financial_goals', ['linked_account_id'], {
      name: 'financial_goals_linked_account_id',
    });
    await addIndex(
      queryInterface,
      'financial_goals',
      ['household_id', 'status'],
      { name: 'financial_goals_household_status' }
    );
    await addIndex(
      queryInterface,
      'financial_goals',
      ['household_id', 'priority'],
      { name: 'financial_goals_household_priority' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('financial_goals');
  },
};

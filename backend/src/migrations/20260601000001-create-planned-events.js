'use strict';

/**
 * Planned financial events (issue #197).
 *
 * Keystone table for forward-looking features: forecast (#198),
 * safe-to-spend (#199), calendar (#200), debt planning (#202), goals,
 * scenarios (#213). Stores user-declared future income/expense/transfer
 * intent that downstream features read.
 *
 * Schema choices:
 * - `type` / `source` / `status` are STRING(32) (not native PG enums) so
 *   we can extend the value set without a destructive migration. The route
 *   layer validates the values.
 * - `amount` is DECIMAL(14,4) to match the existing precision used by
 *   transactions, budgets, settlements — keeps lossless arithmetic across
 *   currencies and avoids float drift.
 * - `recurrence_rule` is plain TEXT (RFC 5545 RRULE string OR a JSON
 *   blob — leaving the parsing question to the forecast subsystem in #198).
 *   Null means a one-off event.
 * - `linked_transaction_id` links a planned row to an actual posted
 *   transaction (e.g. when the user marks a forecast as actuals-confirmed).
 *   Nullable; ON DELETE SET NULL so deleting a transaction does not cascade
 *   into deleting the user's planning intent.
 * - `account_id` is nullable: not every planned event must hit a specific
 *   account at edit-time (e.g. a planned bonus or a goal contribution may
 *   route to whichever account is chosen later).
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
    await queryInterface.createTable('planned_events', {
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
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      type: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      expected_date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      recurrence_rule: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'manual',
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'planned',
      },
      linked_transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'planned_events', ['household_id'], {
      name: 'planned_events_household_id',
    });
    await addIndex(queryInterface, 'planned_events', ['user_id'], {
      name: 'planned_events_user_id',
    });
    await addIndex(queryInterface, 'planned_events', ['account_id'], {
      name: 'planned_events_account_id',
    });
    await addIndex(
      queryInterface,
      'planned_events',
      ['household_id', 'expected_date'],
      { name: 'planned_events_household_expected_date' }
    );
    await addIndex(
      queryInterface,
      'planned_events',
      ['household_id', 'status', 'expected_date'],
      { name: 'planned_events_household_status_expected_date' }
    );
    await addIndex(
      queryInterface,
      'planned_events',
      ['linked_transaction_id'],
      { name: 'planned_events_linked_transaction_id' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('planned_events');
  },
};

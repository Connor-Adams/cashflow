'use strict';

/**
 * Primitive spine refactor: fold PlannedEvent + Subscription into one
 * Expectation primitive (issue #402).
 *
 * Both PlannedEvent and Subscription share the same status machine:
 * a future financial commitment that may be realized, skipped, cancelled, or
 * evolve from "planned" to "posted". Because they mirror the same lifecycle
 * they are the same primitive wearing different names — a textbook fork.
 * This migration collapses them into `expectations` with a `cadence` column
 * as the discriminator (one_shot = former PlannedEvent; recurring = former
 * Subscription).
 *
 * Source tables (planned_events, subscriptions) are left intact for backwards
 * compat. The old routes keep reading from them; the new /api/expectations
 * route reads from this table.
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
    await queryInterface.createTable('expectations', {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      account_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      cadence: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'one_shot',
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      normalized_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      amount: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: false,
      },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        defaultValue: 'USD',
      },
      type: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'planned',
      },
      expected_at: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      last_charge_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      rrule: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      category: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      annualized_cost: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: true,
      },
      price_change_detected: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      cancellation_url: {
        type: Sequelize.STRING(2048),
        allowNull: true,
      },
      source: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      linked_transaction_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      source_planned_event_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        // Intentionally no FK — planned_events may be dropped in a future
        // migration. This column exists only for migration traceability.
      },
      source_subscription_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        // Same note as source_planned_event_id above.
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await addIndex(queryInterface, 'expectations', ['household_id'], {
      name: 'idx_expectations_household_id',
    });
    await addIndex(queryInterface, 'expectations', ['expected_at'], {
      name: 'idx_expectations_expected_at',
    });
    await addIndex(queryInterface, 'expectations', ['cadence'], {
      name: 'idx_expectations_cadence',
    });

    // Populate from planned_events. Map recurrence_rule → rrule and
    // expected_date → expected_at. One-shots have no recurrence_rule;
    // those with one become 'custom' cadence.
    await queryInterface.sequelize.query(`
      INSERT INTO expectations (
        household_id, user_id, account_id, cadence, name, amount, currency,
        type, status, expected_at, rrule, notes, source,
        linked_transaction_id, source_planned_event_id, created_at, updated_at
      )
      SELECT
        household_id,
        user_id,
        account_id,
        CASE WHEN recurrence_rule IS NOT NULL THEN 'custom' ELSE 'one_shot' END,
        name,
        amount,
        currency,
        type,
        status,
        expected_date,
        recurrence_rule,
        notes,
        source,
        linked_transaction_id,
        id,
        created_at,
        updated_at
      FROM planned_events
    `);

    // Populate from subscriptions. Map merchant_name → name,
    // next_expected_date → expected_at. Cadence column is preserved as-is;
    // 'annual' becomes 'yearly' in the Expectation type union but we keep the
    // original string here to avoid lossy transforms — the old route still
    // owns Subscription rows.
    await queryInterface.sequelize.query(`
      INSERT INTO expectations (
        household_id, cadence, name, normalized_name, amount, currency,
        status, expected_at, last_charge_date, category, notes,
        annualized_cost, price_change_detected, cancellation_url,
        source_subscription_id, created_at, updated_at
      )
      SELECT
        household_id,
        cadence,
        merchant_name,
        normalized_name,
        amount,
        currency,
        status,
        next_expected_date,
        last_charge_date,
        category,
        notes,
        annualized_cost,
        price_change_detected,
        cancellation_url,
        id,
        created_at,
        updated_at
      FROM subscriptions
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('expectations');
  },
};

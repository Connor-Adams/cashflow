'use strict';

/**
 * Relax the subscription_price_changes.subscription_id foreign key.
 *
 * Context: 20260612000002 created subscription_price_changes with
 * `subscription_id BIGINT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE`.
 * The Expectation fold deleted the Subscription model and moved subscription
 * identity into planned_events (kind='subscription'). The price-change detector
 * (src/subscriptions/detectSubscriptionPriceChanges.ts) now stamps
 * subscription_id = planned_events.id, so a FK to subscriptions(id) is both wrong
 * (points at a soon-to-be-dropped table) and dangerous (the deferred `subscriptions`
 * DROP would CASCADE-delete every alert).
 *
 * Fix: drop + recreate the table WITHOUT the subscriptions FK. subscription_id
 * becomes a plain BIGINT NOT NULL. We drop+recreate rather than ALTER because
 * SQLite cannot ALTER a constraint, and this approach is cross-dialect safe.
 *
 * Data loss is INTENTIONAL: existing subscription_price_changes rows are
 * ephemeral detector output (the detectSubscriptionPriceChanges cron regenerates
 * them idempotently via the spc_unique_unack partial index). No production data of
 * lasting value is destroyed.
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
    await queryInterface.dropTable('subscription_price_changes');

    await queryInterface.createTable('subscription_price_changes', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      // subscription_id now holds planned_events.id (kind='subscription').
      // No FK: the legacy `subscriptions` table is being dropped by the fold.
      subscription_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      detected_on: { type: Sequelize.DATEONLY, allowNull: false },
      previous_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      new_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      pct_change: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      triggering_transaction_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      acknowledged_at: { type: Sequelize.DATE, allowNull: true },
      acknowledged_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['subscription_id', 'acknowledged_at'],
      { name: 'spc_subscription_ack' },
    );

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['household_id', { name: 'detected_on', order: 'DESC' }],
      { name: 'spc_household_detected_on' },
    );

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['subscription_id', 'new_amount_cents'],
      {
        name: 'spc_unique_unack',
        unique: true,
        where: { acknowledged_at: null },
      },
    );
  },

  // Recreate the table WITH the original subscriptions FK (verbatim copy of
  // 20260612000002's `up`).
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('subscription_price_changes');

    await queryInterface.createTable('subscription_price_changes', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      subscription_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'subscriptions', key: 'id' },
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
      detected_on: { type: Sequelize.DATEONLY, allowNull: false },
      previous_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      new_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      pct_change: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      triggering_transaction_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      acknowledged_at: { type: Sequelize.DATE, allowNull: true },
      acknowledged_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['subscription_id', 'acknowledged_at'],
      { name: 'spc_subscription_ack' },
    );

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['household_id', { name: 'detected_on', order: 'DESC' }],
      { name: 'spc_household_detected_on' },
    );

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['subscription_id', 'new_amount_cents'],
      {
        name: 'spc_unique_unack',
        unique: true,
        where: { acknowledged_at: null },
      },
    );
  },
};

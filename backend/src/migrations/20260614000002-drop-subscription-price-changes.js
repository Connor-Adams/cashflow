'use strict';

/**
 * Expectation/Observation cleanup: retire the `subscription_price_changes`
 * table. The subscription price-increase signal now lives in an Insight
 * (type='subscription_price_increase'), upserted by the detector + cron and
 * read by the /subscriptions chip and money-leaks view. The model + route are
 * deleted in this same change.
 *
 * `down` recreates the table in its POST-RELAX shape — i.e. with
 * `subscription_id` as a plain BIGINT and NO foreign key — because
 * 20260613000001-relax-subscription-price-change-fk.js had already dropped that
 * FK (the legacy `subscriptions` table is gone after the Expectation fold). The
 * down must restore the table as it actually existed, not the original
 * 20260612000002 shape.
 *
 * Data loss on `up` is INTENTIONAL: rows were ephemeral detector output,
 * idempotently regenerable (now as Insights). No lasting data is destroyed.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('subscription_price_changes');
  },

  // Recreate the post-relax shape (mirror 20260613000001's `up`):
  // subscription_id is a plain BIGINT NOT NULL with no FK to subscriptions.
  async down(queryInterface, Sequelize) {
    await queryInterface.createTable('subscription_price_changes', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      // subscription_id holds planned_events.id (kind='subscription').
      // No FK: the legacy `subscriptions` table was dropped by the fold.
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
};

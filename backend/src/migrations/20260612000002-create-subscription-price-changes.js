'use strict';

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
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
      ['household_id', 'detected_on'],
      {
        name: 'spc_household_detected_on',
        order: { detected_on: 'DESC' },
      },
    );

    await addIndex(
      queryInterface,
      'subscription_price_changes',
      ['subscription_id', 'new_amount_cents'],
      {
        name: 'spc_unique_unack',
        unique: true,
        where: 'acknowledged_at IS NULL',
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscription_price_changes');
  },
};

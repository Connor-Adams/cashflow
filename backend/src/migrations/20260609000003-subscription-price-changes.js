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
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      detected_on: { type: Sequelize.DATEONLY, allowNull: false },
      previous_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      new_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      pct_change: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
      currency: { type: Sequelize.CHAR(3), allowNull: false },
      triggering_transaction_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      acknowledged_at: { type: Sequelize.DATE, allowNull: true },
      acknowledged_by_user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('now()'),
      },
    });

    await addIndex(queryInterface, 'subscription_price_changes', ['subscription_id', 'acknowledged_at'], {
      name: 'idx_spc_subscription_ack',
    });
    await addIndex(queryInterface, 'subscription_price_changes', ['user_id', 'detected_on'], {
      name: 'idx_spc_user_detected_on',
    });
    await queryInterface.addIndex(
      'subscription_price_changes',
      ['subscription_id', 'new_amount_cents'],
      {
        unique: true,
        name: 'idx_spc_uniq_unack',
        where: { acknowledged_at: null },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('subscription_price_changes', 'idx_spc_uniq_unack');
    await queryInterface.removeIndex('subscription_price_changes', 'idx_spc_subscription_ack');
    await queryInterface.removeIndex('subscription_price_changes', 'idx_spc_user_detected_on');
    await queryInterface.dropTable('subscription_price_changes');
  },
};

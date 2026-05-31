'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('subscription_price_changes', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      subscription_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'subscriptions', key: 'id' },
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onDelete: 'CASCADE',
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
        onDelete: 'SET NULL',
      },
      acknowledged_at: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      acknowledged_by_user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('subscription_price_changes', ['subscription_id', 'acknowledged_at']);
    await queryInterface.addIndex('subscription_price_changes', ['household_id', 'detected_on']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscription_price_changes');
  },
};

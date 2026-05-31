'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('subscription_price_changes', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      subscription_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'subscriptions', key: 'id' },
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onDelete: 'CASCADE',
      },
      previous_amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      new_amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      detected_on: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      acknowledged_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('subscription_price_changes', ['subscription_id', 'detected_on'], {
      unique: true,
      name: 'spc_subscription_detected',
    });
    await queryInterface.addIndex('subscription_price_changes', ['household_id', 'acknowledged_at'], {
      name: 'spc_household_unacked',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscription_price_changes');
  },
};

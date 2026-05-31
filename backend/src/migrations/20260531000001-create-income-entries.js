'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('income_entries', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onDelete: 'CASCADE',
      },
      occurred_on: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      gross_amount_cents: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      tax_withheld_cents: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      net_amount_cents: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      category_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'categories', key: 'id' },
        onDelete: 'SET NULL',
      },
      counterparty_contact_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'contacts', key: 'id' },
        onDelete: 'SET NULL',
      },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'other',
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'accounts', key: 'id' },
        onDelete: 'SET NULL',
      },
      linked_transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onDelete: 'SET NULL',
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

    await queryInterface.addIndex('income_entries', ['household_id', 'occurred_on'], {
      name: 'income_entries_household_id_occurred_on',
    });
    await queryInterface.addIndex('income_entries', ['user_id', 'occurred_on'], {
      name: 'income_entries_user_id_occurred_on',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('income_entries');
  },
};

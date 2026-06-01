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
    await queryInterface.createTable('income_entries', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
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
      occurred_on: { type: Sequelize.DATEONLY, allowNull: false },
      gross_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      tax_withheld_cents: { type: Sequelize.BIGINT, allowNull: true },
      net_amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      category_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'categories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      counterparty_contact_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'contacts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      source: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'other' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      linked_transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'income_entries', ['user_id', 'occurred_on'], {
      name: 'income_entries_user_id_occurred_on',
    });
    await addIndex(queryInterface, 'income_entries', ['household_id', 'occurred_on'], {
      name: 'income_entries_household_id_occurred_on',
    });
    await addIndex(queryInterface, 'income_entries', ['counterparty_contact_id'], {
      name: 'income_entries_counterparty_contact_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('income_entries');
  },
};

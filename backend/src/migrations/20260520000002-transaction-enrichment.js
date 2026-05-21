'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'merchant_canonical', {
      type: Sequelize.STRING(256),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'txn_type', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'purchase',
    });
    await queryInterface.addColumn('transactions', 'auto_source', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'auto_confidence', {
      type: Sequelize.STRING(8),
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'linked_transaction_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'transactions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('transactions', 'is_recurring', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addIndex('transactions', ['linked_transaction_id'], {
      name: 'transactions_linked_transaction_id',
    });
    await queryInterface.addIndex('transactions', ['merchant_canonical'], {
      name: 'transactions_merchant_canonical',
    });

    await queryInterface.createTable('transaction_signals', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      source: { type: Sequelize.STRING(32), allowNull: false },
      confidence: { type: Sequelize.STRING(8), allowNull: false },
      fields: { type: Sequelize.JSON, allowNull: false },
      rationale: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('transaction_signals', ['transaction_id'], {
      name: 'transaction_signals_transaction_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'transaction_signals',
      'transaction_signals_transaction_id'
    );
    await queryInterface.dropTable('transaction_signals');
    await queryInterface.removeIndex(
      'transactions',
      'transactions_merchant_canonical'
    );
    await queryInterface.removeIndex(
      'transactions',
      'transactions_linked_transaction_id'
    );
    await queryInterface.removeColumn('transactions', 'is_recurring');
    await queryInterface.removeColumn('transactions', 'linked_transaction_id');
    await queryInterface.removeColumn('transactions', 'auto_confidence');
    await queryInterface.removeColumn('transactions', 'auto_source');
    await queryInterface.removeColumn('transactions', 'txn_type');
    await queryInterface.removeColumn('transactions', 'merchant_canonical');
  },
};

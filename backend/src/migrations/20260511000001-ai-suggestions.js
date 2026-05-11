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
    await queryInterface.createTable('ai_suggestions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      receipt_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'receipts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.STRING(32), allowNull: false },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'suggested',
      },
      input_snapshot: { type: Sequelize.JSON, allowNull: true },
      output: { type: Sequelize.JSON, allowNull: true },
      final_snapshot: { type: Sequelize.JSON, allowNull: true },
      model: { type: Sequelize.STRING(128), allowNull: true },
      prompt_version: { type: Sequelize.STRING(64), allowNull: true },
      temperature: { type: Sequelize.DECIMAL(4, 2), allowNull: true },
      latency_ms: { type: Sequelize.INTEGER, allowNull: true },
      provider_request_id: { type: Sequelize.STRING(128), allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'ai_suggestions', ['household_id', 'kind', 'status'], {
      name: 'ai_suggestions_household_kind_status',
    });
    await addIndex(queryInterface, 'ai_suggestions', ['transaction_id'], {
      name: 'ai_suggestions_transaction_id',
    });
    await addIndex(queryInterface, 'ai_suggestions', ['receipt_id'], {
      name: 'ai_suggestions_receipt_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_suggestions');
  },
};

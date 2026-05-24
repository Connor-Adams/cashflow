'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('chat_threads', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(256), allowNull: true },
      archived_at: { type: Sequelize.DATE, allowNull: true },
      last_message_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_threads', ['user_id', 'last_message_at'], {
      name: 'chat_threads_user_last_message',
    });

    await queryInterface.createTable('chat_messages', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      thread_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_threads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.STRING(16), allowNull: false },
      content_text: { type: Sequelize.TEXT, allowNull: true },
      tool_calls: { type: Sequelize.JSON, allowNull: true },
      tool_call_id: { type: Sequelize.STRING(128), allowNull: true },
      tool_name: { type: Sequelize.STRING(64), allowNull: true },
      model: { type: Sequelize.STRING(64), allowNull: true },
      prompt_tokens: { type: Sequelize.INTEGER, allowNull: true },
      completion_tokens: { type: Sequelize.INTEGER, allowNull: true },
      latency_ms: { type: Sequelize.INTEGER, allowNull: true },
      provider_request_id: { type: Sequelize.STRING(128), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_messages', ['thread_id', 'id'], {
      name: 'chat_messages_thread_id_id',
    });

    await queryInterface.createTable('chat_proposals', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      thread_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_threads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      message_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_messages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.STRING(32), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      preview: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      applied_result: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_proposals', ['thread_id', 'status'], {
      name: 'chat_proposals_thread_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('chat_proposals', 'chat_proposals_thread_status');
    await queryInterface.dropTable('chat_proposals');
    await queryInterface.removeIndex('chat_messages', 'chat_messages_thread_id_id');
    await queryInterface.dropTable('chat_messages');
    await queryInterface.removeIndex('chat_threads', 'chat_threads_user_last_message');
    await queryInterface.dropTable('chat_threads');
  },
};

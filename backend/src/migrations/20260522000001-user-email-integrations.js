'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_email_integrations', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      account_email: { type: Sequelize.STRING(256), allowNull: true },
      access_token_encrypted: { type: Sequelize.TEXT, allowNull: false },
      refresh_token_encrypted: { type: Sequelize.TEXT, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      scopes: { type: Sequelize.TEXT, allowNull: true },
      last_scan_at: { type: Sequelize.DATE, allowNull: true },
      last_history_id: { type: Sequelize.STRING(128), allowNull: true },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'connected',
      },
      status_reason: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('user_email_integrations', ['user_id', 'provider'], {
      unique: true,
      name: 'user_email_integrations_user_provider',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'user_email_integrations',
      'user_email_integrations_user_provider',
    );
    await queryInterface.dropTable('user_email_integrations');
  },
};

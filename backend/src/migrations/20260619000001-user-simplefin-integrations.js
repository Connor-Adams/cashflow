'use strict';

/**
 * issue #790 — SimpleFIN Bridge connection credential store.
 * Creates `user_simplefin_integrations`, mirroring `user_email_integrations`:
 * one row per user (UNIQUE on user_id), holding the AES-256-GCM encrypted
 * SimpleFIN access URL plus a simple connection lifecycle. Dual-dialect
 * (SQLite + Postgres).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_simplefin_integrations', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      access_url_encrypted: { type: Sequelize.TEXT, allowNull: false },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'connected',
      },
      status_reason: { type: Sequelize.TEXT, allowNull: true },
      last_synced_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('user_simplefin_integrations', ['user_id'], {
      unique: true,
      name: 'user_simplefin_integrations_user_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'user_simplefin_integrations',
      'user_simplefin_integrations_user_id',
    );
    await queryInterface.dropTable('user_simplefin_integrations');
  },
};

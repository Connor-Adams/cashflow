'use strict';

/**
 * AI audit surface foundation (issue #387).
 *
 * Creates the `user_audit_tokens` table used by the cfa_ bearer-token system.
 * Each row is a long-lived read-only audit token scoped to a user; soft-revoke
 * via `revoked_at`. The composite index on (user_id, revoked_at) makes the
 * "list active tokens for user" query cheap.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_audit_tokens', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      label: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'Audit',
      },
      last_used_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      revoked_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'user_audit_tokens', ['user_id', 'revoked_at'], {
      name: 'user_audit_tokens_user_revoked',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_audit_tokens');
  },
};

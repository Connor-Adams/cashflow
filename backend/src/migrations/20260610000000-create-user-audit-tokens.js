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
    await queryInterface.createTable('user_audit_tokens', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: { type: Sequelize.STRING(64), allowNull: false },
      label: { type: Sequelize.STRING(64), allowNull: false },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'user_audit_tokens', ['token_hash'], {
      name: 'user_audit_tokens_token_hash_unique',
      unique: true,
    });
    await addIndex(queryInterface, 'user_audit_tokens', ['user_id', 'revoked_at'], {
      name: 'user_audit_tokens_user_active',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('user_audit_tokens');
  },
};

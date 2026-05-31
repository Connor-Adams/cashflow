'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_audit_tokens', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      token_hash: { type: Sequelize.STRING(64), allowNull: false },
      label: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'Audit' },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('user_audit_tokens', ['token_hash'], { unique: true });
    await queryInterface.addIndex('user_audit_tokens', ['user_id', 'revoked_at']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('user_audit_tokens');
  },
};

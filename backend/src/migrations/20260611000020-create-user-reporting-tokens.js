'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_reporting_tokens', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      token_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      label: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'Reporting',
      },
      last_used_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      revoked_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('user_reporting_tokens', ['token_hash'], {
      unique: true,
      name: 'user_reporting_tokens_token_hash_unique',
    });
    await queryInterface.addIndex('user_reporting_tokens', ['user_id', 'revoked_at'], {
      name: 'user_reporting_tokens_user_revoked',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_reporting_tokens');
  },
};

'use strict';

async function addColumn(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table);
  if (!desc[column]) {
    await queryInterface.addColumn(table, column, definition);
  }
}

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING(320), allowNull: false },
      display_name: { type: Sequelize.STRING(160), allowNull: false },
      global_role: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'user' },
      password_hash: { type: Sequelize.STRING(256), allowNull: false },
      password_salt: { type: Sequelize.STRING(128), allowNull: false },
      password_params: { type: Sequelize.STRING(128), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'users', ['email'], {
      name: 'users_email_unique',
      unique: true,
    });

    await queryInterface.createTable('households', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(160), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('household_members', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'member' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'household_members', ['household_id', 'user_id'], {
      name: 'household_members_household_user_unique',
      unique: true,
    });

    await queryInterface.createTable('sessions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: { type: Sequelize.STRING(128), allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'sessions', ['token_hash'], {
      name: 'sessions_token_hash_unique',
      unique: true,
    });
    await addIndex(queryInterface, 'sessions', ['user_id'], { name: 'sessions_user_id' });

    await queryInterface.createTable('household_invites', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: { type: Sequelize.STRING(128), allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      accepted_at: { type: Sequelize.DATE, allowNull: true },
      accepted_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'household_invites', ['token_hash'], {
      name: 'household_invites_token_hash_unique',
      unique: true,
    });

    await queryInterface.createTable('contacts', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(160), allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'contacts', ['household_id', 'name'], {
      name: 'contacts_household_name',
    });

    await addColumn(queryInterface, 'accounts', 'household_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'households', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
    await addColumn(queryInterface, 'accounts', 'owner_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await addColumn(queryInterface, 'accounts', 'visibility', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'private',
    });

    await addColumn(queryInterface, 'transactions', 'household_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'households', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
    await addColumn(queryInterface, 'transactions', 'created_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await addColumn(queryInterface, 'transactions', 'visibility', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'private',
    });
    await addColumn(queryInterface, 'transactions', 'ownership_type', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'me',
    });
    await addColumn(queryInterface, 'transactions', 'ownership_contact_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'contacts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.sequelize.query(
      `UPDATE transactions
       SET ownership_type = CASE final_split_type
         WHEN 'partner' THEN 'partner'
         WHEN 'shared' THEN 'shared'
         ELSE 'me'
       END`
    );

    await addColumn(queryInterface, 'rules', 'household_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'households', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
    await addColumn(queryInterface, 'rules', 'created_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await addColumn(queryInterface, 'import_histories', 'household_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'households', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
    await addColumn(queryInterface, 'import_histories', 'created_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await addIndex(queryInterface, 'accounts', ['household_id', 'visibility'], {
      name: 'accounts_household_visibility',
    });
    await addIndex(queryInterface, 'transactions', ['household_id', 'visibility', 'date'], {
      name: 'transactions_household_visibility_date',
    });
    await addIndex(queryInterface, 'transactions', ['ownership_type'], {
      name: 'transactions_ownership_type',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('import_histories', 'created_by_user_id');
    await queryInterface.removeColumn('import_histories', 'household_id');
    await queryInterface.removeColumn('rules', 'created_by_user_id');
    await queryInterface.removeColumn('rules', 'household_id');
    await queryInterface.removeColumn('transactions', 'ownership_contact_id');
    await queryInterface.removeColumn('transactions', 'ownership_type');
    await queryInterface.removeColumn('transactions', 'visibility');
    await queryInterface.removeColumn('transactions', 'created_by_user_id');
    await queryInterface.removeColumn('transactions', 'household_id');
    await queryInterface.removeColumn('accounts', 'visibility');
    await queryInterface.removeColumn('accounts', 'owner_user_id');
    await queryInterface.removeColumn('accounts', 'household_id');
    await queryInterface.dropTable('contacts');
    await queryInterface.dropTable('household_invites');
    await queryInterface.dropTable('sessions');
    await queryInterface.dropTable('household_members');
    await queryInterface.dropTable('households');
    await queryInterface.dropTable('users');
  },
};

'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('accounts', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: { type: Sequelize.STRING, allowNull: false },
      owner: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'me',
      },
      short_code: { type: Sequelize.STRING(64), allowNull: true },
      default_currency: { type: Sequelize.STRING(3), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('accounts', ['short_code'], {
      name: 'accounts_short_code',
      unique: false,
    });

    await queryInterface.createTable('rules', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      merchant_pattern: { type: Sequelize.STRING(512), allowNull: false },
      match_kind: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'substring',
      },
      priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      category: { type: Sequelize.STRING(128), allowNull: true },
      is_business: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      split_type: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'me',
      },
      pct_me: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      pct_partner: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('rules', ['priority'], { name: 'rules_priority' });

    await queryInterface.createTable('transactions', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      import_batch: { type: Sequelize.STRING(128), allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      merchant_raw: { type: Sequelize.STRING(1024), allowNull: false },
      merchant_clean: { type: Sequelize.STRING(1024), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      source_reference: { type: Sequelize.STRING(256), allowNull: true },
      source_row_fingerprint: { type: Sequelize.STRING(128), allowNull: false },

      auto_category: { type: Sequelize.STRING(128), allowNull: true },
      category_override: { type: Sequelize.STRING(128), allowNull: true },
      final_category: { type: Sequelize.STRING(128), allowNull: true },

      auto_business: { type: Sequelize.BOOLEAN, allowNull: true },
      business_override: { type: Sequelize.BOOLEAN, allowNull: true },
      final_business: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },

      auto_split_type: { type: Sequelize.STRING(16), allowNull: true },
      split_override: { type: Sequelize.STRING(16), allowNull: true },
      final_split_type: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'me' },

      auto_pct_me: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      pct_me_override: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      final_pct_me: { type: Sequelize.DECIMAL(5, 4), allowNull: true },

      auto_pct_partner: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      pct_partner_override: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      final_pct_partner: { type: Sequelize.DECIMAL(5, 4), allowNull: true },

      my_share_amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
      partner_share_amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
      business_amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },

      review_flag: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('transactions', ['account_id', 'date'], {
      name: 'transactions_account_id_date',
    });
    await queryInterface.addIndex('transactions', ['review_flag'], {
      name: 'transactions_review_flag',
    });
    await queryInterface.addIndex('transactions', ['import_batch'], {
      name: 'transactions_import_batch',
    });
    await queryInterface.addIndex('transactions', ['currency'], {
      name: 'transactions_currency',
    });
    await queryInterface.addIndex('transactions', ['account_id', 'source_row_fingerprint'], {
      unique: true,
      name: 'transactions_account_fingerprint_unique',
    });

    await queryInterface.createTable('import_histories', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      file_name: { type: Sequelize.STRING(512), allowNull: false },
      file_path_safe: { type: Sequelize.STRING(1024), allowNull: false },
      content_hash: { type: Sequelize.STRING(64), allowNull: false },
      batch_label: { type: Sequelize.STRING(256), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false },
      row_count: { type: Sequelize.INTEGER, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: false },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('import_histories', ['content_hash'], {
      name: 'import_histories_content_hash',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('import_histories');
    await queryInterface.dropTable('transactions');
    await queryInterface.dropTable('rules');
    await queryInterface.dropTable('accounts');
  },
};

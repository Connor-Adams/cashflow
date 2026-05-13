'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'account_type', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'checking',
    });
    await queryInterface.addIndex('accounts', ['account_type'], {
      name: 'accounts_account_type',
    });

    await queryInterface.createTable('securities', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: true },
      symbol: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(256), allowNull: true },
      asset_type: { type: Sequelize.STRING(64), allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('securities', ['household_id', 'symbol', 'currency'], {
      name: 'securities_household_symbol_currency_unique',
      unique: true,
    });

    await queryInterface.createTable('investment_activities', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: { type: Sequelize.INTEGER, allowNull: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      activity_type: { type: Sequelize.STRING(32), allowNull: false },
      trade_date: { type: Sequelize.DATEONLY, allowNull: false },
      settlement_date: { type: Sequelize.DATEONLY, allowNull: true },
      description: { type: Sequelize.STRING(1024), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      price: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      fees: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      source_reference: { type: Sequelize.STRING(256), allowNull: true },
      source_row_fingerprint: { type: Sequelize.STRING(128), allowNull: false },
      import_batch: { type: Sequelize.STRING(128), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('investment_activities', ['account_id', 'trade_date'], {
      name: 'investment_activities_account_date',
    });
    await queryInterface.addIndex('investment_activities', ['account_id', 'source_row_fingerprint'], {
      name: 'investment_activities_account_fingerprint_unique',
      unique: true,
    });

    await queryInterface.createTable('holdings_snapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: { type: Sequelize.INTEGER, allowNull: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      statement_date: { type: Sequelize.DATEONLY, allowNull: false },
      quantity: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      price: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      market_value: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      cost_basis: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      unrealized_gain_loss: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      source_reference: { type: Sequelize.STRING(256), allowNull: true },
      source_row_fingerprint: { type: Sequelize.STRING(128), allowNull: false },
      import_batch: { type: Sequelize.STRING(128), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('holdings_snapshots', ['account_id', 'statement_date'], {
      name: 'holdings_snapshots_account_date',
    });
    await queryInterface.addIndex('holdings_snapshots', ['account_id', 'source_row_fingerprint'], {
      name: 'holdings_snapshots_account_fingerprint_unique',
      unique: true,
    });

    await queryInterface.createTable('security_prices', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(64), allowNull: false },
      symbol: { type: Sequelize.STRING(64), allowNull: false },
      priced_at: { type: Sequelize.DATE, allowNull: false },
      price: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('security_prices', ['security_id', 'provider', 'priced_at'], {
      name: 'security_prices_security_provider_priced_at_unique',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('security_prices');
    await queryInterface.dropTable('holdings_snapshots');
    await queryInterface.dropTable('investment_activities');
    await queryInterface.dropTable('securities');
    await queryInterface.removeIndex('accounts', 'accounts_account_type');
    await queryInterface.removeColumn('accounts', 'account_type');
  },
};

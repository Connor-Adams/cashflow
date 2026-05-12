'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('external_orders', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      vendor: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'amazon' },
      vendor_order_id: { type: Sequelize.STRING(128), allowNull: true },
      dedupe_key: { type: Sequelize.STRING(256), allowNull: false },
      order_date: { type: Sequelize.DATEONLY, allowNull: true },
      shipment_date: { type: Sequelize.DATEONLY, allowNull: true },
      subtotal: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      tax: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      shipping: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      total: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'CAD' },
      payment_last4: { type: Sequelize.STRING(4), allowNull: true },
      source: { type: Sequelize.STRING(32), allowNull: false },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('external_orders', ['household_id', 'dedupe_key'], {
      unique: true,
      name: 'external_orders_household_dedupe_unique',
    });
    await queryInterface.addIndex('external_orders', ['household_id', 'vendor', 'vendor_order_id'], {
      name: 'external_orders_vendor_order',
    });
    await queryInterface.addIndex('external_orders', ['household_id', 'order_date'], {
      name: 'external_orders_household_order_date',
    });

    await queryInterface.createTable('external_order_items', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      external_order_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'external_orders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(1024), allowNull: false },
      quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      unit_price: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      total_price: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      inferred_category: { type: Sequelize.STRING(128), allowNull: true },
      business_use_percent: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      confidence: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('external_order_items', ['external_order_id'], {
      name: 'external_order_items_order_id',
    });

    await queryInterface.createTable('transaction_order_links', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      external_order_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'external_orders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      confidence: { type: Sequelize.DECIMAL(5, 2), allowNull: false },
      match_reason: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'suggested' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('transaction_order_links', ['transaction_id', 'external_order_id'], {
      unique: true,
      name: 'transaction_order_links_unique_pair',
    });
    await queryInterface.addIndex('transaction_order_links', ['status'], {
      name: 'transaction_order_links_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('transaction_order_links');
    await queryInterface.dropTable('external_order_items');
    await queryInterface.dropTable('external_orders');
  },
};

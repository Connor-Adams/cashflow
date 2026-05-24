'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('receipts', 'external_order_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'external_orders', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('receipts', ['external_order_id'], {
      name: 'receipts_external_order_id',
    });
    await queryInterface.addColumn('external_order_items', 'category_override', {
      type: Sequelize.STRING(128),
      allowNull: true,
    });
    await queryInterface.addColumn('external_order_items', 'business_use_override', {
      type: Sequelize.DECIMAL(5, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('external_order_items', 'business_use_override');
    await queryInterface.removeColumn('external_order_items', 'category_override');
    await queryInterface.removeIndex('receipts', 'receipts_external_order_id');
    await queryInterface.removeColumn('receipts', 'external_order_id');
  },
};

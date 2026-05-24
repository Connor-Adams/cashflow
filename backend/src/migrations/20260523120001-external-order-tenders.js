'use strict';
// fallow-ignore-file unused-file -- loaded at runtime by sequelize-cli, never imported

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('external_order_tenders', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      external_order_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'external_orders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      payment_last4: { type: Sequelize.STRING(4), allowNull: true },
      network: { type: Sequelize.STRING(32), allowNull: true },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('external_order_tenders', ['external_order_id'], {
      name: 'external_order_tenders_order_id',
    });
    await queryInterface.addIndex('external_order_tenders', ['payment_last4'], {
      name: 'external_order_tenders_last4',
    });

    await queryInterface.addColumn('transaction_order_links', 'linked_amount', {
      type: Sequelize.DECIMAL(14, 4),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transaction_order_links', 'linked_amount');
    await queryInterface.dropTable('external_order_tenders');
  },
};

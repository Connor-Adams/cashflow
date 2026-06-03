'use strict';
/**
 * costco_products: a shared, household-agnostic cache keyed by the global
 * Costco item_number. One row per item number ever seen on a receipt. The
 * resolver writes a terminal status:
 *   resolved   — verified product found; image_url/costco_url populated
 *   not_found  — searched, no product whose item number matched (e.g.
 *                warehouse-only items not on costco.com). Sticky: never re-queried.
 *   error      — transport/parse failure. Eligible for a bounded slow retry.
 *   pending    — reserved for future pre-seeding; the resolver writes terminal states.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('costco_products', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      item_number: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      image_url: { type: Sequelize.STRING(1024), allowNull: true, defaultValue: null },
      costco_url: { type: Sequelize.STRING(1024), allowNull: true, defaultValue: null },
      official_name: { type: Sequelize.STRING(512), allowNull: true, defaultValue: null },
      online_price: { type: Sequelize.DECIMAL(14, 4), allowNull: true, defaultValue: null },
      source: { type: Sequelize.STRING(64), allowNull: true, defaultValue: null },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      fetched_at: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('costco_products', ['status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('costco_products');
  },
};

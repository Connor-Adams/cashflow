'use strict';
/**
 * Costco receipt item readability (#costco-item-names):
 *  - display_name: AI-expanded human-readable product name
 *    ("Kirkland Signature Organic Peanut Butter" for "KS ORG PNT BTR").
 *    Null = no expansion yet; UI falls back to `title`.
 *  - display_name_confidence: 0-100 model confidence in the expansion.
 *  - item_number: vendor SKU/item number the parser already captures
 *    (Costco item number) but previously dropped at persist.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('external_order_items', 'display_name', {
      type: Sequelize.STRING(512),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('external_order_items', 'display_name_confidence', {
      type: Sequelize.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('external_order_items', 'item_number', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('external_order_items', 'item_number');
    await queryInterface.removeColumn('external_order_items', 'display_name_confidence');
    await queryInterface.removeColumn('external_order_items', 'display_name');
  },
};

'use strict';
/**
 * costco_products.verified: whether the cached product was confirmed to match
 * the receipt's item number (true) or is a best-effort guess from a source that
 * could not return the item number, e.g. Google image search (false). The
 * strict Unwrangle path always sets true. Existing rows are verified (the only
 * prior writer was the strict path), so backfill defaultValue: true.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('costco_products', 'verified', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('costco_products', 'verified');
  },
};

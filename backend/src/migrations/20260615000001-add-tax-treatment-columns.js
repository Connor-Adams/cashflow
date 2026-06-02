'use strict';
/** Category-driven tax treatment: a per-category default + a per-transaction
 * override consumed by buildPersonalFacts. See
 * docs/superpowers/specs/2026-06-01-tax-category-treatment-design.md */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('categories', 'tax_treatment', {
      type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none',
    });
    await queryInterface.addColumn('transactions', 'tax_treatment_override', {
      type: Sequelize.STRING(32), allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'tax_treatment_override');
    await queryInterface.removeColumn('categories', 'tax_treatment');
  },
};

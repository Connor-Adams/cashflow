'use strict';
/** Corp -> owner (personal shareholder) link, drives dividend auto-flow to the
 * owner's T1 in computeHouseholdPlan. See
 * docs/superpowers/specs/2026-06-01-corp-dividend-autoflow-design.md */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'owner_entity_id', {
      type: Sequelize.INTEGER, allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'owner_entity_id');
  },
};

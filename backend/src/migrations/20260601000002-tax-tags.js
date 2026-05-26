'use strict';

/**
 * Tax tags — per-household user-defined labels for business/tax-relevant
 * transactions. The issue body uses `user_id` but cashflow's data-scoping
 * convention is per-household (see budget_targets, contacts, partner_settlements),
 * so tags live at the household level so a couple/sole-prop can share them.
 *
 * Unique (household_id, name) keeps the picker tidy. Name is short (<= 64) and
 * required; description is free-form prose (TEXT, optional).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_tags', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(64), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tax_tags', ['household_id'], {
      name: 'tax_tags_household_id',
    });
    await queryInterface.addIndex('tax_tags', ['household_id', 'name'], {
      name: 'tax_tags_household_name_unique',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('tax_tags', 'tax_tags_household_name_unique');
    await queryInterface.removeIndex('tax_tags', 'tax_tags_household_id');
    await queryInterface.dropTable('tax_tags');
  },
};

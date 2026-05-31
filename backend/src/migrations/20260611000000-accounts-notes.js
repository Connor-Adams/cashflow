'use strict';

/**
 * Add notes field to accounts (#312).
 * Stores free-form markdown text. Max 4000 chars enforced at the route layer.
 * Additive + reversible.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'notes', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('accounts', 'notes');
  },
};

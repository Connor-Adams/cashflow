'use strict';

/**
 * Adds a nullable comma-separated `aliases` column to `contacts`. Feeds the
 * term-based transfer link pass (per-person loan ledger): a contact's aliases
 * plus its name become the substrings matched against transfer merchant text.
 *
 * Null/empty means "match on name only". Runs on SQLite + Postgres.
 *
 * Spine note: extends the existing Contact primitive with a field; NOT a new
 * primitive.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'aliases', {
      type: Sequelize.STRING(500),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'aliases');
  },
};

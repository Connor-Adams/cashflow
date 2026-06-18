'use strict';

/**
 * Adds a nullable-but-defaulted boolean `is_self` column to `contacts`. Marks a
 * contact as the user's own identity (e.g. "Connor Adams RBC"). Confirmed self-
 * accounts are excluded from the transfer-link pass — you can't owe yourself.
 * User flow: auto-suggest via name-token overlap → user confirms → link pass
 * skips them permanently.
 *
 * Spine note: extends the existing Contact primitive with a field; NOT a new
 * primitive. Self-account is a variant/view of Contact, not a new status machine.
 *
 * Runs on SQLite + Postgres (dialect-agnostic).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'is_self', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'is_self');
  },
};

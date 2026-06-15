'use strict';

/**
 * Adds a nullable `timezone` column (IANA string, e.g. 'America/Toronto') to
 * `households` for per-household server-side "today" derivation (audit-cleanup
 * wave 3, 2026-06-09 math/import audit).
 *
 * Null means fall back to DEFAULT_TIMEZONE ('America/Toronto') — see
 * backend/src/time/householdToday.ts. Runs on SQLite + Postgres.
 *
 * Spine note: this extends the existing Household primitive with a field; it is
 * NOT a new primitive.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('households', 'timezone', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('households', 'timezone');
  },
};

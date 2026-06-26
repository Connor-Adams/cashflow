'use strict';

/**
 * Add an optimistic-lock `version` column to `budget_targets` (issue #848).
 *
 * `BudgetTarget` previously had no `version: true`, no row lock, and a blind
 * read-modify-write on both its PUT and PATCH handlers (which were byte-
 * identical). Two concurrent edits — e.g. `PATCH {amount}` and `PUT {scope}` —
 * each loaded a full instance and wrote it back, so the slower save clobbered
 * the other field with a stale value (the config lost-update bug). Targeted
 * column updates (`row.update(patch)`) now persist only the patched columns, and
 * enabling Sequelize optimistic locking (`version: true`) makes any remaining
 * full-instance save carry `WHERE version = N`, so a stale write fails loudly
 * (OptimisticLockError) instead of silently clobbering.
 *
 * Dialect-portable single addColumn — runs verbatim on SQLite (tests) and
 * Postgres (prod). Default 0 backfills every existing row.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('budget_targets', 'version', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('budget_targets', 'version');
  },
};

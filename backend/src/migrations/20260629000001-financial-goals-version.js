'use strict';

/**
 * Add an optimistic-lock `version` column to `financial_goals` (issue #845).
 *
 * `FinancialGoal` previously had no `version: true`, no row lock, and no
 * transaction around its read-modify-write PUT. Two concurrent contributions
 * both read the same `current_amount`, both wrote a blind total, and one
 * contribution was silently lost. Enabling Sequelize optimistic locking
 * (`version: true`) makes full-instance saves carry `WHERE version = N`, so a
 * stale write fails loudly (OptimisticLockError) instead of clobbering.
 *
 * Dialect-portable single addColumn — runs verbatim on SQLite (tests) and
 * Postgres (prod). Default 0 backfills every existing row.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('financial_goals', 'version', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('financial_goals', 'version');
  },
};

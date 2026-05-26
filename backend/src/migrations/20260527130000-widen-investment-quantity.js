'use strict';

/**
 * Widen `investment_activities.quantity` from DECIMAL(20, 8) to DECIMAL(28, 10).
 *
 * Wealthsimple's activities-export emits up to 10 decimal places on crypto
 * staking rewards (e.g. 0.0000379611 ETH). The previous DECIMAL(20, 8)
 * column silently truncated the last two decimals on insert, breaking
 * cross-source identity-tuple comparison between the activities-export
 * importer and the monthly statement importer.
 *
 * Dialect notes:
 *   - Postgres: `ALTER COLUMN TYPE` on DECIMAL widening is a metadata-only
 *     operation (no row rewrite), so this runs in O(1) regardless of table
 *     size.
 *   - SQLite: column types are advisory (DECIMAL has TEXT affinity and
 *     ignores precision/scale), so the (20, 8) constraint never applied.
 *     `ALTER COLUMN ... TYPE` is not supported by SQLite at all and would
 *     fail the migration in CI, where backend tests run against SQLite.
 *     Skipping the DDL on SQLite is a no-op semantically.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    if (queryInterface.sequelize.getDialect() !== 'postgres') return;
    await queryInterface.sequelize.query(
      'ALTER TABLE investment_activities ALTER COLUMN quantity TYPE DECIMAL(28, 10)',
    );
  },

  async down(queryInterface) {
    if (queryInterface.sequelize.getDialect() !== 'postgres') return;
    await queryInterface.sequelize.query(
      'ALTER TABLE investment_activities ALTER COLUMN quantity TYPE DECIMAL(20, 8)',
    );
  },
};

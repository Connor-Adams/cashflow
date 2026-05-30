'use strict';

/**
 * Adds `last_seen_changelog_version` (VARCHAR(64), nullable) to
 * `cashflow_settings` for issue #294 (in-app What's New changelog surface).
 *
 * Stores the version string of the last changelog entry the user has
 * acknowledged. NULL means the user has never seen the changelog modal.
 * Format: YYYY-MM-DD-N (e.g. "2026-05-30-1").
 *
 * Fully reversible: `down` drops the column with no data dependency.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('cashflow_settings', 'last_seen_changelog_version', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('cashflow_settings', 'last_seen_changelog_version');
  },
};

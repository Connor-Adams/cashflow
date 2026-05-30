'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Adds `onboarding_dismissed_at` (TIMESTAMP, nullable, default NULL) to
 * `cashflow_settings` for issue #259 (first-run onboarding wizard).
 *
 * When NULL, the user has neither dismissed nor completed onboarding, so the
 * first-run import-creates-accounts wizard is eligible to show (gated also on
 * `active accounts === 0`). A non-NULL timestamp permanently suppresses the
 * wizard — set when the user clicks "Skip for now" via
 * PATCH /api/preferences/onboarding-dismiss.
 *
 * Per-user because cashflow_settings is per-user (user_id UNIQUE). Fully
 * reversible: `down` drops the column with no data dependency.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'cashflow_settings',
      'onboarding_dismissed_at',
      {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(
      'cashflow_settings',
      'onboarding_dismissed_at',
    );
  },
};

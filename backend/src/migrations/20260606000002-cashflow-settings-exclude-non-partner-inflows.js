'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Adds `exclude_non_partner_inflows` (BOOLEAN, default true) to
 * `cashflow_settings` for issue #375.
 *
 * Drives the Partner Fairness dashboard toggle that hides positive-amount
 * shared rows whose `counterparty_contact_id` does NOT reference a
 * partner Contact. Defaults to true — the user's stated mental model is
 * "money my partner paid in", so we default to the cleaner view and let
 * the user flip it off to inspect every inflow.
 *
 * Column is per-user because cashflow_settings is per-user. The issue's
 * "per household" phrasing is shorthand for "household-level UX"; the
 * underlying storage is per-user, matching the rest of the safe-to-spend
 * knobs.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'cashflow_settings',
      'exclude_non_partner_inflows',
      {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(
      'cashflow_settings',
      'exclude_non_partner_inflows',
    );
  },
};

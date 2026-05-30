'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * Adds `is_partner` to `contacts` (issue #375 — followup to #372).
 *
 * Partner fairness needs a way to tell "this Contact is the household's
 * partner" from "this Contact is the dentist". Once that bit exists, the
 * fairness route can split inflows whose counterparty_contact_id points
 * at a partner Contact (true partner inflow) from the rest (side gig,
 * friend repaying lunch, family gift), and the dashboard can default to
 * excluding the non-partner inflows from the fairness rollup.
 *
 * Column is BOOLEAN, NOT NULL, DEFAULT false. The issue calls for a
 * backfill of "the household's existing partner Contact (if discoverable
 * from household config) — otherwise no-op". The current Cashflow data
 * model has no household-level partner pointer (HouseholdPlan only
 * carries name + notes), so the backfill is a guaranteed no-op today.
 * Leaving the hook here as a SELECT NULL so future migrations have a
 * documented place to extend if a household.partnerContactId is ever
 * added.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'is_partner', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Backfill hook: no-op today (no household.partnerContactId exists).
    // Future-proof in case a household-level partner pointer is added.
    // The SELECT runs but its result is intentionally discarded.
    try {
      await queryInterface.sequelize.query(
        `SELECT 1 FROM contacts WHERE 0`,
      );
    } catch {
      // Ignore — defensive only.
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'is_partner');
  },
};

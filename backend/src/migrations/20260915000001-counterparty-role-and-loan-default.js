'use strict';

/**
 * People ledger phase 1. Adds the two discriminators that decide whether a
 * transfer creates a debt.
 *
 *   - transactions.counterparty_role STRING(16): what this transfer means
 *     between the user and another person — loan, repayment, purchase,
 *     business, rent, gift, self — or, on a line-of-credit interest charge,
 *     loc_interest to mark it allocatable. Null means untagged, in which case
 *     the contact's loan_default decides.
 *   - contacts.loan_default BOOLEAN: treat this person's untagged transfers as
 *     loans. False keeps existing behaviour of contributing nothing.
 *
 * NOT to be confused with transactions.transfer_purpose (issue #222), which
 * carries owner_draw/owner_contribution/reimbursement/investment/internal/
 * income and describes movement between the user's OWN accounts. Eleven rows
 * are both contact-linked and pair-linked, so the vocabularies must not share
 * a column.
 *
 * Spine note: discriminator fields on the existing Transaction and
 * Counterparty primitives. No new primitive, no new status machine.
 *
 * Both columns are additive and defaulted, so no backfill is required.
 * Dialect-agnostic: runs on SQLite and Postgres.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'counterparty_role', {
      type: Sequelize.STRING(16),
      allowNull: true,
    });
    await queryInterface.addColumn('contacts', 'loan_default', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'loan_default');
    await queryInterface.removeColumn('transactions', 'counterparty_role');
  },
};

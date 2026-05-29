'use strict';

/**
 * Adds counterparty (source/dest) columns to `transactions` for #372.
 *
 * Two new nullable columns:
 *   - `counterparty_raw` TEXT — verbatim string extracted from the
 *     statement line (e.g. "JANE DOE" parsed from
 *     "INTERAC E-TFR FROM JANE DOE"). Set by the import pipeline only
 *     for accounts whose accountType is checking/savings/cash.
 *   - `counterparty_contact_id` INTEGER — optional structured link to
 *     `contacts.id`. Populated by the promote endpoint when the user
 *     chooses to bind the raw name to a Contact.
 *
 * Both nullable, no backfill. Legacy rows stay NULL. Out-of-scope
 * account types (credit_card, loan, investment) stay NULL even on new
 * imports because the extractor returns null for them.
 *
 * No FK constraint on counterparty_contact_id intentionally: the import
 * path runs against an SQLite test harness where the parent `contacts`
 * table is not always present, and the application enforces the
 * relationship at the route layer. Mirrors the same choice made for
 * ownership_contact_id.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'counterparty_raw', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('transactions', 'counterparty_contact_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'counterparty_contact_id');
    await queryInterface.removeColumn('transactions', 'counterparty_raw');
  },
};

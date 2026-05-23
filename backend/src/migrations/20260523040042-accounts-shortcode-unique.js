'use strict';

/**
 * Unique index on (household_id, short_code) so that Account.findOrCreate by
 * { householdId, shortCode } is race-safe — used by the Wealthsimple
 * bundle-import flow to auto-create accounts keyed off the WS account ID
 * embedded in the filename.
 *
 * NULL semantics: both Postgres and SQLite treat NULLs as distinct in unique
 * indexes by default, so multiple accounts with shortCode = NULL remain
 * allowed (matches existing behavior for non-WS accounts).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('accounts', ['household_id', 'short_code'], {
      unique: true,
      name: 'idx_accounts_household_shortcode',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('accounts', 'idx_accounts_household_shortcode');
  },
};

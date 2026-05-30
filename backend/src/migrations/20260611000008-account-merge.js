'use strict';

/**
 * Account merge and consolidation (issue #287).
 *
 * Adds `merged_into_id` and `merged_at` columns to `accounts` so a source
 * account can be tombstoned after all its transactions have been moved to a
 * target account. The merge service sets these atomically in the same
 * transaction that re-parents the transactions.
 *
 * Schema choices:
 * - `merged_into_id` is BIGINT (matches id col) with ON DELETE RESTRICT so we
 *   cannot delete a target account while a source still points at it.
 * - `merged_at` is a plain TIMESTAMP (not DATEONLY) so we have an audit trail
 *   with sub-day resolution.
 * - Both columns are nullable; NULL means the account has never been merged.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'merged_into_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'accounts',
        key: 'id',
      },
      onDelete: 'RESTRICT',
    });

    await queryInterface.addColumn('accounts', 'merged_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addIndex('accounts', ['merged_into_id'], {
      name: 'accounts_merged_into_id',
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex('accounts', 'accounts_merged_into_id');
    await queryInterface.removeColumn('accounts', 'merged_at');
    await queryInterface.removeColumn('accounts', 'merged_into_id');
  },
};

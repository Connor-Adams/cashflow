'use strict';

/**
 * Add merge-related columns to accounts table (issue #287).
 *
 * Adds soft-merge support:
 *   - merged_into_id BIGINT NULL FK→accounts.id ON DELETE RESTRICT
 *   - merged_at TIMESTAMP NULL
 *   - Index on (merged_into_id) for "find sources merged into me" queries
 *
 * When merged_into_id is set, the source account is hidden from default
 * GET /api/accounts calls and shown only if ?includeMerged=true.
 * The source remains readable for audit.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add merged_into_id column
    await queryInterface.addColumn('accounts', 'merged_into_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'accounts',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });

    // Add merged_at column
    await queryInterface.addColumn('accounts', 'merged_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });

    // Add index on merged_into_id for the "find sources merged into this target" query
    await queryInterface.addIndex('accounts', ['merged_into_id'], {
      name: 'accounts_merged_into_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_merged_into_id');
    await queryInterface.removeColumn('accounts', 'merged_at');
    await queryInterface.removeColumn('accounts', 'merged_into_id');
  },
};

'use strict';

/**
 * Renames the signal source from 'amazon-items' to 'item-link' on existing
 * rows so the new generalised vendor-agnostic naming is consistent across
 * code and data.
 *
 * Rollback restores the old name (purely cosmetic — both versions of the
 * code accept either string at runtime once enums are updated, but the
 * rollback path is here for completeness).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkUpdate(
      'transactions',
      { auto_source: 'item-link' },
      { auto_source: 'amazon-items' },
    );
    await queryInterface.bulkUpdate(
      'transaction_signals',
      { source: 'item-link' },
      { source: 'amazon-items' },
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'transaction_signals',
      { source: 'amazon-items' },
      { source: 'item-link' },
    );
    await queryInterface.bulkUpdate(
      'transactions',
      { auto_source: 'amazon-items' },
      { auto_source: 'item-link' },
    );
  },
};

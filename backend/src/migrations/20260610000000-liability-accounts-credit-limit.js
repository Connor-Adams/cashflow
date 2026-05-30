'use strict';

/**
 * Credit limit + utilization (#437) — extend `liability_accounts`.
 *
 * Adds `credit_limit` to the existing liability sidecar (#202, #243) so the
 * AccountsPage row + Dashboard summary can show utilization. The column is
 * meaningful only when the parent account's `account_type` is `credit_card`;
 * other liability kinds (loan, mortgage) ignore it. App-level validation
 * enforces `> 0 or null` (no DB CHECK, to stay consistent with the rest of
 * this codebase which validates money columns in route handlers).
 *
 * Additive + reversible.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('liability_accounts', 'credit_limit', {
      type: Sequelize.DECIMAL(14, 4),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('liability_accounts', 'credit_limit');
  },
};

'use strict';

/**
 * Credit-card payment planner (#243) — extend `liability_accounts` (#202).
 *
 * #202 already models a 1:1 liability sidecar for credit_card | loan | mortgage
 * accounts, holding interest_rate, minimum_payment, statement_balance, due_day.
 * #243 is *operational* bill management (distinct from #202's payoff strategy),
 * so it adds the credit-card billing fields that have nowhere else to live:
 *
 *   - statement_date      DATEONLY, nullable. When the current statement closed
 *                         (the date the statement_balance was struck).
 *   - autopay_enabled     BOOLEAN, NOT NULL default false. Whether the card is
 *                         on autopay.
 *   - autopay_type        STRING(16), nullable. full | minimum | fixed — how
 *                         much autopay draws. NULL when autopay is off.
 *   - autopay_amount      DECIMAL(14,4), nullable. The fixed draw when
 *                         autopay_type = 'fixed'.
 *   - payment_account_id  INTEGER FK accounts(id), nullable. The cash account
 *                         the bill is paid from. ON DELETE SET NULL — deleting
 *                         the funding account leaves the profile intact, just
 *                         unlinks it (mirrors PlannedEvent.linked_transaction_id
 *                         and Reimbursement's SET NULL links).
 *
 * Additive + reversible: `up` adds the five columns, `down` drops them, leaving
 * the #202 columns untouched.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('liability_accounts', 'statement_date', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('liability_accounts', 'autopay_enabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('liability_accounts', 'autopay_type', {
      type: Sequelize.STRING(16),
      allowNull: true,
    });
    await queryInterface.addColumn('liability_accounts', 'autopay_amount', {
      type: Sequelize.DECIMAL(14, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('liability_accounts', 'payment_account_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'accounts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('liability_accounts', 'payment_account_id');
    await queryInterface.removeColumn('liability_accounts', 'autopay_amount');
    await queryInterface.removeColumn('liability_accounts', 'autopay_type');
    await queryInterface.removeColumn('liability_accounts', 'autopay_enabled');
    await queryInterface.removeColumn('liability_accounts', 'statement_date');
  },
};

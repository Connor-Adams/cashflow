'use strict';

/**
 * Cashflow settings table (issue #199).
 *
 * Per-user knobs that drive the safe-to-spend calculation:
 * - minimum_cash_buffer: amount to keep parked / "untouchable"; subtracted
 *   from safe-to-spend so the user is never told to spend their floor.
 *   DECIMAL(14,4) to match every other money column; route layer rejects
 *   negatives.
 * - safe_to_spend_window_days: how far into the future the calculation
 *   reaches for "upcoming required expenses". Default 14 — a paycheck-cycle
 *   window. Bounded by the route layer (1..365).
 * - include_credit_card_balance: when true, the sum of credit-card account
 *   balances (sign-flipped to a positive expected-payment amount) is
 *   subtracted. When false, the user is treating CC payments as already
 *   accounted for elsewhere (e.g. autopay tied to a checking-account
 *   planned event).
 * - include_goal_contributions: when true, the required monthly contribution
 *   total from active financial_goals (#203) is subtracted. When false, the
 *   user opts out of treating savings as a forced expense.
 *
 * One row per user (user_id UNIQUE). Row is created lazily on the first
 * PATCH — no backfill needed; GET returns the defaults bundle when no row
 * exists.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('cashflow_settings', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      minimum_cash_buffer: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
        defaultValue: 0,
      },
      safe_to_spend_window_days: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 14,
      },
      include_credit_card_balance: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      include_goal_contributions: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'cashflow_settings', ['user_id'], {
      name: 'cashflow_settings_user_id',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('cashflow_settings');
  },
};

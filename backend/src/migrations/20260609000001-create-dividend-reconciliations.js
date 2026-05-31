'use strict';

/**
 * Dividend reconciliation join table — `dividend_reconciliations` (#305).
 *
 * Links an expected payout (`security_dividends`, keyed by security only) to
 * the cash `transactions` row that received it, scoped to one holding
 * `accounts` row. A join table (rather than a single FK on `security_dividends`)
 * is required because securities are global — one expected dividend applies to
 * every account/household holding the security. See the issue body's explicit
 * "use a join table — start with single match for v1" allowance.
 *
 * FK delete semantics:
 *   security_dividend_id   CASCADE  — dropping the dividend fact drops its
 *                                     reconciliations.
 *   account_id             CASCADE  — account teardown removes its rows.
 *   household_id           CASCADE  — household teardown removes its rows.
 *   matched_transaction_id SET NULL — deleting the matched transaction leaves
 *                                     the reconciliation row but clears the
 *                                     link (so it reverts to "needs review").
 *
 * Reversible: `down` drops the table.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('dividend_reconciliations', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      security_dividend_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'security_dividends', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      matched_transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      matched_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      match_source: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'auto',
      },
      expected_amount: {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: true,
      },
      shares: {
        type: Sequelize.DECIMAL(28, 10),
        allowNull: true,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: true,
      },
      notified_unmatched_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    // One reconciliation row per (dividend, holding account).
    await addIndex(
      queryInterface,
      'dividend_reconciliations',
      ['security_dividend_id', 'account_id'],
      { name: 'dividend_reconciliations_dividend_account', unique: true },
    );
    await addIndex(
      queryInterface,
      'dividend_reconciliations',
      ['matched_transaction_id'],
      { name: 'dividend_reconciliations_matched_transaction' },
    );
    await addIndex(
      queryInterface,
      'dividend_reconciliations',
      ['household_id', 'matched_at'],
      { name: 'dividend_reconciliations_household_matched_at' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('dividend_reconciliations');
  },
};

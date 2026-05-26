'use strict';

/**
 * Statement reconciliation table — `account_statements` (#242).
 *
 * One row per imported or manually-created statement period for a single
 * account. The reconciliation flow compares the statement's reported
 * closing balance against the sum of transactions in the same period
 * (plus opening balance), surfacing any variance to the user.
 *
 * Schema decisions:
 *  - `(account_id, period_start, period_end)` UNIQUE prevents duplicate
 *    statement periods for the same account. The user can still load
 *    multiple statements for an account so long as they cover different
 *    windows.
 *  - `opening_balance` / `closing_balance` are DECIMAL(18,4) for lossless
 *    money math (matches `accounts.opening_balance` precision).
 *  - `reconciled_at` is nullable — a NULL means the user has not yet
 *    accepted the variance (or the math doesn't yet balance). The route
 *    layer enforces reconcile-only-when-variance-explained-or-zero.
 *  - `variance_explanation` is TEXT (nullable). Required at reconcile
 *    time when variance is non-zero, but enforced at the route, not the
 *    DB, so historic rows imported via backfill don't need to backfill it.
 *  - `source_filename` is nullable so manual statement entries (no
 *    underlying file) work alongside PDF-imported statements.
 *  - `visibility` mirrors the Account/Transaction model — a 'private'
 *    statement is visible only to its creator, 'shared' is visible to
 *    the whole household.
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
    await queryInterface.createTable('account_statements', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      visibility: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'shared',
      },
      period_start: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      period_end: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      opening_balance: {
        type: Sequelize.DECIMAL(18, 4),
        allowNull: false,
        defaultValue: 0,
      },
      closing_balance: {
        type: Sequelize.DECIMAL(18, 4),
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
        defaultValue: 'CAD',
      },
      source_filename: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      reconciled_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      variance_explanation: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'account_statements', ['household_id'], {
      name: 'account_statements_household_id',
    });
    await addIndex(queryInterface, 'account_statements', ['account_id'], {
      name: 'account_statements_account_id',
    });
    await addIndex(
      queryInterface,
      'account_statements',
      ['account_id', 'period_start', 'period_end'],
      {
        name: 'account_statements_account_period_unique',
        unique: true,
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('account_statements');
  },
};

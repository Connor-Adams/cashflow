'use strict';

/**
 * `account_rate_periods` — the interest-rate windows printed on a statement
 * (docs/superpowers/plans/2026-09-14-loc-rate-history.md, Task 2).
 *
 * Spine note: this is reference data hanging off the Account primitive --
 * the same shape as FxRate or SecurityPrice, and a period child exactly as
 * AccountStatement already is. A rate window has no lifecycle of its own
 * (it is never created, transitioned, or resolved -- it just describes what
 * a statement said applied over a dated window), so it introduces no status
 * machine and is NOT a new primitive.
 *
 * Columns mirror `parseRbcCreditLineRates`'s PdfRatePeriod shape
 * (backend/src/import/pdf/types.ts): fromDate/toDate are ISO dates,
 * primeRate/premium/effectiveRate/applicableInterest are fixed-4 decimal
 * strings to avoid float drift when a rate is later multiplied against a
 * balance (real money). `prime_rate`/`premium` are nullable -- some
 * statements only ever print the resulting `effective_rate`, which is the
 * one column that is always required.
 *
 * `source_statement_id` is a nullable FK to `account_statements` (SET NULL
 * on delete, like other provenance-only references in this codebase) so a
 * rate row is not destroyed if its source statement record is later removed.
 *
 * Uniqueness: UNIQUE(account_id, from_date). Connor imports these
 * statements by hand and some overlap or get re-imported; this index is
 * what makes the Task 3 upsert idempotent instead of duplicating a rate
 * window on every re-import.
 *
 * Dual-dialect (SQLite + Postgres). Down drops the table.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('account_rate_periods', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
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
      from_date: { type: Sequelize.DATEONLY, allowNull: false },
      to_date: { type: Sequelize.DATEONLY, allowNull: false },
      prime_rate: { type: Sequelize.DECIMAL(8, 4), allowNull: true },
      premium: { type: Sequelize.DECIMAL(8, 4), allowNull: true },
      effective_rate: { type: Sequelize.DECIMAL(8, 4), allowNull: false },
      applicable_interest: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      source_statement_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'account_statements', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('account_rate_periods', ['account_id', 'from_date'], {
      unique: true,
      name: 'account_rate_periods_account_from_date',
    });
    await queryInterface.addIndex('account_rate_periods', ['household_id'], {
      name: 'account_rate_periods_household_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('account_rate_periods', 'account_rate_periods_household_id');
    await queryInterface.removeIndex(
      'account_rate_periods',
      'account_rate_periods_account_from_date',
    );
    await queryInterface.dropTable('account_rate_periods');
  },
};

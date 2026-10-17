'use strict';

/**
 * Give an allocated-interest Reimbursement the provenance it actually has.
 *
 * `20260916000001-reimbursement-interest-rows.js` added `kind` and
 * `source_transaction_id` on the assumption that interest would be apportioned
 * from each `LOAN INTEREST` charge transaction. The method changed before it was
 * ever wired: interest is now apportioned per **rate window** off the statement's
 * Rate History table, because the window carries the rate and the printed
 * Applicable Interest, and the activity table's `Interest Payment` row lags a
 * cycle (see "Two figures, never merged" in
 * `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`).
 *
 * `source_transaction_id` cannot express a rate window, and not merely by name:
 *
 *   - Its partial unique index is `(source_transaction_id, contact_id)`. Putting
 *     an `account_rate_periods.id` in a column that elsewhere holds a
 *     `transactions.id` puts two id spaces in one uniqueness namespace, so
 *     window 9 and transaction 9 would collide for the same contact.
 *   - A statement period can print TWO rate windows when prime moves mid-cycle,
 *     so windows are not 1:1 with charges even in principle.
 *   - The windows run past the last charge (16 windows to 2026-09-03; the last
 *     `LOAN INTEREST` charge is 2026-07-06), so anchoring on a charge would
 *     silently drop the most recent charged interest.
 *
 * So: `source_rate_period_id`, with the uniqueness moved onto it.
 * `source_transaction_id` is kept — a charge-anchored interest row is still a
 * coherent thing and the column is already shipped — but the allocator does not
 * write it.
 *
 * `transaction_id` is relaxed to NULL for the same reason. A reimbursement is
 * normally "money expected back for outlay X"; an interest row is money expected
 * back for a *period*, and there is no single outlay behind it. Nulling it is
 * honest; picking an arbitrary loan row to point at would not be. Principal rows
 * are unaffected and every writer of them still supplies one.
 *
 * Spine note: provenance fields on the existing Expectation primitive (physical
 * table `reimbursements`), discriminated by the existing `kind`. No new
 * primitive.
 *
 * Dialect-agnostic: runs on SQLite and Postgres — but see `withIndexesPreserved`.
 */

/**
 * Run a schema change that SQLite can only do by rebuilding the table, without
 * losing the table's indexes.
 *
 * Postgres alters in place, so this is a pass-through there. SQLite has no ALTER
 * COLUMN and no DROP COLUMN (in the version Sequelize targets), so `changeColumn`
 * and `removeColumn` are emulated by recreating the table from `describeTable` —
 * and that rebuild is destructive in two ways this table cannot survive:
 *
 *   1. It DROPS every index on the table.
 *   2. `describeTable` reports a UNIQUE index as a per-column flag, so a
 *      COMPOSITE unique index comes back as a column-level UNIQUE on each of its
 *      columns. The partial unique index on `(source_transaction_id, contact_id)`
 *      would therefore become `contact_id INTEGER UNIQUE` — one reimbursement per
 *      contact, ever, and the rebuild's own data copy fails the moment two claims
 *      share a contact. Verified, not theoretical.
 *
 * So on SQLite the indexes are captured from `sqlite_master`, dropped, the change
 * applied, and the exact original DDL replayed. Read from the catalogue rather
 * than hardcoded, so a later migration adding an index needs no edit here.
 * (Column FKs declared in the original CREATE TABLE are still lost to the
 * rebuild; SQLite is a dev-only dialect here and does not enforce them by
 * default anyway.)
 */
async function withIndexesPreserved(queryInterface, table, apply) {
  if (queryInterface.sequelize.getDialect() !== 'sqlite') {
    await apply();
    return;
  }
  const [indexes] = await queryInterface.sequelize.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`,
  );
  for (const index of indexes) {
    await queryInterface.sequelize.query(`DROP INDEX \`${index.name}\``);
  }
  await apply();
  for (const index of indexes) {
    await queryInterface.sequelize.query(index.sql);
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reimbursements', 'source_rate_period_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'account_rate_periods', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
    // An interest row is derived from a rate window, not from an outlay. Done
    // BEFORE the new index is added so there is one less index to shuttle.
    await withIndexesPreserved(queryInterface, 'reimbursements', () =>
      queryInterface.changeColumn('reimbursements', 'transaction_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
      }));
    await queryInterface.addIndex('reimbursements', ['source_rate_period_id', 'contact_id'], {
      unique: true,
      name: 'idx_reimbursements_interest_rate_period',
      where: { source_rate_period_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('reimbursements', 'idx_reimbursements_interest_rate_period');
    // Interest rows are the only rows with a null outlay; drop them before
    // restoring NOT NULL, or the constraint cannot be re-applied. They are
    // derived data — the allocator regenerates them.
    await queryInterface.sequelize.query(
      'DELETE FROM reimbursements WHERE transaction_id IS NULL',
    );
    await withIndexesPreserved(queryInterface, 'reimbursements', async () => {
      await queryInterface.changeColumn('reimbursements', 'transaction_id', {
        type: Sequelize.INTEGER,
        allowNull: false,
      });
      await queryInterface.removeColumn('reimbursements', 'source_rate_period_id');
    });
  },
};

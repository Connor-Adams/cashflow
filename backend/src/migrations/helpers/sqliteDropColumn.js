'use strict';

/**
 * Shared, dialect-safe column drop for migrations.
 *
 * `queryInterface.removeColumn` is not safe to call on SQLite. Sequelize 6 has
 * no native DROP COLUMN path for that dialect, so it emulates the operation by
 * rebuilding the table from `describeTable()` output — and that round-trip is
 * lossy four ways:
 *
 *   1. It DROPS every index on the table.
 *   2. It loses `AUTOINCREMENT` on the primary key.
 *   3. It loses every FK `ON DELETE` / `ON UPDATE` action.
 *   4. `describeTable` reports a UNIQUE index as a per-column flag, so a
 *      COMPOSITE unique index comes back as a column-level `UNIQUE` on each of
 *      its member columns.
 *
 * (4) is the one that corrupts data rather than just performance. On `accounts`
 * it turned `UNIQUE (household_id, short_code)` into `household_id INTEGER
 * UNIQUE` — one account per household, ever (#871 / PR #1029). On
 * `planned_events` it smeared the partial unique
 * `(household_id, normalized_name, currency)` across all three columns, capping
 * the table at one row per currency; there the rebuild's own data copy threw
 * `SequelizeUniqueConstraintError` outright as soon as two subscriptions in a
 * household shared a currency. Verified both times, not theoretical.
 *
 * Postgres is unaffected — it does a real in-place `DROP COLUMN` — which is why
 * this class of bug survives review: production is fine and only the SQLite
 * dev/CI schema quietly diverges.
 *
 * SQLite has had native `ALTER TABLE ... DROP COLUMN` since 3.35 (the bundled
 * sqlite3 ships 3.44). It alters in place and touches nothing else, so use it
 * directly and skip the rebuild entirely.
 *
 * ## Caller obligation
 *
 * Native `DROP COLUMN` REFUSES to drop a column any index references — including
 * one referenced only by a partial index's `WHERE` clause:
 *
 *     SQLITE_ERROR: error in index <name> after drop column: no such column: <col>
 *
 * So drop (and, if the migration should keep it, recreate) any such index around
 * the call. This is a deliberate hard failure rather than the silent corruption
 * `removeColumn` produced, so a missed index shows up as a failing migration.
 *
 * Prefer this over the `withIndexesPreserved` shuttle used for `changeColumn`
 * (see `20260918000002-reimbursement-rate-period-source.js`): for a pure drop it
 * is not just simpler but strictly better, because it also preserves
 * AUTOINCREMENT and FK actions, which the shuttle cannot.
 *
 * @param {import('sequelize').QueryInterface} queryInterface
 * @param {string} table
 * @param {string} column
 */
async function dropColumn(queryInterface, table, column) {
  if (queryInterface.sequelize.getDialect() !== 'sqlite') {
    await queryInterface.removeColumn(table, column);
    return;
  }
  await queryInterface.sequelize.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
}

module.exports = { dropColumn };

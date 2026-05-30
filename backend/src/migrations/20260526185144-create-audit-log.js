'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * audit_log: append-only ledger of important finance-data mutations
 * (Cashflow issue #228).
 *
 * What goes here
 *   Anything that explains *who changed what, when, and how* on the
 *   user-visible finance state — transaction edits (single and bulk),
 *   imports, rule create/update/delete, AI suggestion accept/dismiss,
 *   receipt create/delete, settlement create/delete. The point is to
 *   answer "why is this row in this state?" without spelunking through
 *   request logs.
 *
 * Why not piggy-back on ImportHistory / ProviderJobLog / finance_events
 *   - ImportHistory is per-import-file specific (success/partial/failed
 *     with row counts) and does not carry actor or per-mutation diffs.
 *   - ProviderJobLog is per scheduled-job execution.
 *   - finance_events (issue #238, separate work) records *domain events*
 *     for stream/projection use; it is intentionally append-only with
 *     compact payloads, not before/after snapshots. The audit log carries
 *     larger metadata including the diff so the UI can explain WHY a
 *     row looks the way it does to a human reviewer.
 *
 * Schema notes
 *   - household_id is required (NOT NULL). Every audit row belongs to
 *     exactly one household; cross-household reads are blocked by
 *     householdWhere() in the route.
 *   - actor_user_id is NULLABLE on purpose — system-emitted records
 *     (background jobs, cron) have no human actor.
 *   - action is a STRING (not enum). Adding a new mutation source later
 *     should not require an ALTER TYPE migration. Convention is
 *     `<entityType>.<verb>` (e.g. `transaction.updated`).
 *   - entity_type is a STRING and entity_id is a NULLABLE BIGINT — bulk
 *     mutations record entity_id=null and put the affected count/ids in
 *     metadata.
 *   - before / after / metadata are JSONB (or JSON on SQLite) and free-
 *     form so callers can carry whatever context is useful. before/after
 *     should be small (changed fields only) — the audit log is for
 *     explanation, not full row replication.
 *
 * Indexes
 *   - (household_id, created_at DESC) — primary listing query.
 *   - (household_id, entity_type, entity_id) — entity-history lookup
 *     for the transaction/rule detail view.
 *   - (household_id, action) — filter by action type.
 *
 * Append-only: nothing in the app code updates rows; we only insert.
 * Routes do not expose DELETE. (Operational tooling can prune, but that
 * is out of scope for the AC of this issue.)
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
    const dialect = queryInterface.sequelize.getDialect();
    const isPostgres = dialect === 'postgres';
    const jsonType = isPostgres ? Sequelize.JSONB : Sequelize.JSON;

    await queryInterface.createTable('audit_log', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      actor_user_id: {
        // NULL for system-emitted audit rows (background jobs).
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      action: {
        // `<entityType>.<verb>`, e.g. `transaction.updated`, `import.committed`.
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      entity_type: {
        // `transaction`, `rule`, `settlement`, `receipt`, `import`,
        // `ai_suggestion`, etc. Free-form for forward compatibility.
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      entity_id: {
        // NULL for bulk mutations or for entities that have no numeric id
        // (e.g. `import` references the batch via metadata). INTEGER (32-bit)
        // matches the type of every other primary key in this codebase;
        // using BIGINT would force pg to return strings here for safety
        // and complicate equality checks.
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      summary: {
        // Short human-readable description of what changed. Free-form;
        // populated so the audit-log viewer can render a row without
        // having to interpret before/after diffs.
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      before: {
        // Pre-mutation snapshot of CHANGED fields only (not full row).
        // NULL for create events.
        type: jsonType,
        allowNull: true,
      },
      after: {
        // Post-mutation snapshot of CHANGED fields only.
        // NULL for delete events.
        type: jsonType,
        allowNull: true,
      },
      metadata: {
        // Free-form context: batch ids, affected counts, AI suggestion
        // ids, request id, anything else useful to display.
        type: jsonType,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'audit_log',
      ['household_id', 'created_at'],
      { name: 'audit_log_household_created_at' },
    );
    await addIndex(
      queryInterface,
      'audit_log',
      ['household_id', 'entity_type', 'entity_id'],
      { name: 'audit_log_household_entity' },
    );
    await addIndex(
      queryInterface,
      'audit_log',
      ['household_id', 'action'],
      { name: 'audit_log_household_action' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('audit_log');
  },
};

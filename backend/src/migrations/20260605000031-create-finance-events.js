'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

/**
 * finance_events: append-only domain event log for finance workflows
 * (Cashflow issue #238).
 *
 * Why a SECOND log alongside `audit_log`
 *   `audit_log` (issue #228) records WHO changed WHAT for human-facing
 *   explanation — before/after diffs, summary strings, actor name. It
 *   exists to render "<actor> changed category on <date>" to a reviewer.
 *
 *   `finance_events` records WHAT HAPPENED in machine-oriented terms —
 *   compact, replay-friendly payloads keyed by canonical event type
 *   (`transaction.updated`, `settlement.created`, ...). Designed for
 *   stream consumption: future projections (e.g. rebuilding a balance
 *   from events), replay, undo, and agent context. There is no
 *   before/after snapshot — the payload is meant to BE the change, not
 *   to explain it.
 *
 *   They diverge in:
 *     - Payload shape: audit_log carries diffs + summary; finance_events
 *       carries the action's input/output in canonical form.
 *     - Append discipline: audit_log tolerates writes failing
 *       (best-effort, swallowed); finance_events is also best-effort
 *       today but a future projection rebuild would require stricter
 *       guarantees — left as a follow-up.
 *     - Indexes: audit_log indexes for (household, entity, action) UI
 *       queries; finance_events indexes for (household, entity) and
 *       (household, type, created_at) stream queries.
 *
 *   They share: household scoping, optional actor, JSON payload column,
 *   STRING type/entity fields (no enums, forward compatibility).
 *
 * What goes here
 *   Domain events emitted on key finance workflows:
 *     - settlement.created / settlement.deleted
 *     - transaction.updated
 *     - rule.created / rule.updated / rule.deleted
 *   More can be added incrementally without schema changes.
 *
 * What does NOT go here
 *   - UI explanation text → use audit_log.
 *   - Per-row before/after history of transactions → use
 *     transaction_revisions (issue #229).
 *   - Per-statement import success/failure → use import_history.
 *   - Background job runs → use provider_job_log.
 *
 * Schema notes
 *   - household_id is required (NOT NULL). Every event belongs to one
 *     household.
 *   - actor_user_id is NULLABLE — system-emitted events (background
 *     jobs, cron, AI agents acting on their own) have no human actor.
 *   - type is a STRING (not enum). Convention `<entity>.<verb>` matches
 *     audit_log. Adding new event types must NOT require a migration.
 *   - entity_type / entity_id mirror audit_log; entity_id is NULLABLE
 *     for events that span multiple entities (bulk operations).
 *   - payload is JSONB on Postgres, JSON on SQLite (test). Free-form
 *     but callers should keep it compact and machine-replayable.
 *   - occurred_at lets the emitter override the timestamp when the
 *     event represents something that happened at a known moment
 *     (e.g. import statement date, settlement date). Defaults to NOW().
 *   - created_at is the actual insert time — the wall-clock when this
 *     row appeared in the log, useful for stream tailing.
 *
 * Indexes
 *   - (household_id, created_at DESC) — stream tail.
 *   - (household_id, entity_type, entity_id) — entity history.
 *   - (household_id, type, created_at DESC) — type-filtered streams.
 *
 * Append-only
 *   The table has no UPDATE/DELETE API surface in the app. Schema does
 *   not enforce it (we don't add a row-level trigger) — code discipline
 *   does. A future stricter mode could revoke UPDATE/DELETE on this
 *   table from the app DB role.
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

    await queryInterface.createTable('finance_events', {
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
        // NULL for system-emitted events.
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      type: {
        // `<entity>.<verb>`, e.g. `transaction.updated`. STRING, not
        // ENUM, so new event types don't require migrations.
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      entity_type: {
        // `transaction`, `rule`, `settlement`, etc. STRING for forward
        // compat. NULL for events that don't bind to one entity type.
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      entity_id: {
        // INTEGER (matches every other PK in the codebase). NULL for
        // multi-entity events (e.g. bulk operations).
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      payload: {
        // Machine-oriented event payload. Keep compact and
        // replay-friendly. JSONB on pg, JSON on sqlite.
        type: jsonType,
        allowNull: true,
      },
      occurred_at: {
        // When the event actually happened (caller-supplied). Defaults
        // to NOW(). Useful when emitter knows a domain timestamp (e.g.
        // settledDate, import date) that differs from created_at.
        type: Sequelize.DATE,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(
      queryInterface,
      'finance_events',
      ['household_id', 'created_at'],
      { name: 'finance_events_household_created_at' },
    );
    await addIndex(
      queryInterface,
      'finance_events',
      ['household_id', 'entity_type', 'entity_id'],
      { name: 'finance_events_household_entity' },
    );
    await addIndex(
      queryInterface,
      'finance_events',
      ['household_id', 'type', 'created_at'],
      { name: 'finance_events_household_type_created_at' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('finance_events');
  },
};

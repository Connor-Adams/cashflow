/**
 * restoreBundle — apply a decrypted bundle payload to a target
 * household (Cashflow #239).
 *
 * V1 supports two modes:
 *   - 'merge' (default): refuse if any of the V1 tables in the
 *     target household contain rows. Forces a "restore-into-empty"
 *     story; safe by default. Use this when restoring on a fresh
 *     install.
 *   - 'replace': wipe the V1 tables for the target household first,
 *     then insert. The destructive option behind an explicit opt-in
 *     so a user can't accidentally clobber live data with a stale
 *     bundle.
 *
 * Primary-key collisions are handled by a per-table id-remap. The
 * incoming row's id is replaced by the autoincrement value picked by
 * the DB; references to that id from later tables get rewritten on
 * the fly. This is why TABLES is ordered parent-first.
 *
 * `household_id` is rewritten everywhere to the target household.
 */
import { QueryTypes, type Sequelize, type Transaction } from 'sequelize';
import type { BundlePayload } from './bundleFormat';
import { TABLES, TABLE_NAMES, type BundleTableSpec } from './tables';
import { getOrCreatePersonalEntity } from '../tax/services/getOrCreatePersonalEntity';

export type RestoreMode = 'merge' | 'replace';

export interface RestoreOptions {
  /** Target household id rows should land in. */
  householdId: number;
  /** Restore strategy — defaults to 'merge'. */
  mode?: RestoreMode;
  /** Dry-run: validate + count, do not write. */
  dryRun?: boolean;
}

export interface RestoreResult {
  /** Per-table row counts that were (or would be) restored. */
  inserted: Record<string, number>;
  /** Per-table row counts that were skipped (e.g. unknown table). */
  skipped: Record<string, number>;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

/** Tables also have FK columns whose values are themselves primary
 *  keys of earlier tables — these need to be remapped on insert. */
const FK_REMAP: Record<string, Array<{ column: string; refTable: string }>> = {
  transactions: [
    { column: 'account_id', refTable: 'accounts' },
    { column: 'applied_rule_id', refTable: 'rules' },
    { column: 'ownership_contact_id', refTable: 'contacts' },
    // linked_transaction_id intentionally NOT remapped — self-ref is
    // patched in a second pass after all transactions are written
    // (TODO follow-up; for V1 we null it out on restore).
  ],
};

/** Columns NULLed when their source value can't be remapped — e.g.
 *  linked_transaction_id self-ref (patched in a later pass; V1 nulls it).
 *  entity_id is deliberately NOT listed: the bundle's source entity id is
 *  meaningless in the target, but accounts/transactions.entity_id is NOT NULL
 *  (migration 20260619000001) and Postgres rejects a NULL at INSERT time, so
 *  restore re-derives the target-household entity_id up front (see
 *  restoreBundle) rather than nulling-then-fixing. */
const NULL_ON_RESTORE: Record<string, string[]> = {
  transactions: ['linked_transaction_id'],
};

function targetIsEmpty(
  sequelize: Sequelize,
  table: string,
  householdId: number,
  transaction: Transaction,
): Promise<boolean> {
  return sequelize
    .query<{ n: number }>(
      `SELECT COUNT(*) as n FROM "${table}" WHERE "household_id" = :hid`,
      {
        replacements: { hid: householdId },
        type: QueryTypes.SELECT,
        transaction,
      },
    )
    .then((rows) => Number(rows[0]?.n ?? 0) === 0);
}

async function wipeTable(
  sequelize: Sequelize,
  table: string,
  householdId: number,
  transaction: Transaction,
): Promise<void> {
  await sequelize.query(
    `DELETE FROM "${table}" WHERE "household_id" = :hid`,
    {
      replacements: { hid: householdId },
      type: QueryTypes.DELETE,
      transaction,
    },
  );
}

function pickColumnValues(
  row: Record<string, unknown>,
  columns: string[],
): unknown[] {
  return columns.map((c) => (c in row ? row[c] : null));
}

async function insertRow(
  sequelize: Sequelize,
  spec: BundleTableSpec,
  row: Record<string, unknown>,
  transaction: Transaction,
): Promise<number | null> {
  // Drop the source id so the DB autoincrements; capture the new id.
  const insertCols = spec.columns.filter((c) => c !== 'id');
  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
  const colList = insertCols.map((c) => `"${c}"`).join(', ');

  const values = pickColumnValues(row, insertCols);
  const sql = `INSERT INTO "${spec.table}" (${colList}) VALUES (${placeholders}) RETURNING id`;
  // SQLite (test) doesn't support RETURNING in older drivers but sqlite3 5.x
  // does. If RETURNING fails we fall back to lastInsertRowid via Sequelize.
  try {
    const out = (await sequelize.query<{ id: number }>(sql, {
      bind: values,
      type: QueryTypes.SELECT,
      transaction,
    })) as unknown as Array<{ id: number }>;
    return Number(out[0]?.id ?? null);
  } catch {
    // Fall back: INSERT without RETURNING, then SELECT last_insert_rowid().
    const fallbackSql = `INSERT INTO "${spec.table}" (${colList}) VALUES (${placeholders})`;
    await sequelize.query(fallbackSql, {
      bind: values,
      type: QueryTypes.INSERT,
      transaction,
    });
    const lastRow = (await sequelize.query<{ id: number }>(
      `SELECT last_insert_rowid() as id`,
      { type: QueryTypes.SELECT, transaction },
    )) as unknown as Array<{ id: number }>;
    return Number(lastRow[0]?.id ?? null);
  }
}

export async function restoreBundle(
  sequelize: Sequelize,
  payload: BundlePayload,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { householdId, mode = 'merge', dryRun = false } = options;
  if (!Number.isInteger(householdId) || householdId < 1) {
    throw new Error('restoreBundle requires a positive integer householdId');
  }

  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  // Detect rows that arrived in unknown tables — these get reported
  // as skipped, not silently dropped, so the user sees they exist.
  for (const tname of Object.keys(payload.tables)) {
    if (!TABLE_NAMES.has(tname)) {
      const rows = payload.tables[tname];
      skipped[tname] = Array.isArray(rows) ? rows.length : 0;
    }
  }

  if (dryRun) {
    // Compute counts but don't open a transaction.
    for (const spec of TABLES) {
      const rows = payload.tables[spec.table];
      inserted[spec.table] = Array.isArray(rows) ? rows.length : 0;
    }
    return { inserted, skipped, dryRun: true };
  }

  // One transaction across all tables — restore is all-or-nothing.
  const t = await sequelize.transaction();
  try {
    // Step 1: ensure the target household is in the expected state.
    if (mode === 'merge') {
      for (const spec of TABLES) {
        if (!(await targetIsEmpty(sequelize, spec.table, householdId, t))) {
          throw new Error(
            `Refusing to restore in merge mode: target household has existing rows in "${spec.table}". Use mode=replace to overwrite.`,
          );
        }
      }
    } else if (mode === 'replace') {
      // Wipe in REVERSE order (children first) to respect FK constraints.
      for (let i = TABLES.length - 1; i >= 0; i--) {
        await wipeTable(sequelize, TABLES[i].table, householdId, t);
      }
    }

    // Re-derive entity_id to the TARGET household's personal entity, computed
    // once and applied at INSERT time below (see the per-row note). The bundle
    // carries no tax_entities, so the source entity id is meaningless here.
    const personal = await getOrCreatePersonalEntity(householdId, { transaction: t });

    // Step 2: insert in forward order, building the id-remap as we go.
    const idRemap: Record<string, Map<number, number>> = {};
    for (const spec of TABLES) {
      idRemap[spec.table] = new Map();
      const rows = payload.tables[spec.table];
      if (!Array.isArray(rows) || rows.length === 0) {
        inserted[spec.table] = 0;
        continue;
      }
      let count = 0;
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const row = { ...(raw as Record<string, unknown>) };
        // Rewrite household_id on tables that own a household_id col.
        if (spec.rewriteHouseholdId && 'household_id' in row) {
          row.household_id = householdId;
        }
        // Remap FK columns referencing earlier tables.
        const fks = FK_REMAP[spec.table] ?? [];
        for (const fk of fks) {
          const oldVal = row[fk.column];
          if (oldVal == null) continue;
          const remap = idRemap[fk.refTable];
          if (!remap) continue;
          const newVal = remap.get(Number(oldVal));
          row[fk.column] = newVal ?? null;
        }
        // NULL out columns we can't remap in V1.
        for (const col of NULL_ON_RESTORE[spec.table] ?? []) {
          if (col in row) row[col] = null;
        }
        // entity_id is mandatory (NOT NULL, migration 20260619000001) and the
        // bundle's source entity id is meaningless in the target DB — set the
        // target household's personal entity at INSERT time. A NULL here would
        // be rejected before any post-insert fix could run. Corp accounts
        // collapse to personal in V1 (the bundle carries no tax_entities); the
        // next import re-links them.
        if (
          (spec.table === 'accounts' || spec.table === 'transactions') &&
          'entity_id' in row
        ) {
          row.entity_id = personal.id;
        }
        const sourceId = Number(row.id ?? 0);
        const newId = await insertRow(sequelize, spec, row, t);
        if (sourceId && newId) {
          idRemap[spec.table].set(sourceId, newId);
        }
        count += 1;
      }
      inserted[spec.table] = count;
    }

    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }

  return { inserted, skipped, dryRun: false };
}

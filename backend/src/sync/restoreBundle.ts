/**
 * restoreBundle — apply a decrypted bundle payload to a target
 * household (Cashflow #239).
 *
 * Restore is merge-only: it refuses if any of the V1 tables in the
 * target household contain rows, so a bundle can only be restored into
 * an empty household (e.g. a fresh install).
 *
 * There is deliberately no "replace" (wipe-then-insert) mode. Deleting
 * the household's transactions/accounts/categories ON DELETE CASCADEs
 * into receipts, order links, labels, reimbursements, tax metadata,
 * investment activity and more — none of which the bundle carries (see
 * tables.ts) — so a replace would silently destroy data it can never
 * restore. The /api/sync/restore route rejects mode=replace with a 400.
 *
 * Primary-key collisions are handled by a per-table id-remap. The
 * incoming row's id is replaced by the autoincrement value picked by
 * the DB; references to that id from later tables get rewritten on
 * the fly. This is why TABLES is ordered parent-first. Self-references
 * (transactions.linked_transaction_id) are patched in a second pass once
 * the whole table is written — see SELF_REF_REMAP.
 *
 * `household_id` is rewritten everywhere to the target household.
 */
import { QueryTypes, type Sequelize, type Transaction } from 'sequelize';
import type { BundlePayload } from './bundleFormat';
import { TABLES, TABLE_NAMES, type BundleTableSpec } from './tables';
import { getOrCreatePersonalEntity } from '../tax/services/getOrCreatePersonalEntity';

export interface RestoreOptions {
  /** Target household id rows should land in. */
  householdId: number;
  /** Restoring user's id — the only known-member value. Used to normalize
   *  bundle-supplied user-id columns (owner_user_id / created_by_user_id) so a
   *  crafted bundle can't plant a foreign user id (#837). When omitted, those
   *  columns are nulled rather than trusted. */
  userId?: number;
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
    // linked_transaction_id is a SELF-reference — see SELF_REF_REMAP.
  ],
};

/** Self-referencing FK columns (a row pointing at another row of the SAME
 *  table), e.g. transactions.linked_transaction_id pairing transfer legs and
 *  charge/refund. They can't be remapped at INSERT time: the target row may
 *  not be written yet, and the FK is enforced immediately on Postgres. So the
 *  column is inserted as NULL, and once every row of the table is in (and the
 *  table's old-id -> new-id map is complete) a second pass UPDATEs it to the
 *  target's NEW id. A link whose target was not in the bundle (e.g. it pointed
 *  at another household's row) stays NULL rather than dangling.
 *
 *  entity_id is deliberately NOT handled by any remap: the bundle's source
 *  entity id is meaningless in the target, but accounts/transactions.entity_id
 *  is NOT NULL (migration 20260619000001) and Postgres rejects a NULL at
 *  INSERT time, so restore re-derives the target-household entity_id up front
 *  (see restoreBundle) rather than nulling-then-fixing. */
const SELF_REF_REMAP: Record<string, string[]> = {
  transactions: ['linked_transaction_id'],
};

/** User-id columns whose bundle value is NEVER trusted (#837, security): a
 *  crafted bundle could set them to a user id from another household, which
 *  would mis-attribute ownership/authorship and corrupt owner-scoped
 *  `visibility` queries. On restore we force any non-null value to the
 *  restoring user's id (the only safe known-member value); a null source value
 *  stays null, and when no restoring user is supplied we null them rather than
 *  trust the bundle. Keep this in sync with the `*_user_id` columns in
 *  tables.ts. */
const USER_ID_COLUMNS: Record<string, string[]> = {
  accounts: ['owner_user_id'],
  rules: ['created_by_user_id'],
  transactions: ['created_by_user_id'],
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
  const insertSql = `INSERT INTO "${spec.table}" (${colList}) VALUES (${placeholders})`;

  // One statement per row on both dialects, and no catch-and-retry: a retry
  // after a half-failed insert is exactly how rows used to land twice.
  if (sequelize.getDialect() === 'sqlite') {
    // Sequelize's SQLite dialect runs every INSERT through sqlite3's `run()`
    // regardless of `type`, so `RETURNING id` rows are discarded (and with
    // `type: SELECT` it throws *after* the row is written). With
    // `type: INSERT` it hands back `[lastID, changes]`.
    const [lastId] = (await sequelize.query(insertSql, {
      bind: values,
      type: QueryTypes.INSERT,
      transaction,
    })) as unknown as [number, number];
    return lastId == null ? null : Number(lastId);
  }

  const out = (await sequelize.query<{ id: number }>(`${insertSql} RETURNING id`, {
    bind: values,
    type: QueryTypes.SELECT,
    transaction,
  })) as unknown as Array<{ id: number }>;
  const id = out[0]?.id;
  return id == null ? null : Number(id);
}

export async function restoreBundle(
  sequelize: Sequelize,
  payload: BundlePayload,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { householdId, userId, dryRun = false } = options;
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
    // Step 1: merge-only — the target household must be empty.
    for (const spec of TABLES) {
      if (!(await targetIsEmpty(sequelize, spec.table, householdId, t))) {
        throw new Error(
          `Refusing to restore: target household has existing rows in "${spec.table}". A backup can only be restored into an empty household.`,
        );
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
      const pendingSelfRefs: Array<{ newId: number; column: string; sourceTarget: number }> = [];
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
        // Defer self-references to the second pass below: insert NULL now,
        // remember the source target id.
        const selfRefs: Array<{ column: string; sourceTarget: number }> = [];
        for (const col of SELF_REF_REMAP[spec.table] ?? []) {
          if (!(col in row)) continue;
          if (row[col] != null) selfRefs.push({ column: col, sourceTarget: Number(row[col]) });
          row[col] = null;
        }
        // Never trust bundle-supplied user ids (#837): normalize any non-null
        // value to the restoring user (a known member), or null it when no
        // restoring user is known. A null source value stays null.
        for (const col of USER_ID_COLUMNS[spec.table] ?? []) {
          if (col in row && row[col] != null) {
            row[col] = userId ?? null;
          }
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
        if (newId) {
          for (const ref of selfRefs) pendingSelfRefs.push({ newId, ...ref });
        }
        count += 1;
      }
      inserted[spec.table] = count;

      // Second pass: every row of this table is written, so its id-remap is
      // complete — point each deferred self-reference at its target's NEW id.
      // Targets absent from the bundle stay NULL (already inserted as NULL).
      for (const ref of pendingSelfRefs) {
        const newTarget = idRemap[spec.table].get(ref.sourceTarget);
        if (newTarget == null) continue;
        await sequelize.query(
          `UPDATE "${spec.table}" SET "${ref.column}" = :target WHERE "id" = :id AND "household_id" = :hid`,
          {
            replacements: { target: newTarget, id: ref.newId, hid: householdId },
            type: QueryTypes.UPDATE,
            transaction: t,
          },
        );
      }
    }

    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }

  return { inserted, skipped, dryRun: false };
}

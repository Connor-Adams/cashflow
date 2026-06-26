/**
 * Audit-log read-time row-level visibility filter (Cashflow issue #838).
 *
 * The audit log stores `before`/`after`/`metadata` JSONB snapshots of mutated
 * rows, scoped only by `householdId`. That is insufficient: a household member
 * can have rows on *private* transactions / vault documents that they neither
 * own nor are allowed to see in normal queries. Reading those snapshots through
 * the audit log bypasses the row-level `visibility` gate enforced everywhere
 * else (`visibleTransactionWhere`, `visibleVaultWhere`), leaking another
 * member's private notes / merchant PII / file metadata.
 *
 * This module re-applies that gate at audit-log read time. For the two
 * entity types that carry per-row `visibility` (`transaction`, `vault_document`)
 * we keep an audit row only if the caller may currently see the underlying
 * entity, or — for a since-deleted entity — only if the caller was the actor
 * who performed the mutation (they already saw the value). Every other entity
 * type (rule, settlement, receipt, ai_suggestion, import) is household-shared
 * by design, so the existing `householdId` scope already suffices and those
 * rows pass through untouched. Superadmins bypass the gate, mirroring every
 * other scope helper.
 */
import type { Request } from 'express';
import { Op } from 'sequelize';
import { AuditLog } from '../models/AuditLog';
import { Transaction } from '../models/Transaction';
import { VaultDocument } from '../models/VaultDocument';
import { currentAuth } from '../auth/middleware';
import { isSuperadmin } from '../auth/scope';

/**
 * Entity types whose audit rows must be re-checked against row-level
 * visibility. Keep in sync with the models that declare a `visibility`
 * column (transaction, vault_document). Other audit entity types are
 * household-shared and need no extra gate.
 */
const VISIBILITY_SCOPED_ENTITY_TYPES = new Set(['transaction', 'vault_document']);

/** The minimal per-caller context the pure filter needs. */
export interface AuditVisibilityContext {
  isSuperadmin: boolean;
  userId: number;
  /** Transaction ids the caller may currently see. */
  visibleTransactionIds: ReadonlySet<number>;
  /** Vault-document ids the caller may currently see. */
  visibleVaultIds: ReadonlySet<number>;
  /**
   * Transaction ids that still exist in the household (regardless of
   * visibility). Used to distinguish "private, not yours" (drop) from
   * "deleted" (keep only if you were the actor).
   */
  existingTransactionIds: ReadonlySet<number>;
  /** Vault-document ids that still exist in the household. */
  existingVaultIds: ReadonlySet<number>;
}

interface MinimalAuditRow {
  entityType: string;
  entityId: number | null;
  actorUserId: number | null;
}

function setFor(
  type: string,
  ctx: AuditVisibilityContext,
): { visible: ReadonlySet<number>; existing: ReadonlySet<number> } | null {
  if (type === 'transaction') {
    return { visible: ctx.visibleTransactionIds, existing: ctx.existingTransactionIds };
  }
  if (type === 'vault_document') {
    return { visible: ctx.visibleVaultIds, existing: ctx.existingVaultIds };
  }
  return null;
}

/**
 * Decide whether a single audit row is readable by the caller. Pure — unit
 * tested directly. See module doc for the rationale behind each branch.
 */
export function isAuditRowVisible(
  row: MinimalAuditRow,
  ctx: AuditVisibilityContext,
): boolean {
  if (ctx.isSuperadmin) return true;
  if (!VISIBILITY_SCOPED_ENTITY_TYPES.has(row.entityType)) return true;
  // Bulk / id-less mutations carry only aggregate metadata (counts / id lists),
  // never a field-level before/after snapshot, and are already household-scoped.
  if (row.entityId == null) return true;

  const sets = setFor(row.entityType, ctx);
  if (!sets) return true; // unknown scoped type — fail safe to keep household scope only

  if (sets.visible.has(row.entityId)) return true;
  // Entity exists but is not visible → private and not the caller's. Drop.
  if (sets.existing.has(row.entityId)) return false;
  // Entity no longer exists (deleted). The actor who made the edit already saw
  // the value, so they may keep reading their own historical rows; everyone
  // else is denied because we can no longer prove the row was shared.
  return row.actorUserId != null && row.actorUserId === ctx.userId;
}

/**
 * Filter an array of fetched audit rows down to those the caller may read.
 * Pure given a context — separated so the DB-touching `buildContext` can be
 * tested via integration and this can be tested in isolation.
 */
export function filterVisibleAuditRows<T extends MinimalAuditRow>(
  rows: T[],
  ctx: AuditVisibilityContext,
): T[] {
  if (ctx.isSuperadmin) return rows;
  return rows.filter((r) => isAuditRowVisible(r, ctx));
}

/**
 * Build the visibility context for the caller from the audit rows in hand:
 * resolves which referenced transaction / vault ids are currently visible and
 * which still exist. Only queries the ids actually present in `rows`, so the
 * extra lookups are bounded by the page size.
 */
export async function buildAuditVisibilityContext(
  req: Request,
  rows: MinimalAuditRow[],
): Promise<AuditVisibilityContext> {
  const auth = currentAuth(req);
  const superadmin = isSuperadmin(req);
  const base: AuditVisibilityContext = {
    isSuperadmin: superadmin,
    userId: auth.user.id,
    visibleTransactionIds: new Set(),
    visibleVaultIds: new Set(),
    existingTransactionIds: new Set(),
    existingVaultIds: new Set(),
  };
  if (superadmin) return base;

  const txnIds = new Set<number>();
  const vaultIds = new Set<number>();
  for (const r of rows) {
    if (r.entityId == null) continue;
    if (r.entityType === 'transaction') txnIds.add(r.entityId);
    else if (r.entityType === 'vault_document') vaultIds.add(r.entityId);
  }

  const householdId = auth.household.id;
  const userId = auth.user.id;

  const existingTransactionIds = new Set<number>();
  const visibleTransactionIds = new Set<number>();
  if (txnIds.size > 0) {
    const txns = await Transaction.findAll({
      where: { id: { [Op.in]: [...txnIds] }, householdId },
      attributes: ['id', 'visibility', 'createdByUserId'],
    });
    for (const t of txns) {
      existingTransactionIds.add(t.id);
      if (t.visibility === 'shared' || t.createdByUserId === userId) {
        visibleTransactionIds.add(t.id);
      }
    }
  }

  const existingVaultIds = new Set<number>();
  const visibleVaultIds = new Set<number>();
  if (vaultIds.size > 0) {
    const docs = await VaultDocument.findAll({
      where: { id: { [Op.in]: [...vaultIds] }, householdId },
      attributes: ['id', 'visibility', 'uploadedByUserId'],
    });
    for (const d of docs) {
      existingVaultIds.add(d.id);
      if (d.visibility === 'shared' || d.uploadedByUserId === userId) {
        visibleVaultIds.add(d.id);
      }
    }
  }

  return {
    ...base,
    visibleTransactionIds,
    visibleVaultIds,
    existingTransactionIds,
    existingVaultIds,
  };
}

/**
 * Convenience: build the context from `rows` and return the readable subset.
 * Used by the audit-log route handlers.
 */
export async function scopeAuditRowsToVisibility(
  req: Request,
  rows: AuditLog[],
): Promise<AuditLog[]> {
  const ctx = await buildAuditVisibilityContext(req, rows);
  return filterVisibleAuditRows(rows, ctx);
}

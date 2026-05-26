/**
 * Audit-log emit helper (Cashflow issue #228).
 *
 * Routes call `recordAudit` after a finance mutation succeeds; this
 * inserts a row into `audit_log` with actor/household scoped from the
 * request and a free-form metadata payload.
 *
 * Failures here are SWALLOWED (logged via pino and dropped). The
 * acceptance criterion is explicit: "Audit logging does not block
 * existing workflows." A unique-constraint hiccup or a transient
 * connection error MUST NOT cause a user-facing 500 on what would
 * otherwise be a successful patch / import / settlement. Callers that
 * want to know about audit failures can pass `{ rethrowOnError: true }`
 * (used by tests).
 *
 * The helper is intentionally agnostic about the EXACT shape of
 * before/after — callers compute their own diff. We do enforce two
 * soft limits to keep payloads sane:
 *   - JSON_VALUE_BYTES_MAX caps each of before/after/metadata to ~16 KB
 *     of serialized JSON. Bigger payloads are truncated to a sentinel.
 *   - SUMMARY_MAX truncates the human-readable summary to fit the
 *     STRING(255) column.
 */

import type { Request } from 'express';
import { AuditLog } from '../models/AuditLog';
import { logger } from '../observability/logger';
import { currentAuth } from '../auth/middleware';

/** Soft cap for serialized before/after/metadata JSON (per field). */
const JSON_VALUE_BYTES_MAX = 16 * 1024;
const SUMMARY_MAX = 255;

/**
 * Canonical action names. Free-form string for forward compatibility,
 * but the routes should pick from this list so the UI can render known
 * verbs consistently.
 */
export const AUDIT_ACTIONS = {
  TransactionUpdated: 'transaction.updated',
  TransactionBulkUpdated: 'transaction.bulk_updated',
  TransactionBulkFilterUpdated: 'transaction.bulk_filter_updated',
  RuleCreated: 'rule.created',
  RuleUpdated: 'rule.updated',
  RuleDeleted: 'rule.deleted',
  AiSuggestionAccepted: 'ai_suggestion.accepted',
  AiSuggestionDismissed: 'ai_suggestion.dismissed',
  SettlementCreated: 'settlement.created',
  SettlementDeleted: 'settlement.deleted',
  ReceiptCreated: 'receipt.created',
  ReceiptDeleted: 'receipt.deleted',
  ImportCommitted: 'import.committed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Canonical entity types. Same forward-compatibility caveat as actions.
 */
export const AUDIT_ENTITY_TYPES = {
  Transaction: 'transaction',
  Rule: 'rule',
  AiSuggestion: 'ai_suggestion',
  Settlement: 'settlement',
  Receipt: 'receipt',
  Import: 'import',
} as const;

export type AuditEntityType =
  (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

export interface RecordAuditInput {
  /** Express request — used to read actor + household. Optional for
   *  system-emitted records; in that case pass householdId explicitly. */
  req?: Request;
  /** Required when `req` is omitted (system jobs). */
  householdId?: number;
  /** Optional actor override (only used when `req` is omitted). */
  actorUserId?: number | null;
  action: AuditAction | string;
  entityType: AuditEntityType | string;
  /** NULL for bulk mutations or for entities with no numeric id. */
  entityId?: number | null;
  /** Short human-readable description. Truncated to 255 chars. */
  summary?: string | null;
  /** Snapshot of CHANGED fields only — keep small. */
  before?: unknown;
  /** Snapshot of CHANGED fields only — keep small. */
  after?: unknown;
  /** Free-form context (batch ids, counts, AI suggestion ids, etc.). */
  metadata?: unknown;
  /** If true, audit failure throws instead of being swallowed. */
  rethrowOnError?: boolean;
}

function truncateString(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * If a JSON-serialized payload exceeds the soft cap, return a sentinel
 * with the byte count and a truncated preview rather than the raw
 * value. This keeps a misbehaving caller (e.g. someone snapshotting a
 * 100-row bulk patch into `before`) from blowing up the table.
 */
function trimJsonValue(value: unknown): unknown {
  if (value == null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    return {
      __auditTruncated: 'serialization_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= JSON_VALUE_BYTES_MAX) return value;
  return {
    __auditTruncated: 'value_too_large',
    bytes: Buffer.byteLength(serialized, 'utf8'),
    limit: JSON_VALUE_BYTES_MAX,
    preview: serialized.slice(0, 1024),
  };
}

/**
 * Compute a minimal field-level diff between two flat objects. Only keys
 * present in `next` whose value differs from `prev` end up in the
 * returned `before` / `after`. Useful so routes don't have to construct
 * the diff by hand.
 */
export function diffPatchableFields<T extends Record<string, unknown>>(
  prev: T | null | undefined,
  next: T | null | undefined,
  keys: ReadonlyArray<keyof T>,
): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  if (!prev || !next) return { before, after };
  for (const k of keys) {
    const p = prev[k];
    const n = next[k];
    // Treat numeric strings vs numbers as equal — Sequelize DECIMAL
    // columns return strings, so a route handler that compares the
    // pre-save string against a post-save number would always claim a
    // diff. Coerce via Number() when both sides parse as finite numbers.
    let eq = p === n;
    if (!eq && p != null && n != null) {
      eq = String(p) === String(n);
      if (!eq) {
        const pn = Number(p);
        const nn = Number(n);
        if (
          Number.isFinite(pn) &&
          Number.isFinite(nn) &&
          pn === nn &&
          String(p).trim() !== '' &&
          String(n).trim() !== ''
        ) {
          eq = true;
        }
      }
    }
    if (!eq) {
      before[k] = p;
      after[k] = n;
    }
  }
  return { before, after };
}

/**
 * Insert one audit row. Best-effort by default; see rethrowOnError above.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  let householdId: number | undefined;
  let actorUserId: number | null = null;
  if (input.req) {
    try {
      const auth = currentAuth(input.req);
      householdId = auth.household.id;
      actorUserId = auth.user.id;
    } catch (err) {
      // Anonymous / unauthenticated request — should not happen since
      // /api routes go through requireAuth, but tolerate it.
      if (input.rethrowOnError) throw err;
      logger.warn(
        { err, action: input.action, entityType: input.entityType },
        'audit_log_unauth_request',
      );
      return;
    }
  } else {
    householdId = input.householdId;
    actorUserId = input.actorUserId ?? null;
  }
  if (householdId == null) {
    if (input.rethrowOnError) {
      throw new Error('recordAudit: householdId is required');
    }
    logger.warn(
      { action: input.action, entityType: input.entityType },
      'audit_log_missing_household',
    );
    return;
  }

  try {
    await AuditLog.create({
      householdId,
      actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: truncateString(input.summary ?? null, SUMMARY_MAX),
      before: trimJsonValue(input.before),
      after: trimJsonValue(input.after),
      metadata: trimJsonValue(input.metadata),
    });
  } catch (err) {
    if (input.rethrowOnError) throw err;
    logger.warn(
      {
        err,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        householdId,
      },
      'audit_log_write_failed',
    );
  }
}

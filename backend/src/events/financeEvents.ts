/**
 * Finance domain-event emit helper (Cashflow issue #238).
 *
 * Routes call `recordFinanceEvent` after a finance mutation succeeds.
 * Inserts one append-only row into `finance_events` keyed by canonical
 * event type and entity reference.
 *
 * Distinction from audit logging
 * ------------------------------
 *   `audit_log` (recordAudit, #228) is for human-facing explanation —
 *   it carries before/after diffs and a summary string so the UI can
 *   render "<actor> changed category on <date>".
 *
 *   `finance_events` is for machine-oriented stream consumption —
 *   compact payloads keyed by canonical event type, suitable for
 *   replay, projections, undo, and agent context. There is no
 *   before/after; the payload IS the change.
 *
 *   Most mutation sites should emit BOTH: a recordAudit for the UI and
 *   a recordFinanceEvent for the stream. They are independent — a
 *   failure in one MUST NOT fail the other.
 *
 *   When to use each
 *     - The UI needs to render this change with WHO/WHAT/WHEN → audit_log.
 *     - A downstream consumer (projection, undo handler, agent) needs
 *       to react to this happening → finance_events.
 *
 * Append-only
 * -----------
 *   This module ONLY inserts. There is no update or delete API. Code
 *   discipline enforces append-only; a future stricter mode could
 *   revoke UPDATE/DELETE from the app DB role.
 *
 * Best-effort writes
 * ------------------
 *   By default, errors are swallowed and logged (mirrors audit_log
 *   semantics). The acceptance criterion is explicit: "Existing
 *   workflows continue to function." A unique-constraint hiccup MUST
 *   NOT cause a 500 on what would otherwise be a successful workflow.
 *   Pass `{ rethrowOnError: true }` (used by tests) to surface errors.
 *
 * Soft payload cap
 * ----------------
 *   Payloads are capped at ~16 KB of serialized JSON. Bigger payloads
 *   are replaced with a sentinel preview. Domain events are supposed
 *   to be compact; the cap catches accidents (e.g. snapshotting a
 *   full row when only the changed fields were intended).
 */

import type { Request } from 'express';
import { FinanceEvent } from '../models/FinanceEvent';
import { logger } from '../observability/logger';
import { currentAuth } from '../auth/middleware';

const JSON_PAYLOAD_BYTES_MAX = 16 * 1024;

/**
 * Canonical event types. Free-form STRING column for forward-compat,
 * but routes should pick from this list so consumers can switch on
 * known type names.
 *
 * Convention: `<entity>.<verb>` lowercase, snake_case for verb. Mirrors
 * audit-log action naming so the two streams line up by inspection.
 */
export const FINANCE_EVENT_TYPES = {
  TransactionUpdated: 'transaction.updated',
  TransactionBulkUpdated: 'transaction.bulk_updated',
  RuleCreated: 'rule.created',
  RuleUpdated: 'rule.updated',
  RuleDeleted: 'rule.deleted',
  SettlementCreated: 'settlement.created',
  SettlementDeleted: 'settlement.deleted',
  ReceiptCreated: 'receipt.created',
  ReceiptDeleted: 'receipt.deleted',
  ImportCommitted: 'import.committed',
  AiSuggestionAccepted: 'ai_suggestion.accepted',
  AiSuggestionDismissed: 'ai_suggestion.dismissed',
} as const;

export type FinanceEventType =
  (typeof FINANCE_EVENT_TYPES)[keyof typeof FINANCE_EVENT_TYPES];

/**
 * Canonical entity types. Mirrors AUDIT_ENTITY_TYPES.
 */
export const FINANCE_EVENT_ENTITY_TYPES = {
  Transaction: 'transaction',
  Rule: 'rule',
  Settlement: 'settlement',
  Receipt: 'receipt',
  Import: 'import',
  AiSuggestion: 'ai_suggestion',
} as const;

export type FinanceEventEntityType =
  (typeof FINANCE_EVENT_ENTITY_TYPES)[keyof typeof FINANCE_EVENT_ENTITY_TYPES];

export interface RecordFinanceEventInput {
  /** Express request — used to read actor + household. Optional for
   *  system-emitted events; in that case pass householdId explicitly. */
  req?: Request;
  /** Required when `req` is omitted (system jobs). */
  householdId?: number;
  /** Optional actor override (only used when `req` is omitted). */
  actorUserId?: number | null;
  /** Canonical event type (`<entity>.<verb>`). Free-form string for
   *  forward compatibility. */
  type: FinanceEventType | string;
  /** Optional entity type for entity-history queries. */
  entityType?: FinanceEventEntityType | string | null;
  /** Entity id for entity-history queries. NULL for events that span
   *  multiple entities (bulk). */
  entityId?: number | null;
  /** Machine-oriented event payload. Keep compact and replay-friendly. */
  payload?: unknown;
  /** Domain timestamp of the event (when it actually happened).
   *  Defaults to now(). */
  occurredAt?: Date;
  /** If true, errors throw instead of being swallowed. */
  rethrowOnError?: boolean;
}

/**
 * If a JSON-serialized payload exceeds the soft cap, return a sentinel
 * with the byte count and a truncated preview rather than the raw
 * value. Keeps a misbehaving caller from blowing up the table.
 */
function trimPayload(value: unknown): unknown {
  if (value == null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    return {
      __financeEventTruncated: 'serialization_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= JSON_PAYLOAD_BYTES_MAX) {
    return value;
  }
  return {
    __financeEventTruncated: 'value_too_large',
    bytes: Buffer.byteLength(serialized, 'utf8'),
    limit: JSON_PAYLOAD_BYTES_MAX,
    preview: serialized.slice(0, 1024),
  };
}

/**
 * Insert one finance_events row. Best-effort by default; pass
 * `rethrowOnError: true` to surface failures (tests use this).
 */
export async function recordFinanceEvent(
  input: RecordFinanceEventInput,
): Promise<void> {
  let householdId: number | undefined;
  let actorUserId: number | null = null;
  if (input.req) {
    try {
      const auth = currentAuth(input.req);
      householdId = auth.household.id;
      actorUserId = auth.user.id;
    } catch (err) {
      if (input.rethrowOnError) throw err;
      logger.warn(
        { err, type: input.type, entityType: input.entityType },
        'finance_event_unauth_request',
      );
      return;
    }
  } else {
    householdId = input.householdId;
    actorUserId = input.actorUserId ?? null;
  }
  if (householdId == null) {
    if (input.rethrowOnError) {
      throw new Error('recordFinanceEvent: householdId is required');
    }
    logger.warn(
      { type: input.type, entityType: input.entityType },
      'finance_event_missing_household',
    );
    return;
  }

  try {
    await FinanceEvent.create({
      householdId,
      actorUserId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: trimPayload(input.payload),
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    if (input.rethrowOnError) throw err;
    logger.warn(
      {
        err,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        householdId,
      },
      'finance_event_write_failed',
    );
  }
}

/**
 * Internal utility: read the event stream for one entity, ordered
 * oldest-first (replay order). Useful for projections, undo, and
 * agent context.
 *
 * NOT exposed via HTTP directly — the public read API is the
 * /api/finance-events route which scopes by request household.
 */
export async function readEntityEvents(args: {
  householdId: number;
  entityType: FinanceEventEntityType | string;
  entityId: number;
  limit?: number;
}): Promise<FinanceEvent[]> {
  const limit = args.limit ?? 500;
  return FinanceEvent.findAll({
    where: {
      householdId: args.householdId,
      entityType: args.entityType,
      entityId: args.entityId,
    },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
  });
}

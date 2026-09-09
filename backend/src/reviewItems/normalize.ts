/**
 * Unified review-items normalization layer (issue #378).
 *
 * The app has four parallel "items the user accepts / dismisses / resolves"
 * subsystems with intentionally divergent status enums and FK shapes:
 *
 *   - ai-suggestion (AiSuggestion row)        — 6-state lifecycle, txn|receipt FK
 *   - ai-review     (AiReviewRun action item) — nested in actionItems[]
 *   - cfo-briefing  (CfoBriefing action item) — nested in actionItems[]
 *   - chat-proposal (ChatProposal row)        — opaque payload, no subject FK
 *
 * Verification (#378) confirmed a *table* fold is unsafe. This module performs
 * the *read-side* fold only: it normalizes each source into a common
 * {@link ReviewItem} shape and exposes the canonical status-mapping table.
 *
 * WRITE PATHS STAY PER-SOURCE. Nothing here mutates a row. Accepting an item
 * still goes through that source's own endpoint with its own status machine.
 */

export const REVIEW_ITEM_SOURCES = [
  'ai-suggestion',
  'ai-review',
  'cfo-briefing',
  'chat-proposal',
] as const;

export type ReviewItemSource = (typeof REVIEW_ITEM_SOURCES)[number];

export type ReviewItemSubjectType =
  | 'transaction'
  | 'receipt'
  | 'rule'
  | 'event'
  | 'subscription'
  | 'import'
  | 'chat-message'
  | null;

export type ReviewItemCommonStatus = 'pending' | 'resolved' | 'dismissed' | 'expired';

/**
 * Normalized inbox item. `payload` is the source-specific blob, passed through
 * untouched so per-source card UIs can render their own fields. `native_status`
 * keeps the original string for source-specific UI; `status_common` is the
 * mapped value for cross-source filtering.
 */
export interface ReviewItem {
  /** Composite "{source}:{nativeId}" — globally unique across sources. */
  id: string;
  source: ReviewItemSource;
  subject_type: ReviewItemSubjectType;
  subject_id: string | null;
  payload: Record<string, unknown>;
  status_common: ReviewItemCommonStatus;
  native_status: string;
  created_at: string;
  resolved_at: string | null;
  /**
   * Sort tiebreak used by {@link mergeAndSort} ahead of the `id` comparison,
   * for when two items share `created_at` exactly. Every item nested inside
   * one run (ai-review, cfo-briefing) shares that run's `createdAt`, so this
   * is the item's index within `run.actionItems` — preserving whatever order
   * the run was produced in (e.g. a synthesis pass's priority ranking).
   * Single-row sources (ai-suggestion, chat-proposal) always report 0, which
   * is a no-op: those items fall straight through to the id-desc tiebreak,
   * unchanged from before this field existed.
   */
  ordinal: number;
}

/**
 * THE status-mapping table — single source of truth (issue #378 AC).
 *
 * Adding a new source means adding exactly one entry here. Any native status
 * not present for a source falls back to 'pending' via {@link mapCommonStatus}
 * so an unexpected value surfaces in the inbox rather than crashing it.
 */
export const REVIEW_ITEM_STATUS_MAP: Record<
  ReviewItemSource,
  Record<string, ReviewItemCommonStatus>
> = {
  'ai-suggestion': {
    suggested: 'pending',
    accepted: 'resolved',
    edited: 'resolved',
    rejected: 'dismissed',
    superseded: 'dismissed',
    failed: 'dismissed',
  },
  'ai-review': {
    suggested: 'pending',
    accepted: 'resolved',
    dismissed: 'dismissed',
  },
  'cfo-briefing': {
    open: 'pending',
    resolved: 'resolved',
    dismissed: 'dismissed',
  },
  'chat-proposal': {
    pending: 'pending',
    applied: 'resolved',
    rejected: 'dismissed',
    expired: 'expired',
  },
};

/**
 * Map a source's native status string to the common status. Unknown values
 * degrade to 'pending' (the inbox shows the item; it is never dropped).
 */
export function mapCommonStatus(
  source: ReviewItemSource,
  nativeStatus: string,
): ReviewItemCommonStatus {
  return REVIEW_ITEM_STATUS_MAP[source][nativeStatus] ?? 'pending';
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** resolved_at is the row/item's updated/applied timestamp when it's left
 *  the pending state; otherwise null. */
function resolvedAt(
  common: ReviewItemCommonStatus,
  when: Date | string | null,
): string | null {
  if (common === 'pending') return null;
  return when == null ? null : iso(when);
}

// ---------------------------------------------------------------------------
// Per-source adapters (pure functions over plain shapes — DB-free, testable)
// ---------------------------------------------------------------------------

export interface AiSuggestionLike {
  id: number;
  kind: string;
  status: string;
  transactionId: number | null;
  receiptId: number | null;
  output: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export function normalizeAiSuggestion(row: AiSuggestionLike): ReviewItem {
  const common = mapCommonStatus('ai-suggestion', row.status);
  let subjectType: ReviewItemSubjectType = null;
  let subjectId: string | null = null;
  if (row.transactionId != null) {
    subjectType = 'transaction';
    subjectId = String(row.transactionId);
  } else if (row.receiptId != null) {
    subjectType = 'receipt';
    subjectId = String(row.receiptId);
  }
  return {
    id: `ai-suggestion:${row.id}`,
    source: 'ai-suggestion',
    subject_type: subjectType,
    subject_id: subjectId,
    payload: {
      kind: row.kind,
      output: row.output ?? null,
      transactionId: row.transactionId,
      receiptId: row.receiptId,
    },
    status_common: common,
    native_status: row.status,
    created_at: iso(row.createdAt),
    resolved_at: resolvedAt(common, row.updatedAt),
    ordinal: 0,
  };
}

export interface ChatProposalLike {
  id: number;
  messageId: number;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  appliedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export function normalizeChatProposal(row: ChatProposalLike): ReviewItem {
  const common = mapCommonStatus('chat-proposal', row.status);
  return {
    id: `chat-proposal:${row.id}`,
    source: 'chat-proposal',
    // The mutation subject lives in opaque payload JSON; the only stable FK
    // is the chat message that produced the proposal.
    subject_type: 'chat-message',
    subject_id: String(row.messageId),
    payload: {
      kind: row.kind,
      payload: row.payload,
      preview: row.preview,
    },
    status_common: common,
    native_status: row.status,
    created_at: iso(row.createdAt),
    // appliedAt is only set on apply; fall back to updatedAt for reject/expire.
    resolved_at: resolvedAt(common, row.appliedAt ?? row.updatedAt),
    ordinal: 0,
  };
}

/** Minimal shape of a nested action item shared by reviews + briefings. */
interface ActionItemLike {
  id: string;
  type: string;
  refType: 'transaction' | 'event' | 'rule' | 'subscription' | 'import' | null;
  refId: number | null;
  severity: string;
  title: string;
  summary: string;
  status: string;
  supportingTransactionIds?: number[];
  rationale?: string;
  link?: string;
}

interface RunLike {
  id: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  actionItems: ActionItemLike[] | null | undefined;
  /**
   * Run-level narrative from the synthesis pass (e.g.
   * `buildCfoBriefing`'s `summary`, persisted as `CfoBriefing.summary`).
   * Optional so existing callers/tests that don't pass it keep working;
   * absent or null just means no narrative to surface.
   */
  summary?: string | null;
}

function subjectFromActionItem(item: ActionItemLike): {
  type: ReviewItemSubjectType;
  id: string | null;
} {
  if (item.refType == null) return { type: null, id: null };
  return { type: item.refType, id: item.refId == null ? null : String(item.refId) };
}

function normalizeNestedItems(
  source: 'ai-review' | 'cfo-briefing',
  run: RunLike,
): ReviewItem[] {
  const items = Array.isArray(run.actionItems) ? run.actionItems : [];
  // Surfaced on every item's payload rather than the run alone — the inbox
  // is a flat list of items, not runs, so the frontend needs it right on
  // the item it's about to render a header above.
  const runSummary = run.summary ?? null;
  return items.map((item, index) => {
    const common = mapCommonStatus(source, item.status);
    const subject = subjectFromActionItem(item);
    return {
      id: `${source}:${run.id}:${item.id}`,
      source,
      subject_type: subject.type,
      subject_id: subject.id,
      payload: { ...item, runId: run.id, runSummary },
      status_common: common,
      native_status: item.status,
      created_at: iso(run.createdAt),
      // Action items don't carry a per-item resolved timestamp; the run's
      // updatedAt is the best available signal once an item leaves pending.
      resolved_at: resolvedAt(common, run.updatedAt),
      // Index within run.actionItems — preserves the run's item order (e.g.
      // a synthesis pass's priority ranking) through mergeAndSort's tiebreak.
      ordinal: index,
    };
  });
}

export function normalizeReviewRunItems(run: RunLike): ReviewItem[] {
  return normalizeNestedItems('ai-review', run);
}

export function normalizeCfoBriefingItems(run: RunLike): ReviewItem[] {
  return normalizeNestedItems('cfo-briefing', run);
}

// ---------------------------------------------------------------------------
// Merge + sort + cursor
// ---------------------------------------------------------------------------

/**
 * Merge items from all sources and sort by created_at desc. Ties are broken
 * first by `ordinal` ascending — so items nested in the same run keep the
 * run's own order (e.g. a synthesis pass's priority ranking) instead of
 * being reshuffled — then by id desc so ordering stays fully deterministic
 * (important for stable cursor paging).
 */
export function mergeAndSort(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export interface ReviewItemsCursor {
  offset: number;
}

/** Opaque base64url cursor encoding a global offset over the merged list. */
export function encodeCursor(cursor: ReviewItemsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): ReviewItemsCursor {
  if (!raw) return { offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { offset?: unknown }).offset === 'number' &&
      Number.isFinite((parsed as { offset: number }).offset) &&
      (parsed as { offset: number }).offset >= 0
    ) {
      return { offset: Math.floor((parsed as { offset: number }).offset) };
    }
    return { offset: 0 };
  } catch {
    return { offset: 0 };
  }
}

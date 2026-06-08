/**
 * Unit tests for the unified review-items normalization layer (issue #378).
 *
 * These are pure-function tests — no DB. They lock down the status-mapping
 * table (the single source of truth the issue requires) plus each per-source
 * adapter and the merge/sort/cursor helpers used by the route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_ITEM_STATUS_MAP,
  REVIEW_ITEM_SOURCES,
  mapCommonStatus,
  normalizeAiSuggestion,
  normalizeChatProposal,
  normalizeReviewRunItems,
  normalizeCfoBriefingItems,
  mergeAndSort,
  encodeCursor,
  decodeCursor,
  type ReviewItem,
} from './normalize.ts';

// ---------------------------------------------------------------------------
// Status mapping table
// ---------------------------------------------------------------------------

test('maps every documented native status to the right common status', () => {
  assert.equal(mapCommonStatus('ai-suggestion', 'suggested'), 'pending');
  assert.equal(mapCommonStatus('ai-suggestion', 'accepted'), 'resolved');
  assert.equal(mapCommonStatus('ai-suggestion', 'edited'), 'resolved');
  assert.equal(mapCommonStatus('ai-suggestion', 'rejected'), 'dismissed');
  assert.equal(mapCommonStatus('ai-suggestion', 'superseded'), 'dismissed');
  assert.equal(mapCommonStatus('ai-suggestion', 'failed'), 'dismissed');

  assert.equal(mapCommonStatus('ai-review', 'suggested'), 'pending');
  assert.equal(mapCommonStatus('ai-review', 'accepted'), 'resolved');
  assert.equal(mapCommonStatus('ai-review', 'dismissed'), 'dismissed');

  assert.equal(mapCommonStatus('cfo-briefing', 'open'), 'pending');
  assert.equal(mapCommonStatus('cfo-briefing', 'resolved'), 'resolved');
  assert.equal(mapCommonStatus('cfo-briefing', 'dismissed'), 'dismissed');

  assert.equal(mapCommonStatus('chat-proposal', 'pending'), 'pending');
  assert.equal(mapCommonStatus('chat-proposal', 'applied'), 'resolved');
  assert.equal(mapCommonStatus('chat-proposal', 'rejected'), 'dismissed');
  assert.equal(mapCommonStatus('chat-proposal', 'expired'), 'expired');
});

test('unknown native status falls back to pending (never crashes the inbox)', () => {
  assert.equal(mapCommonStatus('ai-suggestion', 'totally-unknown'), 'pending');
  assert.equal(mapCommonStatus('chat-proposal', ''), 'pending');
});

test('status map + sources list cover exactly the four sources', () => {
  assert.deepEqual(
    Object.keys(REVIEW_ITEM_STATUS_MAP).sort(),
    ['ai-review', 'ai-suggestion', 'cfo-briefing', 'chat-proposal'],
  );
  assert.deepEqual(
    [...REVIEW_ITEM_SOURCES].sort(),
    ['ai-review', 'ai-suggestion', 'cfo-briefing', 'chat-proposal'],
  );
});

// ---------------------------------------------------------------------------
// AiSuggestion adapter (one row = one item)
// ---------------------------------------------------------------------------

test('normalizeAiSuggestion maps a transaction-scoped suggestion', () => {
  const created = new Date('2026-05-10T12:00:00Z');
  const item = normalizeAiSuggestion({
    id: 7,
    kind: 'financial_insight',
    status: 'suggested',
    transactionId: 42,
    receiptId: null,
    output: { headline: 'Spending up' },
    createdAt: created,
    updatedAt: created,
  });
  assert.equal(item.id, 'ai-suggestion:7');
  assert.equal(item.source, 'ai-suggestion');
  assert.equal(item.subject_type, 'transaction');
  assert.equal(item.subject_id, '42');
  assert.equal(item.status_common, 'pending');
  assert.equal(item.native_status, 'suggested');
  assert.equal(item.created_at, created.toISOString());
  assert.equal(item.resolved_at, null);
  assert.equal((item.payload as { kind?: string }).kind, 'financial_insight');
});

test('normalizeAiSuggestion resolves subject to receipt + sets resolved_at when not pending', () => {
  const created = new Date('2026-05-10T12:00:00Z');
  const updated = new Date('2026-05-11T09:00:00Z');
  const item = normalizeAiSuggestion({
    id: 8,
    kind: 'receipt_extract',
    status: 'accepted',
    transactionId: null,
    receiptId: 99,
    output: null,
    createdAt: created,
    updatedAt: updated,
  });
  assert.equal(item.subject_type, 'receipt');
  assert.equal(item.subject_id, '99');
  assert.equal(item.status_common, 'resolved');
  assert.equal(item.resolved_at, updated.toISOString());
});

test('normalizeAiSuggestion with no FK has null subject', () => {
  const created = new Date('2026-05-10T12:00:00Z');
  const item = normalizeAiSuggestion({
    id: 9,
    kind: 'rule_proposal',
    status: 'suggested',
    transactionId: null,
    receiptId: null,
    output: { merchantPattern: 'X' },
    createdAt: created,
    updatedAt: created,
  });
  assert.equal(item.subject_type, null);
  assert.equal(item.subject_id, null);
});

// ---------------------------------------------------------------------------
// ChatProposal adapter (one row = one item, subject opaque)
// ---------------------------------------------------------------------------

test('normalizeChatProposal maps to chat-message subject + applied resolved_at', () => {
  const created = new Date('2026-05-12T08:00:00Z');
  const applied = new Date('2026-05-12T08:05:00Z');
  const item = normalizeChatProposal({
    id: 3,
    messageId: 55,
    kind: 'bulk_patch',
    status: 'applied',
    payload: { filter: { merchant: 'X' } },
    preview: { count: 4 },
    appliedAt: applied,
    createdAt: created,
    updatedAt: applied,
  });
  assert.equal(item.id, 'chat-proposal:3');
  assert.equal(item.source, 'chat-proposal');
  assert.equal(item.subject_type, 'chat-message');
  assert.equal(item.subject_id, '55');
  assert.equal(item.status_common, 'resolved');
  assert.equal(item.native_status, 'applied');
  assert.equal(item.created_at, created.toISOString());
  assert.equal(item.resolved_at, applied.toISOString());
  assert.deepEqual((item.payload as { preview?: unknown }).preview, { count: 4 });
});

test('normalizeChatProposal pending has null resolved_at', () => {
  const created = new Date('2026-05-12T08:00:00Z');
  const item = normalizeChatProposal({
    id: 4,
    messageId: 56,
    kind: 'transaction_edit',
    status: 'pending',
    payload: {},
    preview: {},
    appliedAt: null,
    createdAt: created,
    updatedAt: created,
  });
  assert.equal(item.status_common, 'pending');
  assert.equal(item.resolved_at, null);
});

// ---------------------------------------------------------------------------
// AiReviewRun adapter (one run = many action items)
// ---------------------------------------------------------------------------

test('normalizeReviewRunItems flattens action items into per-item review items', () => {
  const created = new Date('2026-05-01T00:00:00Z');
  const updated = new Date('2026-05-02T00:00:00Z');
  const items = normalizeReviewRunItems({
    id: 100,
    createdAt: created,
    updatedAt: updated,
    actionItems: [
      {
        id: 'a1',
        type: 'subscription',
        refType: 'transaction',
        refId: 42,
        severity: 'watch',
        title: 'Netflix',
        summary: 'recurring',
        status: 'suggested',
      },
      {
        id: 'a2',
        type: 'rule_suggestion',
        refType: 'rule',
        refId: null,
        severity: 'info',
        title: 'Make a rule',
        summary: 'coffee',
        status: 'accepted',
      },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'ai-review:100:a1');
  assert.equal(items[0].source, 'ai-review');
  assert.equal(items[0].subject_type, 'transaction');
  assert.equal(items[0].subject_id, '42');
  assert.equal(items[0].status_common, 'pending');
  assert.equal(items[0].native_status, 'suggested');
  assert.equal(items[0].created_at, created.toISOString());
  assert.equal(items[0].resolved_at, null);

  assert.equal(items[1].id, 'ai-review:100:a2');
  assert.equal(items[1].subject_type, 'rule');
  assert.equal(items[1].subject_id, null);
  assert.equal(items[1].status_common, 'resolved');
  assert.equal(items[1].resolved_at, updated.toISOString());
});

test('normalizeReviewRunItems on empty array returns empty', () => {
  const created = new Date('2026-05-01T00:00:00Z');
  const items = normalizeReviewRunItems({
    id: 101,
    createdAt: created,
    updatedAt: created,
    actionItems: [],
  });
  assert.equal(items.length, 0);
});

// ---------------------------------------------------------------------------
// CfoBriefing adapter (one briefing = many action items)
// ---------------------------------------------------------------------------

test('normalizeCfoBriefingItems flattens action items with open->pending mapping', () => {
  const created = new Date('2026-05-03T00:00:00Z');
  const updated = new Date('2026-05-04T00:00:00Z');
  const items = normalizeCfoBriefingItems({
    id: 200,
    createdAt: created,
    updatedAt: updated,
    actionItems: [
      {
        id: 'b1',
        type: 'safe_to_spend_low',
        refType: 'subscription',
        refId: 7,
        severity: 'action',
        title: 'Low safe-to-spend',
        summary: 'careful',
        status: 'open',
      },
      {
        id: 'b2',
        type: 'import_issue',
        refType: 'import',
        refId: 12,
        severity: 'watch',
        title: 'Import stuck',
        summary: 'fix it',
        status: 'resolved',
      },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'cfo-briefing:200:b1');
  assert.equal(items[0].source, 'cfo-briefing');
  assert.equal(items[0].subject_type, 'subscription');
  assert.equal(items[0].subject_id, '7');
  assert.equal(items[0].status_common, 'pending');
  assert.equal(items[0].native_status, 'open');
  assert.equal(items[0].resolved_at, null);

  assert.equal(items[1].subject_type, 'import');
  assert.equal(items[1].status_common, 'resolved');
  assert.equal(items[1].resolved_at, updated.toISOString());
});

// ---------------------------------------------------------------------------
// Merge + sort + cursor
// ---------------------------------------------------------------------------

function ri(id: string, createdAt: string): ReviewItem {
  return {
    id,
    source: 'ai-suggestion',
    subject_type: null,
    subject_id: null,
    payload: {},
    status_common: 'pending',
    native_status: 'suggested',
    created_at: createdAt,
    resolved_at: null,
  };
}

test('mergeAndSort orders by created_at desc, tie-broken by id desc for stability', () => {
  const merged = mergeAndSort([
    ri('a', '2026-05-01T00:00:00Z'),
    ri('c', '2026-05-03T00:00:00Z'),
    ri('b', '2026-05-02T00:00:00Z'),
    ri('z', '2026-05-03T00:00:00Z'), // same ts as c
  ]);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['z', 'c', 'b', 'a'],
  );
});

test('encodeCursor/decodeCursor round-trip an offset', () => {
  const cursor = encodeCursor({ offset: 50 });
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(decodeCursor(cursor), { offset: 50 });
});

test('decodeCursor returns offset 0 for null/garbage', () => {
  assert.deepEqual(decodeCursor(null), { offset: 0 });
  assert.deepEqual(decodeCursor('not-base64-json!!'), { offset: 0 });
  assert.deepEqual(decodeCursor(''), { offset: 0 });
});

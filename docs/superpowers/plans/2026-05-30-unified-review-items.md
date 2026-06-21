# Unified /review-items Read Endpoint + Inbox UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Add one `GET /api/review-items` read endpoint that fans out across AiSuggestion, AiReviewRun (action items), CfoBriefing (action items), ChatProposal and normalizes them into a common shape with a typed status-mapping table, plus a single filterable inbox UI replacing the AI inbox / AI reviews / CFO briefings / chat-proposals list surfaces.

**Architecture:** Read-side fold only. A pure normalization module (`backend/src/reviewItems/normalize.ts`) owns the status-mapping table and per-source → `ReviewItem` adapters. A thin route (`backend/src/routes/reviewItems.ts`) does parallel `Promise.all` fan-out (each bounded by `offset+limit`), merges, sorts by `created_at desc`, applies opaque cursor pagination. Writes stay 100% per-source. Frontend gets one `UnifiedInboxPage` that fetches `/api/review-items`, renders per-source card variants, and routes action buttons to the existing per-source write endpoints. Old routes redirect.

## Normalized shape

ReviewItem { id "{source}:{nativeId}"; source; subject_type; subject_id; payload; status_common; native_status; created_at; resolved_at }

## Status mapping table (typed const REVIEW_ITEM_STATUS_MAP)

- ai-suggestion: suggested→pending; accepted,edited→resolved; rejected,superseded,failed→dismissed
- ai-review: suggested→pending; accepted→resolved; dismissed→dismissed
- cfo-briefing: open→pending; resolved→resolved; dismissed→dismissed
- chat-proposal: pending→pending; applied→resolved; rejected→dismissed; expired→expired

## Normalization unit (key design call)

- ai-suggestion: one ROW. Scope householdId (aiSuggestionWhere). subject = transaction|receipt. resolved_at = updatedAt when not pending.
- chat-proposal: one ROW. Scope per-user via threadId→ChatThread.userId (NO householdId). subject_type chat-message. resolved_at = appliedAt||updatedAt.
- ai-review: one ACTION ITEM in AiReviewRun.actionItems[]. Scope householdId. nativeId={runId}:{itemId}. created_at=run.createdAt.
- cfo-briefing: one ACTION ITEM in CfoBriefing.actionItems[]. Scope householdId. nativeId={briefingId}:{itemId}.

## Tasks

1. Normalization module + status map + adapters + merge/sort/cursor — `backend/src/reviewItems/normalize.ts`, tested by `backend/test/reviewItemsNormalize.test.ts`. DONE.
2. Route `GET /api/review-items` + mount in app.ts — `backend/src/routes/reviewItems.ts`. DONE. Integration test `backend/test/integration/reviewItems.test.ts`. DONE.
3. Frontend `UnifiedInboxPage` + vitest tests — `frontend/src/pages/UnifiedInboxPage.tsx` + `.test.tsx`.
4. Routing + nav + redirects — `frontend/src/App.tsx`, `frontend/src/components/Sidebar.tsx`.
5. Full verification: backend test + test:integration + typecheck + lint; frontend test + tsc -b + lint.

## AC → test mapping

| AC | Test |
|---|---|
| query params status/source/limit/cursor | integration param tests |
| Fan-out parallel bounded by limit | route + integration limit test |
| Merge+sort created_at desc; cursor | unit mergeAndSort + integration pagination |
| Status mapping single typed const | unit REVIEW_ITEM_STATUS_MAP test |
| Write endpoints untouched | no diff to source write routers |
| One fixture/source + all-4 merge fixture | integration tests |
| One inbox page replaces 4 surfaces | App.tsx redirects + UnifiedInboxPage |
| Filter chips source/status/search | UnifiedInboxPage.test.tsx |
| Saved views default set | UnifiedInboxPage presets |
| Per-source cards → existing write endpoints | UnifiedInboxPage action tests |
| Old routes removed/redirect | App.tsx Navigate redirects |

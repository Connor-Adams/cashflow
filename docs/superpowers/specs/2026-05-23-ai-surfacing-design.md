# AI Surfacing — Design Spec

**Date**: 2026-05-23
**Status**: Draft, pending user approval
**Motivation**: "The AI feels underutilized." Root-cause investigation showed it isn't absent — there are 6+ AI backend modules and 5 frontend AI surfaces — but it's largely invisible. The Dashboard insights tile auto-runs but dissolves into the Bento grid. Audit/Rule-proposals require remembering to open the right page. Connor self-reports forgetting AI features exist.

This spec covers two changes designed to make the existing AI loud and reachable, without adding any new AI capability.

---

## Non-goals

- No new AI stages, no new prompts, no new schema columns on `transactions`.
- No automated/cron-driven AI runs. Audit stays manual-triggered.
- No multi-device "unread" sync. localStorage is sufficient for a single-household, low-user app.
- No notifications outside the app (email/push). In-app surfacing only.
- Import-cleanup hints are intentionally excluded from the inbox — they're per-import and not durable.

These non-goals are load-bearing. If the surfacing work doesn't shift behavior, the next move is presentation/prompting iteration, *not* schema or stage additions. Avoid feature accretion until usage proves the gap.

---

## Architecture

Two coordinated changes share one backend abstraction:

```
                                    ┌──────────────────────────┐
                                    │  ai_suggestions table    │
                                    │  (already exists)        │
                                    │                          │
                                    │  kind ∈ {                │
                                    │    transaction_audit,    │
                                    │    financial_insight,    │
                                    │    rule_proposal, ...    │
                                    │  }                       │
                                    │  status ∈ {              │
                                    │    suggested,            │
                                    │    accepted, edited,     │
                                    │    rejected, superseded  │
                                    │  }                       │
                                    └────────────┬─────────────┘
                                                 │
                            ┌────────────────────┴────────────────────┐
                            │                                         │
                ┌───────────▼────────────┐               ┌────────────▼───────────┐
                │ GET /api/ai/inbox      │               │ GET /api/ai/inbox/count│
                │ list of suggested rows │               │ {total, byKind}        │
                │ in 3 kinds, paginated  │               │ (cheap; for badge)     │
                └───────────┬────────────┘               └────────────┬───────────┘
                            │                                         │
                ┌───────────▼────────────┐               ┌────────────▼───────────┐
                │  /ai/inbox page        │               │  Nav badge component   │
                │  Part B                │               │  Part B                │
                └────────────────────────┘               └────────────────────────┘

                ┌──────────────────────────────────────────────────────┐
                │  DashboardPage AI insights tile (Part A)             │
                │  Reads same /api/ai/insights as today;               │
                │  presentation upgraded + cross-grid promotion banner │
                └──────────────────────────────────────────────────────┘
```

The whole design is a presentation layer over data that already exists. No migrations.

---

## Part A — Dashboard insights tile

### Changes to [DashboardPage.tsx:1308-1346](frontend/src/pages/DashboardPage.tsx:1308)

1. **Severity sort + colored badge**
   - Sort the `aiInsights.insights` array client-side by severity: `action` (0) → `watch` (1) → `info` (2), preserving relative order within a bucket.
   - Replace the `<span className="muted">{insight.severity}</span>` with a `<SeverityBadge severity={...}/>` component (new, in `frontend/src/components/ai/SeverityBadge.tsx`).
   - Color tokens follow the existing palette (`--danger`, `--warning`, `--info` or equivalents — confirm during plan). One dot + label per badge.

2. **Clickable supporting transactions**
   - Today: `Transactions: #{insight.supportingTransactionIds.join(', #')}` — plain text.
   - Target: each ID becomes a `<Link to={`/transactions?ids=${id}`}>#{id}</Link>`.
   - **Dependency**: TransactionsPage does NOT currently filter by an `ids` query param. This spec includes adding that filter. Behavior: when `?ids=1,2,3` is present, the page renders only those rows, ignoring other filters, with a dismissable banner "Filtered to N transactions from AI insight — clear filter."

3. **Suggested-action button (best-effort)**
   - The `suggestedAction` field is freeform text from the model. Adding a generic button to arbitrary text invites confusion.
   - Pragmatic rule: if `insight.supportingTransactionIds.length > 0`, render a single button **"Open these transactions"** that does the same as click-the-ID-link but for the whole set. The rest of `suggestedAction` stays as descriptive text below.
   - We do NOT try to parse `suggestedAction` into structured actions ("Audit Dining now") in this iteration. That requires backend changes to the insight schema. Out of scope; flagged for future.

4. **Promotion when loud**
   - Compute `hasActionSeverity = insights.some(i => i.severity === 'action')`.
   - If true:
     - Render a single-line banner at the top of the Bento grid (above the first row): *"AI flagged N action items this month"* with a "Jump to insights" link that scrolls/focuses the insights tile.
     - The tile's `span` widens from `4` to `6` (taking the full row).
   - If false: tile stays at `span={4}` with no banner.

5. **Unread state (localStorage)**
   - Key: `cashflow:ai-insights:lastSeen:<userId>` (or `:anon` if no auth in dev). Value: JSON array of seen signatures `${period}:${metric}:${title}` (capped at last 100; LRU).
   - On Dashboard mount: read seen set; insights whose signature isn't in the set render with a small leading dot (use existing `--accent` color).
   - When the user clicks anywhere inside an insight (link, button, or the article body), its signature is added to the seen set and persisted.
   - Refresh: when `aiInsights` changes, recompute the unseen subset on render — no extra effect needed.

### What does NOT change
- The `/api/ai/insights` endpoint and `buildFinancialInsights` logic are untouched.
- Other Bento tiles, currency switcher, date range, monthly chart — untouched.

---

## Part B — Global AI inbox + nav badge

### New backend endpoints

#### `GET /api/ai/inbox`

Query params:
- `kind` (optional, comma-separated): subset of `transaction_audit | financial_insight | rule_proposal`. Default: all three.
- `limit` (optional, default 50, max 200).
- `cursor` (optional, opaque): id of last row in previous page.

Response shape:
```json
{
  "items": [
    {
      "id": 123,
      "kind": "transaction_audit",
      "createdAt": "2026-05-23T...",
      "transactionId": 42,           // nullable
      "summary": "...",              // kind-specific one-liner
      "severity": "action",          // optional; only for financial_insight
      "confidence": "high",          // optional; only for transaction_audit
      "output": { ... },             // raw stored output for the renderer
      "promptVersion": "..."
    }
  ],
  "nextCursor": "121",
  "counts": { "total": 12, "byKind": { "transaction_audit": 5, "financial_insight": 4, "rule_proposal": 3 } }
}
```

Implementation:
- File: `backend/src/routes/ai.ts` (extends existing router).
- Two persisted streams: `AiSuggestion.findAll({ where: { ...aiSuggestionWhere(req), status: 'suggested', kind: { [Op.in]: ['transaction_audit', 'financial_insight'] } }, order: [['id','DESC']], limit, ... })`.
- One computed stream: `findRuleProposals(householdId)` returns proposals on demand from `transactions`. Projected into inbox item shape.
- Counts: derived from `items.length` grouped by kind (cheap; the inbox is bounded by `limit`).
- `summary` is computed per-kind by small renderer helpers:
  - `transaction_audit`: `Audit found ${output.issues.length} issue(s)` (the row is an audit-run aggregate; one inbox item per run, not per issue)
  - `financial_insight`: `${output[0].title}` plus a count if `output.length > 1`
  - `rule_proposal`: `${merchantPattern} → ${category} (×${supportCount})`

#### `GET /api/ai/inbox/count`

Lightweight variant returning only `{ total, byKind }`. Used by the nav badge to avoid shipping full item payloads on every poll.

### Insights deduplication (in scope)

Today, every Dashboard load creates a new `financial_insight` row at [routes/ai.ts:270](backend/src/routes/ai.ts:270). Without deduplication, the inbox accumulates duplicates per `(household, currency, period)`.

**Fix**: in the insights route, before `createTrackedSuggestion`, update prior rows for the same triple from `status='suggested'` to `status='superseded'`. The triple is identifiable from the existing `inputSnapshot` (which should contain currency + period) — confirm and rely on that JSON shape, or pull period/currency into dedicated columns if necessary (prefer the former).

Open question to resolve in plan phase: do `transaction_audit` and `rule_proposal` also need a supersede pass? Audit findings should arguably stay until acted on (apply/reject), so no. Rule proposals likewise stay until approve/dismiss. Insights are the only stream that's recomputed on every read.

### Frontend

#### Nav (sidebar nav item, not top bar)

The app has a left-rail `Sidebar` at [frontend/src/components/Sidebar.tsx](frontend/src/components/Sidebar.tsx); there is no top nav. Add an "AI Inbox" item to `navItems`, with a count badge using the existing `<Badge>` component (variant `secondary` for non-zero; hidden when zero).

The count is supplied by a small `useAiInboxCount` hook (`frontend/src/hooks/useAiInboxCount.ts`):
- Fetches `/api/ai/inbox/count` on mount.
- Refetches on `window` focus and every 5 minutes.
- Returns `{ count: number, loading: boolean }`.
- Returns 0 + silent failure on fetch error (badge invisible on error; don't show stale).

The nav item is always present, even at count=0 — the inbox is the entry point for the AI surface; users need a path in even when nothing is pending.

#### `/ai/inbox` page

- File: `frontend/src/pages/AiInboxPage.tsx`. Add route in `App.tsx` as `<Route path="ai/inbox" element={<AiInboxPage />} />`.
- Layout: page header ("AI Inbox") + total count, segmented tabs (All / Audit / Insights / Rules) filtering client-side, then a vertical list of `<AiInboxItem>` rows.
- `<AiInboxItem>` is a kind-discriminated renderer:
  - `transaction_audit`: shows audit-run summary ("N issues found, M high confidence"). Actions: **"Open in Transactions"** (Link to `/transactions?ids=<csv of output.issues[].id>` — reuses the `?ids=` feature from Part A; the existing TransactionsPage audit dialog handles per-issue apply); **"Dismiss"** (POST `/api/ai/suggestions/:id/reject` — existing endpoint, works for any kind).
  - `financial_insight`: shows the first insight's title + comparison line. Actions: **"Open transactions"** (Link to `/transactions?ids=...` from `output.supportingTransactionIds`); **"Dismiss"** (same reject endpoint).
  - `rule_proposal`: shows pattern → category with support count. Actions: **"Approve"** (POST `/api/ai/rule-proposals/:merchantPattern/approve` — existing); **"Dismiss"** (POST `/api/ai/rule-proposals/:merchantPattern/dismiss` — NEW; creates an `AiSuggestion` row with `kind='rule_proposal'`, `status='rejected'`, `inputSnapshot={ merchantPattern }`).
- Approval/dismissal optimistically removes the item from the list. On failure the item is restored at its original index with an inline error.
- Empty state: friendly message, link back to Dashboard.

#### Rule-proposal dismissal persistence

Since rule proposals are computed each request, dismissal needs durable storage. Add:
- New endpoint: `POST /api/ai/rule-proposals/:merchantPattern/dismiss` — creates `AiSuggestion{ kind: 'rule_proposal', status: 'rejected', inputSnapshot: { merchantPattern } }`.
- `findRuleProposals` extended to filter out patterns that appear in any `AiSuggestion` with `kind='rule_proposal'` AND `status='rejected'` for the same household. Mirror the existing exclusion against `Rule.merchantPattern`.

#### No new "unread" tracking on the inbox page itself
Items naturally leave the list when their status changes from `suggested`. That's the unread semantic — no localStorage needed for the inbox.

---

## Data flow

```
Dashboard mount
  → fetch /api/ai/insights (existing, unchanged)
  → render tile with severity sort + clickable IDs + unread dots
  → if any action-severity: render banner + widen tile

App shell mount
  → AiInboxBadge mounts
  → poll /api/ai/inbox/count
  → render chip if total > 0
  → click → navigate to /ai/inbox

AiInboxPage mount
  → fetch /api/ai/inbox?limit=50
  → render segmented list (3 streams)
  → user actions per kind:
    transaction_audit → "Open in Transactions" (navigate) | "Dismiss" (reject endpoint)
    financial_insight → "Open transactions" (navigate)    | "Dismiss" (reject endpoint)
    rule_proposal     → "Approve" (existing endpoint)     | "Dismiss" (new dismiss endpoint)
  → on success: optimistically remove item; next badge poll reflects reduced count
  → on failure: restore item at original index + show inline error
```

---

## Error handling

- `/api/ai/inbox` and `/inbox/count`: standard route-level error handling; on failure return 500. Frontend badge: on fetch failure, log to console and hide the chip (don't show stale data; don't show an error in chrome). Frontend page: on fetch failure, render an inline error with retry.
- Optimistic mutations: if Apply/Reject/Approve fails, re-add the item to the list and surface a toast/error inline.
- Insights supersede pass: wrap in try/catch; if it fails (e.g., bad JSON in old `inputSnapshot`), log and continue — never block insight creation.

---

## Testing

### Backend
- `backend/src/routes/ai.ts` (new tests in adjacent test file):
  - `/api/ai/inbox` returns only `status='suggested'` rows in the three kinds.
  - Household scoping: rows from another household are not returned.
  - `kind` query param filters correctly.
  - `/api/ai/inbox/count` matches `items.length` totals.
  - Insights supersede: calling `/api/ai/insights` twice for the same period leaves exactly one `suggested` row for that triple.

### Frontend
- `SeverityBadge` — snapshot or testing-library render per severity value.
- `AiInboxBadge` — renders nothing when count=0; renders chip when count>0; navigates on click.
- `AiInboxPage` empty state, list state, and Apply/Dismiss optimistic removal.
- `DashboardPage` insights tile: with no insights, with all `info`, with at least one `action` (verifies promotion + banner).

### Manual
- Open Dashboard with both empty and populated insights; verify dots, promotion, banner.
- Open inbox, apply an audit suggestion, verify it disappears and the nav badge decrements.
- Open inbox in a second browser session with another household — verify scoping.

---

## Resolved during plan-phase exploration

1. **`inputSnapshot` for insights**: already includes `{ period, currency }` (verified at [routes/ai.ts:273](backend/src/routes/ai.ts:273)). Supersede pass uses `JSON_EXTRACT` via `sequelize.literal` against this JSON (codebase already uses `sequelize.fn`/`sequelize.literal` patterns elsewhere).
2. **Nav placement**: app uses a left-rail `Sidebar` ([frontend/src/components/Sidebar.tsx](frontend/src/components/Sidebar.tsx)) with `navItems` array. Badge becomes a new nav item with `<Badge>` overlay.
3. **`ids=` filter on TransactionsPage**: existing query params (category/currency/dateFrom/dateTo/importBatch/reviewFlag) read in [TransactionsPage.tsx:185-190](frontend/src/pages/TransactionsPage.tsx:185). `ids` is additive — when present, the request includes it AND other filters; the backend `/api/transactions` endpoint must accept and filter on it.
4. **Color tokens**: reuse existing `<Badge>` variants — `destructive` (action), `secondary` (watch), `outline` (info). No new variants needed.
5. **`rule_proposal` rows are NOT persisted today** (`findRuleProposals` computes from SQL on every call). Inbox endpoint must call `findRuleProposals` for that stream. Dismissal persists as a stub `AiSuggestion` row.
6. **`transaction_audit` rows are aggregates** (`output.issues` is an array). Inbox shows one item per audit run; the existing per-issue apply UX in TransactionsPage handles drill-down.
7. **`/api/ai/suggestions/:id/apply` only handles `kind='transaction_fields'`** ([suggestionStore.ts:100](backend/src/ai/suggestionStore.ts:100)). Inbox does not offer in-place apply for audit/insight; users navigate into context to act.

---

## Out of scope (deliberately deferred)

- Subcategory or tags fields on `transactions` (rejected during brainstorming — no concrete motivation).
- New SignalSource entries in `computeReviewFlag` precedence ladder.
- Audit cron / scheduled AI runs.
- Push notifications, email digests.
- Inline AI hints on TransactionsPage rows (this is "Approach C" from brainstorming — revisit if A+B don't shift behavior).
- Import-cleanup in inbox.
- Structured `suggestedAction` schema with action verbs + endpoints.

If A+B ship and Connor still feels AI is underutilized, the next iteration looks at the *content* of insights/audit findings, not adding more surfacing.

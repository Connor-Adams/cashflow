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
- Query: `AiSuggestion.findAll({ where: { ...aiSuggestionWhere(req), status: 'suggested', kind: { [Op.in]: kinds } }, order: [['id','DESC']], limit, ... })`.
- `summary` is computed per-kind in the route via small per-kind helpers:
  - `transaction_audit`: `${currentCategory} → ${suggestedCategory} (${confidence})` from `output`
  - `financial_insight`: `${title}` from `output`
  - `rule_proposal`: `${merchantPattern} → ${suggestedCategory}` from `output`
- Counts are computed in the same query (separate `findAll` aggregation, or in-memory from a single fetch limited to a sane upper bound — pick during plan based on dataset size).

#### `GET /api/ai/inbox/count`

Lightweight variant returning only `{ total, byKind }`. Used by the nav badge to avoid shipping full item payloads on every poll.

### Insights deduplication (in scope)

Today, every Dashboard load creates a new `financial_insight` row at [routes/ai.ts:270](backend/src/routes/ai.ts:270). Without deduplication, the inbox accumulates duplicates per `(household, currency, period)`.

**Fix**: in the insights route, before `createTrackedSuggestion`, update prior rows for the same triple from `status='suggested'` to `status='superseded'`. The triple is identifiable from the existing `inputSnapshot` (which should contain currency + period) — confirm and rely on that JSON shape, or pull period/currency into dedicated columns if necessary (prefer the former).

Open question to resolve in plan phase: do `transaction_audit` and `rule_proposal` also need a supersede pass? Audit findings should arguably stay until acted on (apply/reject), so no. Rule proposals likewise stay until approve/dismiss. Insights are the only stream that's recomputed on every read.

### Frontend

#### Nav badge

- Location: top-right of the existing nav, beside the user menu (confirm during plan; reuse existing `Nav.tsx` or whatever the actual file is).
- Component: `<AiInboxBadge />` in `frontend/src/components/ai/AiInboxBadge.tsx`.
- Behavior: on mount, fetch `/api/ai/inbox/count`. Re-fetch on `window` focus and every 5 minutes. Click → `useNavigate('/ai/inbox')`.
- Always visible (even when count is 0) — an icon-only "AI" affordance, with a count chip overlay when > 0. Always-visible matters because the inbox is also where the user reviews dismissed / superseded history if we add filters later; if the badge vanishes at 0, the user loses the entry point.

#### `/ai/inbox` page

- File: `frontend/src/pages/AiInboxPage.tsx`. Add route in the existing router.
- Layout: page title "AI Inbox" + total count, segmented tabs (All / Audit / Insights / Rules) that filter the list client-side, then a vertical list of `<AiInboxItem>` rows.
- `<AiInboxItem>`: kind-specific renderer using a small switch:
  - `transaction_audit`: shows current vs suggested category/business; "Apply" calls existing `POST /api/ai/suggestions/:id/apply`, "Dismiss" calls existing `POST /api/ai/suggestions/:id/reject`. Optimistically remove from list on success.
  - `financial_insight`: shows summary + comparison; "Open transactions" links to `/transactions?ids=...` (same as Part A); "Dismiss" calls reject endpoint.
  - `rule_proposal`: shows pattern → category; "Approve" calls existing `POST /api/ai/rule-proposals/:merchantPattern/approve`; "Dismiss" calls reject.
- Empty state: friendly message, link back to Dashboard.

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
  → render segmented list
  → user clicks Apply / Dismiss / Approve
    → existing endpoint mutates AiSuggestion.status
    → optimistically remove item from list
    → next badge poll picks up reduced count
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

## Open questions to resolve in the implementation plan

1. **`inputSnapshot` shape for insights**: does it already include `currency` + `period`? If not, decide between adding fields to the JSON vs new dedicated columns.
2. **Nav placement**: which existing component file mounts the nav/header? The badge needs a host.
3. **`ids=` filter on TransactionsPage**: confirm no conflict with existing query params. Decide ordering vs other filters (this spec says: ids overrides other filters).
4. **Color tokens**: which existing CSS vars map to `action`/`watch`/`info` severities? Reuse Honey/Ink palette tokens, don't invent new ones.

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

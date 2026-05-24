# Enrichment tab redesign

**Date:** 2026-05-24
**Scope:** Single tab — `frontend/src/pages/settings/tabs/EnrichmentTab.tsx` (~400 LoC today)
**Status:** Design

## Goal

Replace the current EnrichmentTab with a workflow-fused dashboard. Today the tab leads with a 200-line backfill form and surfaces stats as flat `<ul>` lists with inline styles. Users (Connor: "settings UI needs a lot of work") complained the stats are unreadable, the backfill is too prominent, the tab is missing functionality, and it looks unpolished.

The redesign fuses two roles into one screen:
- **Workflow:** "what needs your attention right now" (the review backlog)
- **Dashboard:** at-a-glance enrichment health (volumes, confidence, sources, top rules/merchants)

## Non-goals

- Not adding rule CRUD to the tab. `/rules` (`frontend/src/pages/RulesPage.tsx`) already has full create/edit/delete + AI proposals; this redesign deep-links into it.
- Not building a new review queue. `/review` (`ReviewInboxPage.tsx`) already exists; the workflow tile deep-links into it.
- Not changing the `/api/transactions/enrichment/stats` response shape. Frontend consumes today's payload as-is.
- Not adding backfill history persistence. "Last backfill ran X ago" is excluded until the backend tracks it.
- Not touching the four sibling settings tabs (Imports, Contacts, Budgets, Settings/Display/Gmail/Partner).
- No backwards-compat shims. The old `EnrichmentTab.tsx` body is replaced wholesale.

## Current state (what we're replacing)

`frontend/src/pages/settings/tabs/EnrichmentTab.tsx` renders two `<Card>` blocks:

1. **Enrichment maintenance** (~lines 144–273): backfill form + streaming progress feed. Three controls (clear-review checkbox, review-only checkbox, row limit), Dry-run / Run buttons, monospace streaming row feed, error details.
2. **Enrichment dashboard** (~lines 275–398): stats grid. Six floating count blocks, then three `<ul>` lists for source/confidence/type breakdowns, then two `<ul>` lists for top merchants and top rules.

Pain points:
- Inline styles everywhere (`style={{ gap: '0.5rem', marginTop: '0.75rem' }}` etc.) — bypasses the design system
- `<div>` blocks duplicate work the `StatCard` primitive (`frontend/src/components/ui/stat-card.tsx`) already does
- Flat `<ul>` lists for source/confidence/type carry no visual signal — can't tell at a glance whether enrichment is healthy
- Backfill form is always-on, takes the top of the page, drowns the dashboard
- Top firing rules and top merchants are read-only dumps with no way to act on them

## Proposed layout

Single scroll, five sections top to bottom. All visible by default (nothing collapsed). Workflow lives **inside** the dashboard row, not above it.

```
┌───────────────────────────────────────────────────────────────────┐
│ Settings › Enrichment    (existing page header via SettingsPage)   │
├───────────────────────────────────────────────────────────────────┤
│ ┌──────────────┬──────┬──────┬──────┬──────┬──────┐               │
│ │ NEEDS REVIEW │Total │Clear │Recur │Refund│Trans │  ← row 1      │
│ │ 2,341  15%   │15,247│12,906│ 847  │ 98   │ 312  │     stats     │
│ │ 62% low-conf │      │      │      │      │      │               │
│ │ [Open queue→]│      │      │      │      │      │               │
│ └──────────────┴──────┴──────┴──────┴──────┴──────┘               │
│                                                                     │
│ ┌─────────────────────────┬─────────────────────────┐             │
│ │ Confidence distribution │ By source               │  ← row 2    │
│ │ [stacked bar + legend]  │ [hbar list]             │     charts  │
│ └─────────────────────────┴─────────────────────────┘             │
│                                                                     │
│ ┌─────────────────────────┬─────────────────────────┐             │
│ │ Top firing rules        │ Top canonical merchants │  ← row 3    │
│ │ pattern · n · [Edit]    │ name · n · [View]       │     lists   │
│ │ … 4–6 rows              │ … 4–6 rows              │             │
│ │  [Manage rules →]       │                         │             │
│ └─────────────────────────┴─────────────────────────┘             │
│                                                                     │
│ ┌───────────────────────────────────────────────────┐             │
│ │ Backfill enrichment           [Admin action pill] │  ← row 4    │
│ │ Re-runs pipeline on every household txn…          │     admin   │
│ │ [✓] Clear review flag [ ] Review-only  [limit]    │             │
│ │                              [Dry run] [Run]      │             │
│ └───────────────────────────────────────────────────┘             │
│ (streaming progress feed unfurls inline below when running)        │
└───────────────────────────────────────────────────────────────────┘
```

### Section 1 — Stat row (workflow + dashboard, fused)

- **Grid:** `grid-template-columns: 1.6fr repeat(5, 1fr)` on desktop, collapses to `repeat(2, 1fr)` then `1fr` at narrower viewports
- **Workflow tile (1.6fr wide):** wraps `Card` with `bg-warning-bg`, `text-warning-foreground` token classes (rust-50/700 light, rust-800/100 dark). Contents:
  - Label "Needs review" (uppercase 0.68rem, `--warning-foreground` muted variant)
  - Count + percent of total (1.7rem bold)
  - Subtitle: "{lowConfidencePct}% low-confidence" (no oldest-date until backend tracks it)
  - Primary button: "Open review queue →" → navigates to `/review`
  - When `reviewFlagTrue === 0`: the tile renders as a plain `<StatCard label="In review" value="0" />` (same column width 1.6fr, no warning styling, no CTA). Grid layout stays identical between empty and non-empty states.
- **Five dashboard tiles:** `<StatCard>` for Total, Cleared, Recurring, Refunds linked, Transfers linked. "Cleared" uses `text-success` (jade) as a soft positive accent on its value.
- Numbers use `font-variant-numeric: tabular-nums` so digits align across tiles.

### Section 2 — Charts (two cards, side-by-side)

Both render via `recharts` (already in `package.json`):

- **Confidence distribution** (`Card`): horizontal stacked bar — high / medium / low / none. Uses `var(--success)`, `var(--primary)` (amber), `var(--warning)` (rust), `var(--muted-foreground)` (stone). Legend below shows label + count per band. Order is fixed high→none regardless of input ordering.
- **By source** (`Card`): horizontal `<BarChart>` per source key (rules / ai / manual / none). Label, bar (using `var(--chart-2)` for rules, `var(--chart-3)` for ai, `var(--chart-5)` for manual, `var(--border)` for none), count + percent. Sort desc by count.

The "By type" breakdown is dropped — `txn_type` distribution is low-signal here (transfer/payment/etc. duplicate stats elsewhere).

### Section 3 — Top rules + Top merchants (read-only, deep-link out)

Two `Card`s side-by-side. Each shows up to 6 rows from the existing payload:

- **Top firing rules** — three columns per row: `<code>pattern</code>` → category, count, `View` link. Header has "Manage rules →" link to `/rules`. Each row's `View` deep-links to `/rules?focus=<ruleId>` (scrolls + highlights the row on the rules page; editing the rule still happens by deleting + recreating via the existing form).
- **Top canonical merchants** — two columns per row: name, count. **Read-only** (no deep-link). Backend transactions filter has no `merchant` support today; adding it is filed as a follow-up PR. When the filter ships, this card grows a `View` link in a follow-up.

Empty states reuse existing copy ("None yet. Run the backfill to populate." / "No rule matches recorded yet.").

### Section 4 — Backfill (visible, quieter)

Single `Card`, full width.

- Header: title + 1-line description + plum "Admin action" pill (uses `--accent` / `--accent-foreground`)
- Controls in one row, flex-wrap: two checkboxes (clear review flag, review-only mode), row limit input, then right-aligned `Dry run` (secondary) and `Run backfill` (primary)
- Below: when `backfillRunning || backfillLive || backfillSummary`, the existing streaming feed renders inline. Keep the current `aria-live="polite"` log, error details, summary line.

All current backfill logic (NDJSON streaming, throttled flushes, confirm dialog on real run) is preserved verbatim — only the markup and styling change.

## Component breakdown

- `EnrichmentTab.tsx` — top-level container, holds state (stats fetch, backfill stream — same as today), composes sections 1–4
- `EnrichmentStatRow.tsx` (new) — pure presentational, takes `EnrichmentStats`, renders the 6-tile grid including the workflow tile
- `EnrichmentConfidenceChart.tsx` (new) — pure, takes `byConfidence: Record<string, number>`, renders stacked bar + legend
- `EnrichmentSourceChart.tsx` (new) — pure, takes `bySource: Record<string, number>`, renders horizontal bar list
- `EnrichmentTopLists.tsx` (new) — pure, takes `topRules` and `topCanonicalMerchants`, renders two cards with deep-links
- `EnrichmentBackfillCard.tsx` (new) — owns backfill form + streaming feed; lifts that block out of the tab so the tab file shrinks to layout-only

Each component is ≤120 LoC. Splitting buys two things: shorter `EnrichmentTab.tsx` (target ~80 LoC) and per-component tests.

## Data flow

No backend changes. `GET /api/transactions/enrichment/stats` already returns:

```ts
{
  total, reviewFlagTrue, reviewFlagFalse, reviewedTrue,
  bySource, byConfidence, byTxnType,       // Record<string, number>
  isRecurringCount, refundLinkedCount, transferLinkedCount,
  topCanonicalMerchants: Array<{ name, count }>,
  topRules: Array<{ ruleId, pattern, category, count }>,
}
```

Two derived values computed client-side for the workflow tile:
- `lowConfidencePct = round((byConfidence['low'] ?? 0) / max(reviewFlagTrue, 1) * 100)`
- The "oldest review-flagged date" sub-string shown in earlier mockups is **dropped** — backend doesn't track it yet. Filing as a follow-up: extend `/enrichment/stats` with `oldestReviewFlaggedAt = SELECT MIN(date) FROM transactions WHERE review_flag AND household_id = ?` so the subtitle can include it later.

`POST /api/transactions/enrichment/backfill?stream=1` — unchanged.

## Deep-link wiring

One cross-page deep-link the redesign introduces:

1. **`/rules?focus=<ruleId>`** — RulesPage reads `focus` on mount, scrolls the matching `<tr>` into view, and applies a temporary `.isFocused` highlight class (CSS animation, ~2s). RulesPage rows are not inline-editable today (only Delete + recreate via the top form), so "focus" means **locate**, not **edit**. New code in `RulesPage.tsx`, ~20 LoC + a few lines of CSS. If `focus` is missing, behavior is unchanged.

The merchant deep-link from the top-merchants card is intentionally dropped — backend transactions filter has no merchant predicate today and adding it (backend `buildTransactionFilterWhere`, dialect-safe LIKE, frontend filter state + FilterBar UI) is too much for this PR. Filed as a follow-up; the View link can be added then.

## Styling discipline

- No `style={{...}}` inline objects in the new components. Everything goes through Tailwind utility classes against design tokens (`bg-card`, `text-foreground`, `border-border`, `text-warning-foreground`, etc.) or named classes in `App.css`.
- Two new `App.css` classes if any utility composition repeats more than twice (e.g., `.enrichStatGrid`, `.enrichWorkflowTile`). Default to Tailwind first; only promote to a class when reused.
- No new color hex values. All semantic accents come from `--success`, `--warning`, `--accent`, `--primary`, `--muted-foreground`.

## Testing

- `EnrichmentTab.test.tsx` (exists) — update to assert: workflow tile renders when `reviewFlagTrue > 0`; CTA links to `/review`; stats grid renders 6 tiles; backfill card present
- `EnrichmentStatRow.test.tsx` — workflow-tile-visible vs hidden cases, derived percentage math
- `EnrichmentConfidenceChart.test.tsx` — handles missing keys, zero counts, unknown keys (`(none)`)
- `EnrichmentSourceChart.test.tsx` — sort order, percentage rounding
- `EnrichmentTopLists.test.tsx` — deep-link href construction (URL-encoded merchant names with spaces/punctuation), empty states
- `EnrichmentBackfillCard.test.tsx` — extract the existing backfill assertions from `EnrichmentTab.test.tsx` and the integration covering streaming/confirm/error paths
- `settings-routing.integration.test.tsx` — no change required; route stays the same

## Risks / open questions

- **Workflow tile when zero review backlog** — design says render as a plain StatCard ("In review: 0") at the same 1.6fr width. Picked over hiding entirely so column count doesn't shift between states.
- **Recharts bundle size** — already imported elsewhere (DashboardPage, PortfolioPage), no incremental cost.

## Out of scope (deferred follow-ups)

- Backfill run history (would let us show "last run 2h ago, processed 12,489").
- Time-series of review backlog (would let us show "+128 vs last week").
- Backend + frontend merchant filter on `/transactions` (unlocks the `View` link on top-merchants card).
- `oldestReviewFlaggedAt` field on `/enrichment/stats` (unlocks the workflow tile's "oldest" subtitle).
- Inline rule editing on the tab.
- Touching the other four settings tabs.

The first two unlock signal the dashboard would benefit from but require new backend tables. Filing as follow-ups if/when the foundational redesign ships.

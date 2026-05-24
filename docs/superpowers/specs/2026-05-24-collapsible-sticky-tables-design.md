# Collapsible Sticky Tables — Design

Status: approved
Date: 2026-05-24
Branch: `claude/quizzical-faraday-820e71`

## Goal

When a user scrolls a long page of stacked tables (Reports, Recurring, Accounts), the column headers of the table they are currently looking at should remain pinned to the top of the viewport so the row context stays legible. Each table-card section should also be collapsible via a chevron in its header, so users can hide whole sections they don't care about right now.

## Non-goals

- Persisting collapse state across reloads (session-only).
- URL or query-string sync of collapse state.
- Touching the Review Inbox, which already has its own sticky thead pattern
  (`.reviewInboxTableWrap { max-height: 70vh }` + `.reviewInboxTable thead th { sticky top-0 }`).
- Mobile horizontal-scroll fallback for wide tables (accepted trade-off; see CSS section).

## User decisions

| Question                       | Choice                                                                  |
| ------------------------------ | ----------------------------------------------------------------------- |
| Scope                          | Reports + Accounts + other big lists (wide app-wide, where applicable)  |
| Collapse persistence           | Session only (component state)                                          |
| Chevron placement              | Right edge of section header; whole header clickable                    |

## Architecture

### New shared primitive — `frontend/src/components/ui/collapsible-card.tsx`

```tsx
type CollapsibleCardProps = {
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode      // rendered in header; clicks do NOT toggle
  defaultOpen?: boolean          // default: true
  className?: string             // forwarded to outer <section>
  children: React.ReactNode
}
```

Renders a `<section className="card ...">` with a header row containing:

- Title block (h2 + optional muted description) — left
- Optional `actions` slot — middle/right, wrapped in a div that stops click propagation
- Chevron toggle `<button>` — right; `ChevronDown` when open, `ChevronRight` when collapsed; `aria-expanded`, `aria-controls`

State: `useState(defaultOpen)`. Children are unmounted when collapsed (no `display: none` keep-alive — simpler, frees DOM, matches user's session-only preference).

The whole header is itself a `<button>`, so clicking title or empty space toggles. `actions` slot uses `onClick={(e) => e.stopPropagation()}` so action buttons inside (e.g. "Record settlement", "Export CSV", currency selector) work normally.

### CSS — `frontend/src/App.css`

- `.tableWrap`: drop `overflow-auto`. Keep border/bg/rounded. This is the wrapper inside each section.
- `.table th`: add `position: sticky; top: 0; z-index: 1;` plus an **opaque** background (currently semi-transparent — rows would show through when scrolling under). Use `background: var(--bg2)` with a subtle border-bottom for visual separation when sticky.

### CSS — `frontend/src/components/ui/table.tsx`

- Drop `overflow-x-auto` from the outer wrapper div. This is the trap: any overflow ancestor (even x-only) confines `position: sticky` vertically. With overflow dropped from both wrappers, sticky resolves against the window scroll.

**Trade-off**: wide tables on narrow viewports lose their horizontal auto-scroll inside the card. Acceptable for the report/account/recurring tables on desktop. If a specific table needs it back, add `overflow-x-auto` to a localized wrapper at that call site only.

### Call sites

Refactor these `<section className="card ...">` + `<div className="reportsCardHeader">` (or `accountsCardHeader`) shells into `<CollapsibleCard>`:

1. `frontend/src/pages/ReportsPage.tsx`
   - Partner split totals section
   - Business expenses section
   - Recent settlements section (its "Record settlement" button stays in `actions`)
   - `RankedReportSection` (Merchants + Accounts): rewrite its body to compose `CollapsibleCard` instead of hand-rolling the section/header

2. `frontend/src/pages/RecurringPage.tsx`
   - The recurring-merchants table section (currently `<section className="card">` wrapping just `tableWrap`). Promote to `CollapsibleCard` with title "Recurring merchants".

3. `frontend/src/pages/AccountsPage.tsx`
   - "Your accounts" `<Card className="accountsTableCard">` → swap for `CollapsibleCard`. The `Badge` count moves into `actions`.

4. `frontend/src/pages/ReviewInboxPage.tsx` — **skip**. Already has bespoke sticky thead + max-height scroll pattern.

## Lucide icons

`ChevronDown` and `ChevronRight` from `lucide-react`. Package already at `^1.14.0` and used throughout (`Download`, `Plus`, `Trash2`, `Keyboard`, `ListChecks`).

## Testing

- Extend `frontend/src/components/ui/localPrimitives.test.tsx` with `CollapsibleCard` cases:
  - default-open renders children + `ChevronDown`, `aria-expanded="true"`
  - default-closed (`defaultOpen={false}`) renders no children + `ChevronRight`, `aria-expanded="false"`
  - clicking the toggle flips state
  - clicking inside the `actions` slot does NOT toggle
- Existing page tests (Reports / Accounts / Recurring / Enrichment) should pass unchanged because all sections default open.
- Manual: load the Reports page in dev server, scroll, confirm sticky thead behavior and chevron collapse.

## Risks / open questions

- **App-wide sticky `.table th`**: this rule applies to every `.table` in the app. Any table currently inside a vertically-scrollable container with bespoke layout (Review Inbox already has its own override; others to spot-check during verification) could behave differently. Mitigation: review-inbox already uses its own classes and overrides; spot-check pages during manual QA.
- **Opaque th background**: current semi-transparent value tracks the card surface tone. The opaque variant chosen (`var(--bg2)`) may look slightly heavier; tweak shade during implementation if it clashes in either theme.
- **`RankedReportSection` rewrite**: it is the cleanest place for the change, but its current `totalColumns` calc and currency-column logic must be preserved verbatim.

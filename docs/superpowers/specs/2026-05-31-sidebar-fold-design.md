# Sidebar fold: 46 → 16 — design

**Date:** 2026-05-31
**Status:** approved design, pre-plan
**Owner:** Connor
**Supersedes framing of:** [#290](https://github.com/Connor-Adams/cashflow/issues/290) (group nav into collapsible sections — shipped, did not reduce noise)

## Problem

`frontend/src/components/Sidebar.tsx` renders **46 nav items** across 6 collapsible
sections. Issue #290 added the sections; the item count then tripled, so each section
became a dumping ground. The real defect is not visual density — it is that **most
nav items are different views of a primitive that already has its own page.** A
route-by-route audit (2026-05-31, verified against page source + API endpoints)
found only ~19 distinct primitive pages; ~24 are views/derivations/variants of an
existing primitive, and 3 are settings/admin chrome on the primary rail.

This is the CLAUDE.md primitives-spine rule ("do not fork same-machine objects")
violated at the UI layer. The fix is to fold same-primitive views into tabs/filters
inside the owning page, move chrome under Settings, and fix two mis-files.

## Audit map (the data this design rests on)

Buckets:

- **A — genuine redundancy:** a view/derivation/variant of a primitive that already
  has a page. Becomes a `?view=` tab on the parent; old route → redirect.
- **B — same primitive family, own status machine:** keep the page intact, but mount
  it as a tab on the family parent (no delete).
- **C — chrome:** belongs under Settings, not the main rail.

| Old route | Page component | Verdict | New home |
|---|---|---|---|
| `/refunds` | RefundsReviewPage | A · FILTER_OF(Transaction) | `/transactions?view=refunds` |
| `/transfers` | TransfersPage | A · FILTER_OF(Transaction) | `/transactions?view=transfers` |
| `/purchases` | PurchasesPage | A · VARIANT_OF(Transaction) | `/transactions?view=purchases` |
| `/large-purchases` | LargePurchasesPage | A · FILTER_OF(Transaction) | `/transactions?view=large` |
| `/return-warranty` | ReturnWarrantyPage | A · FILTER_OF(Transaction) | `/transactions?view=returns` |
| `/items` | ItemsPage | A · DERIVATION_OF(Transaction) | `/transactions?view=items` |
| `/search` | SearchPage | A · DERIVATION_OF(Transaction) | `/transactions?view=search` |
| `/money-leaks` | MoneyLeaksPage | A · DERIVATION_OF(Transaction) | `/transactions?view=leaks` |
| `/calendar` | CalendarPage | A · FILTER_OF(Expectation) | `/planned?view=calendar` |
| `/forecast` | ForecastPage | A · DERIVATION_OF(Expectation) | `/planned?view=forecast` |
| `/recurring` | RecurringPage | A · DERIVATION_OF(Transaction) | `/planned?view=recurring` |
| `/subscriptions` | SubscriptionsPage | B · OWN(Expectation) | `/planned?view=subscriptions` |
| `/reimbursements` | ReimbursementsPage | B · OWN(Expectation) | `/planned?view=reimbursements` |
| `/opportunity-cost` | OpportunityCostPage | A · DERIVATION_OF(Scenario) | `/scenarios?view=opportunity-cost` |
| `/tax` | TaxPage | B · OWN(Scenario) | `/scenarios?view=tax` |
| `/credit-cards` | CreditCardPlannerPage | A · FILTER_OF(Account) | `/accounts?view=credit-cards` |
| `/debt` | DebtPage | A · VARIANT_OF(Account) | `/accounts?view=debt` |
| `/statements` | StatementsPage | B · OWN(Document) | `/accounts?view=statements` |
| `/net-worth` | NetWorthPage | A · DERIVATION_OF(Account+Holding) | `/portfolio?view=net-worth` |
| `/reports/explain-month` | ExplainMonthPage | A · REPORT_SUBROUTE | `/reports?view=explain-month` |
| `/reports/lifestyle-inflation` | LifestyleInflationPage | A · REPORT_SUBROUTE | `/reports?view=lifestyle` |
| `/reports/savings-rate` | SavingsRatePage | A · REPORT_SUBROUTE | `/reports?view=savings` |
| `/sankey` | SankeyPage | A · DERIVATION_OF(Transaction) | `/reports?view=cashflow` |
| `/partner` | PartnerFairnessPage | A · DERIVATION_OF(Transaction) | `/reports?view=partner` |
| `/currency` | CurrencyPage | A · DERIVATION_OF(Transaction) | `/reports?view=currency` |
| `/amazon` | AmazonPage | A · VARIANT_OF(Transaction), **mis-filed** | `/import?view=amazon` |
| `/ask` | AskCashflowPage | A · subset of Chat | `/chat` |
| `/review` | ReviewInboxPage | A · VARIANT_OF(Transaction), **data-layer caveat** | `/inbox` (PR 5) |
| `/audit-log` | AuditLogPage | C · chrome | `/settings/audit-log` |
| `/sync` | SyncPage | C · chrome | `/settings/backup` |

**Keepers (16 top-level):** Dashboard, Transactions, Accounts, Import, Planned, Goals,
Scenarios, Portfolio, Inbox, Insights, Rules, Reports, Monthly close, Vault, Chat,
Settings.

**Mis-files fixed:** Amazon (was under *Investments*; it is a Transaction import
source → Money/Import). Credit cards (was under *Planning*; it is an Account type →
Money/Accounts).

## Target rail (16 items, 7 sections)

Reuses the existing `NavSection` + collapsible machinery in `Sidebar.tsx`.

```
Overview   Dashboard
Money      Transactions   [All · Refunds · Transfers · Purchases · Large · Returns · Items · Search · Leaks]
           Accounts       [Balances · Credit cards · Debt · Statements]
           Import         [Files · Amazon]
Plan       Planned        [Upcoming · Calendar · Forecast · Recurring · Subscriptions · Reimbursements]
           Goals
           Scenarios      [Scenarios · Tax · Opportunity cost]
Invest     Portfolio      [Positions · Net worth]
Review     Inbox · Insights · Rules
Analyze    Reports        [Summary · Explain month · Lifestyle · Savings · Cashflow · Partner · Currency]
Operate    Monthly close · Vault · Chat
           Settings       (bottom, no header; gains Audit log + Backup & sync)
```

Open polish choice (non-blocking): "Invest" holds only Portfolio. Acceptable since
Portfolio has sub-tabs; alternative is to drop the header and place Portfolio under
Money. Resolve during PR 3.

## Mechanism — `?view=` tabs + redirects

The one foundational decision. Chosen over nested sub-routes because the `?view=`
pattern already exists in-repo (#378 `UnifiedInboxPage`) and CLAUDE.md says follow
existing patterns. Sub-routes were rejected: more router entries, divergent pattern.

**Building blocks (already present):**
- `Tabs` / `TabPanel` — `frontend/src/components/ui/tabs.tsx`. `Tabs` takes
  `items: {value,label}[]`, controlled `value`, `onValueChange`. `TabPanel` renders
  children when `value === active`. In-page only; URL sync is the consumer's job.
- `?view=` precedent — `UnifiedInboxPage` maps `searchParams.get('view')` → a saved
  view (`savedViewFromParam`, line 88-92); old routes redirect with a preselected view.

**The `view` param contract (applies to every folded parent):**
1. Reserved key: `view`. Each parent owns a fixed whitelist of values (see rail tabs).
2. No `view`, or an unknown value → render the parent's **primary** tab (`all`,
   `upcoming`, `summary`, `scenarios`, `balances`, `positions`, `files`).
3. Tab change calls `setSearchParams(prev => merge(prev, {view}), { replace: true })`
   — `replace` so tab-flipping does not spam history; **merge** so existing params
   (e.g. Transactions filters, Tax year) are preserved, never clobbered.
4. Old-route redirects are `<Navigate to="/parent?view=x" replace />`.

## Page strategy — mount, don't rewrite

A folded page keeps its body. The work per fold:

1. Extract the page's content (minus the outer page-title/header chrome) into a
   `XPanel` component exported from the same file (or a sibling). The standalone page
   wrapper, if still needed transitionally, becomes a thin shell around the panel.
2. The parent renders: shared page title → `Tabs` (the family's tab list) → the
   active `TabPanel` mounting the matching `XPanel`.
3. Delete the standalone `<Route>`; add the `<Navigate>` redirect.
4. Remove the item from `navSections`.

Nothing is deleted or rebuilt; existing tests on the panel bodies stay green. The lone
exception is Review→Inbox (PR 5).

## Staging — 6 PRs, rail stays consistent each step

Each PR is independently shippable, revertible, auto-merges (merge commit, no squash).
Filed as 6 linked GitHub issues with the `feature` label so `cashflow-tackle` runs
them in order. Each fold PR also drops its items from the rail + adds redirects, so the
rail is never left pointing at a not-yet-tabbed page.

### PR 0 — Safe wins + section skeleton  (risk: low)
- New `navSections` layout (7 sections, the 16 target items minus those still being
  folded — interim items still listed until their PR lands).
- Move chrome: `/audit-log` → `/settings/audit-log`, `/sync` → `/settings/backup`
  (new Settings tabs; old routes redirect).
- Fix mis-files in the rail: Amazon → Money group, Credit cards → Money/Accounts group.
- Un-hoist the 3 `/reports/*` pages: remove from rail, add as Reports tabs, and
  redirect the old child routes to `/reports?view=…` (they are already child routes —
  lowest-risk fold).
- Fold `/ask` → `/chat`: redirect; update the `aiStatus` filter (it currently hides
  both `/chat` and `/ask`).
- **AC:** rail shows the new section skeleton; every moved/redirected route (audit-log,
  sync, ask, and the 3 reports sub-routes) resolves to its new home; no item
  unreachable; `/reports` shows Explain/Lifestyle/Savings as tabs.

### PR 1 — Transaction fold  (risk: med, biggest win)
- `/transactions` gains tabs: All · Refunds · Transfers · Purchases · Large · Returns ·
  Items · Search · Leaks.
- Extract panels from the 8 pages; mount under `?view=`.
- Redirect all 8 old routes; drop all 8 from rail (rail Money now: Transactions,
  Accounts, Import).
- **AC:** each old route redirects to the right tab; each tab renders the prior page's
  behavior; existing per-page tests pass against the panel; `view` merges with existing
  Transactions filter params.

### PR 2 — Expectation fold → Planned  (risk: med)
- `/planned` gains tabs: Upcoming · Calendar · Forecast · Recurring · Subscriptions ·
  Reimbursements. Subscriptions + Reimbursements keep their own data/status machines
  (Bucket B) — tabbed, not merged.
- Redirect 5 old routes; drop from rail.

### PR 3 — Scenario + Account + Portfolio folds  (risk: med)
- `/scenarios` gains Tax + Opportunity cost tabs.
- `/accounts` gains Credit cards + Debt + Statements tabs.
- `/portfolio` gains Net worth tab.
- Resolve the Invest-section polish choice here.

### PR 4 — Reports fold  (risk: low)
- `/reports` gains Partner + Currency + Cashflow (sankey) tabs (the 3 `/reports/*`
  already became tabs in PR 0).
- Redirect `/sankey`, `/partner`, `/currency`; drop from rail.

### PR 5 — Review → Inbox reconciliation  (risk: high, data layer)
- `ReviewInboxPage` reads `/api/transactions`; `UnifiedInboxPage` reads
  `/api/review-items`. Two options, decided in this PR's own brainstorm:
  (a) add a transactions-backed saved-view to UnifiedInbox, or
  (b) keep Review as a distinct tab on `/inbox` that mounts the existing
      transaction-review panel.
- Until resolved, `/review` stays a top-level item (so PRs 0-4 don't depend on it).

## Risks

- **Review→Inbox data layer** (PR 5) — the only structural unknown. Isolated to its own
  PR; the other 5 do not depend on it.
- **Query-param collisions** — Transactions (filters), Tax (year), Scenarios (selection)
  already use search params. The merge rule (`setSearchParams(prev => …)`) is mandatory,
  not optional. Add a test per such parent that flipping `view` preserves other params.
- **Double headers** — mounting a full page inside a tabbed parent can duplicate
  titles/padding. The panel-extraction step (strip outer chrome) prevents this; verify
  visually per fold.
- **Badge preservation** — rail badges on `/inbox` (aiInboxCount) and `/insights`
  (insightsCount) must survive the rail rewrite.

## Out of scope

- Drag-to-reorder nav, per-role nav, search-within-nav, pinning.
- Backend route/endpoint changes — this is a frontend IA fold; APIs are untouched.
- Merging the Bucket-B status machines (Subscriptions, Reimbursements, Tax, Statements
  stay distinct data; only their nav placement changes).
- Renaming primitives or pages beyond nav labels.

## Test plan (per fold PR)

- Redirect: each old route renders a `<Navigate>` to the correct `?view=`.
- Tab render: each `?view=` value renders the corresponding panel; unknown value →
  primary tab.
- Behavior parity: the folded page's existing component tests pass against the panel.
- Param merge: flipping `view` preserves pre-existing query params on that parent.
- Rail: every keeper item resolves; no folded item remains in `navSections`.
- a11y: tablist keyboard nav (arrow keys) works (already in `Tabs`).
```

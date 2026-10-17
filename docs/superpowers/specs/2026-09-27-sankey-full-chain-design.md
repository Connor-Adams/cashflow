# Sankey: full chain, adaptive depth, on the homepage

**Date:** 2026-09-27
**Status:** design, approved
**Extends:** the `/cashflow` Sankey shipped under issue #224

## What exists

`SankeyPage` at `/cashflow` renders a **two-level** chart: a single `Income`
node fanning out to category sinks, with a drill-down dialog and a
`topCategories` cap that collapses the tail into "Other categories". It is
routed but **absent from the sidebar**, so nothing links to it.

`aggregateSankey` already does the hard parts: it drops non-categorical money
movement (transfers, investment purchases, dividend reinvestments) via
`isNonCategorical`, scopes by `visibleTransactionWhere`, and resolves a clicked
edge back to contributing transaction ids.

## What changes

Three structural additions and one placement change.

### 1. Three levels, adaptive depth

Categories are already a tree — `CategoryTree` carries `parentById`,
`depthById`, `pathById`, and chains run three deep in production
(`Hobbies → Golf → Clublink`, `Household → Clothing → Snowboarding Gear`).
The aggregator flattens it by choice.

Rendering every level for every branch produces ~40 nodes, most of them
hairlines. So **depth follows share**: a parent splits into its children only
when it is large enough to be worth the width. Below that threshold it draws as
one node with its subtree's total.

Production spend is extremely top-heavy, which is what makes this work:

```
Household     ~$64,900   11 children   → splits
Hobbies       ~$43,700   (Golf→Clublink alone $34,300) → splits
Amazon         $14,580   no children   → leaf
Apple          $12,029   no children   → leaf
Healthcare      $4,690   → probably leaf
Electronics     $2,922   → leaf
...
tire air            $5   → leaf, or tail-collapsed
```

The threshold is a share of total spend, not an absolute, so it holds as the
numbers grow. A node that would render below a minimum pixel height is not
worth drawing at all and joins the tail.

### 2. The full chain, corporate to personal

Income arrives at **CDG Labs** and personal spending is funded by owner draws
out of it. The current chart shows neither — it starts at a single `Income`
node that silently merges both entities.

The chain is:

```
CDG Labs revenue ─┬→ corporate expenses
                  └→ owner draws ─┬→ personal categories → subcategories
                                  └→ surplus
```

Corporate expenses must appear, or the surplus is wrong. In 2026 they are small
— **$2,878** across 40 transactions (Internet, AI, Hosting, Accounting) against
**$133,079** of personal spend — but omitting them would silently inflate what
looks available.

`final_business` already separates the two sides.

### 3. Surplus as a terminal node

Income minus spend, drawn on the right so the chart balances: everything in
equals everything out. This is the figure a category donut cannot show, and it
is the reason to build a Sankey at all.

### 4. On the homepage

The Dashboard already holds `currency`, `dateFrom`, `dateTo` and
`summaryQueryString` — the same state `SankeyPage` uses — so an embedded chart
inherits the range already set rather than growing its own controls.

The chart and its custom `SankeyNode` / `SankeyLinkPath` renderers move into a
shared component that takes data and currency as props. `/cashflow` keeps the
full page with filters, stat cards and drill-down; the Dashboard renders the
same chart and links through.

Also: **add `/cashflow` to the sidebar.** Its absence is most of why this felt
missing.

## The data this rests on

Building this against the data as it stood would have produced a chart that
looked broken and was right to. Income was typed on only 7 transactions
totalling $60,490 against $133,079 of spend, so the surplus node would have
read about −$73,000.

The cause was classification, not arithmetic: **$71,977 of CDG Labs revenue
landing in RBC Digital Choice Business was typed `unknown`**, while the same
company's deposits into Wealthsimple Corporate were typed `income`. Corrected
2026-09-27, along with LoC principal repayments mistyped as inflows, TFSA
contributions, credit-card payments received, deposit interest, and sixteen
merchant refunds. Income is now $132,734 against $133,079 of spend.

Eight inflows remain deliberately unclassified, $12,535, of which $11,000 is
two ATM cash deposits with no recoverable source. Until those are resolved the
surplus is understated by up to that amount, and the chart should not pretend
otherwise.

## Correctness properties

- **The chart balances.** Total inflow equals total outflow plus surplus. A
  discrepancy means a classification gap, and should surface rather than be
  absorbed into a residual node.
- **Collapsed nodes keep their value.** A parent drawn undivided carries its
  whole subtree's total; nothing is dropped by not being split.
- **Drill-down survives depth.** The existing edge→transaction resolution must
  work for subcategory edges, not only top-level ones.
- **Non-categorical money stays out.** Transfers, investment purchases and
  dividend reinvestments are already excluded and must remain so — `Transfer`
  alone is $493,174 in 2026 and would flatten everything else.
- **Per-currency.** No FX, consistent with the rest of the app.

## Out of scope

- Splitting income by source. There is effectively one — CDG Labs, at 99.8% —
  so the fan-out in the reference design does not apply here.
- Recategorisation. `Household` spans rent, food, alcohol and clothing at
  ~$64,900, and will render as one dominant band even when correct. That is a
  categorisation choice, not a charting bug.
- The two ATM deposits.

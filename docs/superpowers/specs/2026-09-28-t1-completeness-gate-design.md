# T1 Completeness Gate — the return never shows a bare total it knows is incomplete

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Backend computation + frontend surface
**Part:** 3 of 7 — depends on part 0 (provenance), part 1a (cash legs) and part 1b (the duplicate detector)

## Problem

"My personal tax looks too low" has now been investigated three times —
2026-06-01, 2026-09-16, and 2026-09-28. Each time the conclusion was some flavour
of *the data is incomplete*, and each time the T1 had displayed a clean, confident,
complete-looking number while incomplete.

That recurrence is the bug. The individual data gaps are symptoms.

### Why the engine cannot see the hole

`backend/src/tax/engine/t1.ts` emits exactly six warnings:

| Line | Warning |
|---|---|
| `:47` | T4 box 14 vs computed employment income differs by >$50 |
| `:87` | T5/T3 interest vs computed interest differs by >$50 |
| `:106` | T5/T3 eligible dividend (taxable) vs computed grossed-up |
| `:127` | T5/T3 non-eligible dividend (taxable) vs computed grossed-up |
| `:151` | Superficial loss denied |
| `:330` | AMT applies |

Every one is a **divergence check between two things the engine already knows
about**. None detects *absent* income. `buildPersonalFacts.ts` pushes no warnings
at all — `grep 'warnings.push'` over it returns nothing.

So a transaction with `tax_treatment_override = NULL` is simply invisible: it
contributes $0 and leaves no trace. `frontend/src/pages/tax/PersonalT1Tab.tsx:346`
renders only `computed.warnings`, so the UI faithfully reports a complete return.

The classification queue *does* know about pending rows. It lives on a different
tab and never reaches the T1 view.

### The tab does not show actuals at all

Moved to **part 0** (`2026-09-28-t1-provenance-design.md`), which ships first. In
short: `PersonalT1Tab.tsx:91-98` auto-selects the last-created non-baseline scenario,
which in prod is a `projection_root` holding zero 2026 transactions.

Two consequences bind this part:

1. **This gate must attach to the scenario path, not `routes/tax.ts`.**
   `PersonalT1Tab.tsx:110` renders `useScenarioDetail(activeId)` →
   `routes/tax-scenarios.ts:328` → `computeScenarioReturn`'s `scenario_returns`
   cache. `OverviewTab.tsx:34` is the **only** consumer of `useTaxReturn` →
   `routes/tax.ts`. An earlier draft scoped this part to `routes/tax.ts` alone,
   which would have shipped the gate onto Overview and left the Personal T1 tab
   rendering a bare total — the exact failure this part exists to prevent.
2. **The gate and the total must share a basis.** If the estimates re-run
   `buildPersonalFacts` (actuals) while the selected scenario is a fork carrying
   overrides, the displayed total and the estimates are computed on different
   numbers. Compute the estimates against the *selected scenario's* resolved facts.

### The queue is also not workable

`frontend/src/pages/tax/ClassifyTab.tsx` is 111 lines with no bulk selection, no
multi-apply and no suggestion — `grep` for `bulk|selectAll|checkbox|suggest`
returns nothing. One row at a time. That is why the queue stalled in May 2026 and
stayed stalled until September.

### What the gate would have caught, in Connor's actual 2026

| Gap | Worth |
|---|---|
| $42,000 of corp draws untagged (May–Aug, found 2026-09-16) | **~$4,227** of tax |
| $15,000 draw whose corp leg was never written (brokerage cash leg, part 1a) | **~$3,040** of tax |
| WS Corporate Chequing (account 24) uncovered 2026-08-14 → 2026-09-28 | est. $8–14k of draws, **~$1,700–$3,000** of tax |
| ~25 duplicate pairs, $28,848 phantom corp inflow | corrupts every balance |
| No 2026 carryforward roll (personal stops at `as_of_year 2025`) | RRSP/FHSA room wrong |

Note how unevenly those scale. The $42,000 backlog was worth ~$4,239 because it
spanned a near-zero base (total payable $300.00 → $4,527.17 on the published rates, measured in part 2); the $15,000 draw is worth
only $3,040 because it lands on top of it, at a ~20% marginal rate on cash
non-eligible dividends. **A gap's tax impact depends on what is already counted,
so the estimate must be computed against the current return, not from a stored
per-dollar rate.** Getting this wrong is how an estimate becomes actively
misleading — an earlier draft of this spec put the $15,000 at "~$4,900" by reusing
the backlog's rate.

None of these produced a single character of warning on the T1.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Gate hardness | **Show the number, never bare** | Connor's call. A refused total is hostile when you want a rough mid-year sense; a bare total is what caused this three times. |
| Shape | Typed `completeness: { status, blockers[], gaps[] }` on the return DTO | A first-class field, not a warning string. The UI can treat it structurally; a string forces re-parsing. |
| Where it is computed | A dedicated `buildCompletenessReport(entityId, year)` module | Keeps `buildPersonalFacts` focused on facts. Completeness needs import history and statement coverage, outside that builder's remit. |
| Dollar impact | Every gap carries an estimate, or states it cannot | "$15,000 of draws not imported (~$3,040 of tax)" drives action; "1 issue found" does not. |
| How the estimate is derived | **Re-run the return with the gap's amount added, take the delta** | The marginal rate depends on what is already counted (see the table above). A stored per-dollar rate is wrong by ~60% between two gaps in the same year. |
| Persistence | None — derived on read | Per `CLAUDE.md`: derived → computation, no table. |
| Bulk classification | In scope | A gate that surfaces 50 pending rows and offers one-at-a-time clearing just relocates the stall. |

### Blockers vs gaps

**Blocker** — known-missing money whose size is known or boundable. The total is
demonstrably wrong.

- Unclassified corp→personal transfers in the period (count, sum, tax estimate)
- **Computed income with no slip for the year.** ~$92,000 of non-eligible dividends
  against **zero** `tax_slips` rows for 2026 produces no signal today. For this
  taxpayer it is the single highest-value completeness check available: it is the
  only cheap thing that reaches the corp-declared-versus-cash-moved question this
  set otherwise defers. **It is a blocker only once the slip deadline has passed** —
  the last day of February following the year — and a **gap** before that. A slip
  that does not exist yet because it is not yet due is not missing data; treating it
  as a blocker would make part 4's exit unreachable for the whole period Connor
  actually works in.
- **A personal transfer-in with no counterpart.** Exactly txn 12139's pre-fix shape:
  `+15,000.00`, `txnType: 'transfer'`, `linkedTransactionId` NULL. The classification
  queue cannot see it — `routes/tax.ts:54-63` requires a non-null
  `linkedTransactionId` — and the blocker below covers only unlinked *corp outflows*.
  "Money arrived and you have not accounted for it" is the cheapest detector in this
  spec and was missing from it.
- Unlinked corp outflows with no resolvable counterpart
- Activities with a cash leg but no transaction — **scoped to part 1a's allowlist**
  (`transfer_in`, `transfer_out`, `cash_movement`). A bare `transfer` or `interest`
  activity on a brokerage account is deliberately not converted by 1a, so counting
  it here would report a blocker nothing in the set can clear.
- Import coverage ending before **`min(period end, today)`**, on an account that has
  seen activity — with the uncovered window and a run-rate-based estimate. The
  `min` matters: measured against 2026-12-31 this fires permanently for an open
  year, which would make the gate useless exactly when it is most needed.

**Gap** — a correctness risk of unknown size. The total may be right.

- Suspected duplicate pairs awaiting review (part 1b's detector)
- ACB warnings raised and discarded — `computeAcb` emits them for clamped sells,
  zero-cost `transfer_in` and mixed currency (`portfolio/acb.ts:154-176,197-202,366-370`)
  and `buildPersonalFacts.ts:374-412` never reads `acb.warnings`. Surface them.
- Carryforwards not rolled into the period
- The year's rate table carries `provenance: 'projected'` (ties to part 2)
- Slips entered for the year that reconcile against nothing
- Accounts with no statement ever registered

**Not included, because part 1c was cut:** derived balance diverging from a printed
closing balance. Nothing persists a statement balance, so there is no signal to
compute. Reinstate with 1c if it is ever revived.

`status` is `complete` | `gaps` | `blocked`, worst-wins.

**Every blocker must be clearable by work this set schedules.** That is the
discipline the three refinements above enforce: a blocker nothing can clear is not a
signal, it is a permanent red light that trains the reader to ignore the panel.

### Presentation

The completeness block sits **above** the total, always rendered. When
`status === 'complete'` it is a single quiet line saying so, with the coverage date
— absence of warning must itself be affirmative, or "no warnings" and "nobody
checked" look identical.

When not complete it lists each blocker and gap with its dollar estimate and a
link to where it is fixed (the classify tab, the import page, the duplicate review).
The total renders below, normally, with a marker tying it to the block.

No modal, no blocking interstitial. The number stays readable; it just never
appears without its caveat.

### Primitives check

Per `CLAUDE.md`. Completeness is **derived** from existing primitives — Transaction,
Document, Period, Account — and asserts no state of its own. Derived → a
computation, no table, no new primitive. It extends nothing; it observes.

The bulk-classify work writes `tax_treatment_override`, an existing field on
Transaction, through the existing patch route. No new status machine.

## Scope

**In:** a new `backend/src/tax/completeness/` module; **the scenario detail path —
`backend/src/routes/tax-scenarios.ts:328` and
`backend/src/tax/scenarios/computeScenarioReturn.ts` — which is what
`PersonalT1Tab` renders**; and the plain return route
(`backend/src/routes/tax.ts:361-444`) merging the report into **both** of its
response constructions — note the cache-hit path builds its response at `:384-390` and
returns early at `:391`, while the miss path responds separately at `:433`, so editing only the miss path ships a gate that vanishes
whenever the cache is warm; a shared return DTO; `useTaxReturn`;
`PersonalT1Tab.tsx`; and bulk selection + multi-apply in `ClassifyTab.tsx`.

**There is no `TaxReturnDto` in `shared/api-types.ts` today** — `grep TaxReturn`
returns nothing there. The return shape lives frontend-side in
`frontend/src/hooks/useTaxReturn.ts:12-18` and the route builds its response ad hoc.
Promoting it to the shared contract is part of this work, not a given.

**Bulk classification semantics**, which must be decided rather than discovered:
one request per row against the existing patch route, or a new bulk endpoint;
whether a partial failure is atomic or best-effort; and whether the UI updates
optimistically or refetches. This spec's testing asserts "without a full refetch",
so: a bulk endpoint, atomic per request, returning the updated rows for in-place
application.

**Out:** fixing any of the data problems the gate reports (part 4), the importer
and duplicate detector that feed it (parts 1a and 1b), engine arithmetic (part 2).

**Caching note.** `routes/tax.ts:379-392` computes facts unconditionally, then
serves the cached `TaxReturn` when `factsHash` matches. The completeness report is
**not** derived from facts — import coverage changes without any fact changing —
so it must be computed on every request and must not be folded into `factsHash`.
Getting this wrong reintroduces a stale gate, which is worse than none.

**Cost.** The report needs per-account import-coverage spans, balance drift,
orphaned-activity detection, duplicate-pair detection across the year, and
carryforward state — on a route whose cache exists because it is already slow.
Since `buildPersonalFacts` runs unconditionally at `:379`, the cache only saves
`buildT1`, so the incremental cost here is real and unbudgeted. The implementation
plan must state a latency budget and bound the duplicate scan to the period, or the
gate makes the tab worse.

**Corp T2.** The same hole exists on the corp side. Out of scope here; the module
should not be shaped so that extending to T2 means rewriting it.

## Testing

Backend `node:test` via `tsx`, colocated. Frontend vitest.

- Each blocker and gap type: detected when present, absent when not, with the
  right dollar estimate. Table-driven, one case per type.
- Worst-wins `status` across mixed inputs.
- A genuinely complete year yields `status: 'complete'` with an affirmative line —
  the "nobody checked looks like no problems" failure.
- The report is recomputed when import coverage changes but facts do not. This is
  the specific regression that would silently reintroduce staleness.
- Regression fixture from Connor's real 2026: 13 classified pairs + 1 unimported
  $15,000 draw + a 45-day coverage gap + 25 duplicate pairs → `blocked`, with the
  $15,000 blocker carrying a tax estimate in the **$2,900–$3,200** band
  (total payable $4,527.17 → $7,568.96 on the **published** 2026 rates, per part 2's
  measured table — the $4,538.85 / $7,580.64 pair in that table is the *file* rates
  column; the delta is $3,041.79 either way).
- The same $15,000 gap against a *different* base yields a different estimate —
  the direct test that the impact is computed by re-running the return rather
  than from a stored rate.
- Frontend: the total never renders without the completeness block; blockers link
  to their fix surface; bulk-classify applies one treatment to a multi-row
  selection and reflects the result without a full refetch.

## Relationship to the other parts

**0** Provenance (ships first) · **1a** Brokerage cash legs · **1b** Duplicate
detection, detect-and-report · **1c** Statement balances (**cut**) · **2** Engine
correctness · **3** Completeness gate · **4** 2026 backfill · **5** Instalments and
the forward view.

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.

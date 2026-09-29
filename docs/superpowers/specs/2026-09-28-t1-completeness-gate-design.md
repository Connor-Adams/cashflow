# T1 Completeness Gate — the return never shows a bare total it knows is incomplete

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Backend computation + frontend surface
**Part:** 3 of 4 — depends on part 1 (reconciliation foundation)

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

### The queue is also not workable

`frontend/src/pages/tax/ClassifyTab.tsx` is 111 lines with no bulk selection, no
multi-apply and no suggestion — `grep` for `bulk|selectAll|checkbox|suggest`
returns nothing. One row at a time. That is why the queue stalled in May 2026 and
stayed stalled until September.

### What the gate would have caught, in Connor's actual 2026

| Gap | Worth |
|---|---|
| $42,000 of corp draws untagged (May–Aug, found 2026-09-16) | ~$4,400 of tax |
| $15,000 draw never imported (brokerage cash leg, spec 1) | ~$4,900 of tax |
| WS Corporate Chequing uncovered 2026-08-14 → 2026-09-28 | est. $8–14k of draws |
| ~25 duplicate pairs, $28,848 phantom corp inflow | corrupts every balance |
| No 2026 carryforward roll (personal stops at `as_of_year 2025`) | RRSP/FHSA room wrong |

None of these produced a single character of warning on the T1.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Gate hardness | **Show the number, never bare** | Connor's call. A refused total is hostile when you want a rough mid-year sense; a bare total is what caused this three times. |
| Shape | Typed `completeness: { status, blockers[], gaps[] }` on the return DTO | A first-class field, not a warning string. The UI can treat it structurally; a string forces re-parsing. |
| Where it is computed | A dedicated `buildCompletenessReport(entityId, year)` module | Keeps `buildPersonalFacts` focused on facts. Completeness needs import history and statement coverage, outside that builder's remit. |
| Dollar impact | Every gap carries an estimate, or states it cannot | "$15,000 of draws not imported (~$4,900 of tax)" drives action; "1 issue found" does not. |
| Persistence | None — derived on read | Per `CLAUDE.md`: derived → computation, no table. |
| Bulk classification | In scope | A gate that surfaces 50 pending rows and offers one-at-a-time clearing just relocates the stall. |

### Blockers vs gaps

**Blocker** — known-missing money whose size is known or boundable. The total is
demonstrably wrong.

- Unclassified corp→personal transfers in the period (count, sum, tax estimate)
- Unlinked corp outflows with no resolvable counterpart
- Activities with a cash leg but no transaction (spec 1's detector)
- Import coverage ending before the period end, on an account that has seen
  activity — with the uncovered window and a run-rate-based estimate
- Derived balance diverging from the latest statement closing balance

**Gap** — a correctness risk of unknown size. The total may be right.

- Suspected duplicate pairs awaiting review
- Carryforwards not rolled into the period
- A rate table not marked `VERIFIED` for the year (ties to spec 2)
- Slips entered for the year that reconcile against nothing
- Accounts with no statement ever registered

`status` is `complete` | `gaps` | `blocked`, worst-wins.

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

**In:** a new `backend/src/tax/completeness/` module, the return route
(`backend/src/routes/tax.ts:370-420`) merging the report into its response, the
`TaxReturnDto` contract in `shared/api-types.ts`, `useTaxReturn`,
`PersonalT1Tab.tsx`, and bulk selection + multi-apply in `ClassifyTab.tsx`.

**Out:** fixing any of the data problems the gate reports (spec 4), the importer
and duplicate detector that feed it (spec 1), engine arithmetic (spec 2).

**Caching note.** `routes/tax.ts:380-392` invalidates the cached `TaxReturn` on
`factsHash`. The completeness report is **not** derived from facts — import
coverage can change without any fact changing — so it must be computed on every
request and must not be folded into `factsHash`. Getting this wrong reintroduces
a stale gate, which is worse than none.

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
  $15,000 blocker carrying a tax estimate in the $4,500–$5,200 band.
- Frontend: the total never renders without the completeness block; blockers link
  to their fix surface; bulk-classify applies one treatment to a multi-row
  selection and reflects the result without a full refetch.

## Relationship to the other specs

1. **Reconciliation foundation** — produces this spec's signals. Build first.
2. **Engine correctness** — independent; the "rate table not verified" gap ties to
   it but does not block.
3. **T1 completeness gate** — this spec.
4. **2026 data backfill** — clearing what this gate reports is how part 4 knows it
   is finished. The gate reaching `complete` for 2026 **is** part 4's exit
   condition.

Build order: 1, 2, 3, 4.

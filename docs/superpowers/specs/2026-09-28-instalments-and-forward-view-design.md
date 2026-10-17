# Instalments and the Forward View — what to pay, and when

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Backend computation + frontend surface
**Part:** 5 of 7

## Problem

Connor's question was "it needs to be accurate so I know what I'm getting myself
into." Every other part answers *what happened*. Nothing answers *what is coming*,
and his next actual cash obligation is **2027-03-15**.

Two holes.

### 1. Required instalments are computed nowhere

`backend/src/tax/engine/instalments.ts` is small and **mostly right**, which an
earlier draft of this spec got wrong twice:

```ts
const DUE_DATES = ['03-15', '06-15', '09-15', '12-15'];

export function quarterlyInstalments(annualOwing: Decimal, year = ...): Instalment[] {
  const per = annualOwing.dividedBy(4);
  return DUE_DATES.map((md) => ({ dueOn: `${year}-${md}`, amount: per }));
}
```

The dates are the correct CRA dates, and **dividing by four is exactly the
prior-year option and exactly the current-year option** — two of the three CRA
choices. Only the no-calculation option differs (¼ of the second prior year on Mar 15
and Jun 15, then the prior-year remainder split over Sep 15 and Dec 15). The earlier
draft said this "matches no CRA schedule"; that would have sent an implementer to
replace correct arithmetic.

It is also **not** unreferenced: `backend/src/tax/engine/instalments.test.ts:4`
imports it. Changing its signature breaks CI, so that test file is in scope — the
same lesson part 2 learned about the rate-table tests.

What is genuinely missing: it takes an `annualOwing` with no definition of *which
year's* net owing, and there is **no threshold test anywhere** deciding whether
instalments are required at all.

`InstalmentTracker.tsx` lists and adds payments; it carries the same four dates in
`QUARTER_OPTIONS` (`:12-18`). It has no threshold test and no calculation options.
`instalment_payments` is empty in prod. `models/InstalmentPayment.ts` exists, with
migration `20260527000001-instalment-payments.js`.

**And there is no instalment line on the return.** `buildPersonalFacts.ts:441` reads
the `instalments_paid` carryforward into `PersonalCarryforwards.instalmentsPaid`, but
`t1.ts:385-391` folds it straight into a combined total:

```ts
const totalCredits = taxDeductedAtSource.plus(instalmentsPaid);
push('L48200', 'Total credits (tax deducted + instalments)', totalCredits);
```

`grep -rn "47600" backend/src` returns nothing. That matters here specifically: the
CRA net-tax-owing test this part implements is defined **before** instalments, and
the engine has no line that isolates them. Splitting L47600 out of L48200 is
therefore part of this work, not an assumption it can rest on.

**The facts for Connor specifically.** CRA requires instalments when net tax owing
exceeds $3,000 in the current year **and** in either of the two preceding years.

| Year | Net tax owing | Source | Instalments required? |
|---|---|---|---|
| 2024 | **$0.00** | prod `tax_return_snapshots` id 3: totalIncome 98.79, totalPayable 0.00 | No |
| 2025 | **≈ $0** — a refund of $47.35 | prod id 2: totalPayable 3,727.81 less T4 withholding 3,775.16 | No |
| 2026 | ~$8,400–$16,610 depending on final draws (part 4) | — | **Not required**, because both 2024 and 2025 were under $3,000 |
| 2027 | well over $3,000 on any similar draw pattern | — | **Required**, first payment 2027-03-15 |

An earlier draft of this table wrote 2025 as "~$300" — that figure is actually
**2026** scenario 12's `totalPayable` from part 0's table, cross-wired — and asserted
2024 with no evidence at all. Both now carry their prod source, because the
reassurance claim below depends entirely on them: if 2024 had exceeded $3,000, 2026
instalments *were* required and Connor is late with interest accruing. He is not.

So: **no 2026 instalments were owed**, which nothing in the app says, and **2027
instalments will be**, which nothing in the app will tell him either. Both halves
matter — the first is reassurance he is not already late, the second is a deadline.

### 2. There is no current-year forward view

After part 0 demotes `projection_root` from the default, there is no way to see
"2026 at the current run rate" at all. The only forward mechanism is
`projectPersonalFactsFromPrevYear.ts:106-123`, which scales **year N** and carries no
year-N+1 transactions — exactly why part 0 demotes it.

What Connor needs is the opposite: **year-to-date actuals plus a projection of the
remainder.** The $112,000–$121,000 draw band and the ~$16,610 payable in part 4's
Expected outcome exist only as prose in a markdown file. That is the number he acts
on when deciding December draws and when paying in March.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Instalment obligation | Implement the real CRA test: net owing > $3,000 in the current year **and** in either of the two prior years | The two-year condition is why 2026 required nothing. A naive "> $3,000 ⇒ pay" would have told him he was late all year. |
| Calculation options | All three — no-calculation (CRA's reminder amount), prior-year, current-year estimate — with the current-year option flagged as the one that carries interest risk if underestimated | These are the actual choices CRA offers; picking one for him hides the trade-off. Prior-year is the safe default for a rising-income year. |
| Due dates | Keep the four in `DUE_DATES` — they are already correct | No change needed; assert they survive the rewrite. |
| `quarterlyInstalments` | **Keep the arithmetic; add the missing inputs** | Divide-by-four is the prior-year option and the current-year option. What it lacks is a stated source year for `annualOwing`, the no-calculation variant, and any threshold test. It is also referenced by `instalments.test.ts:4`, so its signature is a CI surface. |
| Forward view basis | **Year-to-date actuals + run-rate projection of the remainder**, never a scaled prior year | The prior-year scaling is the mechanism part 0 demotes. Reusing it here would reintroduce the same defect under a new name. |
| How it is modelled | **A fourth `ScenarioKind`** and a third branch in `resolveScenario` | `models/Scenario.ts:6` is `'baseline' \| 'fork' \| 'projection_root'` and `resolveScenario.ts:25-28` has exactly two branches. A YTD-plus-remainder basis is neither. **No migration is needed** — `migrations/20260526014957-scenarios.js:12` declares `kind` as `Sequelize.STRING(20)` with the value list in a comment only, no ENUM and no constraint. The union is declared in three places: `models/Scenario.ts:6`, `frontend/src/hooks/useScenarios.ts:4` and `useCorpScenarios.ts:4`. |
| Caching | The forward view must **not** ride the facts-only `ScenarioReturn` cache | `computeScenarioReturn.ts:44-50` keys on `hashFacts(facts)` alone. A run-rate projection changes as the calendar advances with no fact changing, so it would cache and go stale — the same failure part 2 documents for rate corrections and part 3 for the completeness report. |
| Run-rate source | Corp→personal draws per month over the elapsed year, **over months the ledger actually covers** | The projection must not read an unimported month as a zero-draw month, or it under-projects exactly when data is missing. Part 3 reports truncation as a *gap* with no window and no rate, so this part derives its own covered-month set. **Coverage means the presence of *any* transaction on the corp account in that month, not the presence of a draw.** Absence of draws cannot distinguish "no statement imported" from "no draws taken", and excluding a genuine zero-draw month over-projects — the mirror of the error this clause exists to avoid. No cadence threshold is used, because that is exactly what part 3 discarded as unbuildable. |
| Forward view is labelled | Same provenance discipline as part 0 — it says it is a projection and states its assumption | A forward number that looks like a filed number is the failure part 0 exists to prevent. |
| Parentage | The forward-view scenario is created **parentless**, as a year-boundary root | `resolveScenario` branches on `ancestry[0].kind`, and `scenarioAncestry.ts:59` terminates the walk at a `projection_root`. Give the new kind a parent and it never becomes `ancestry[0]`, the third branch is unreachable, and the view silently renders the parent's facts — a wrong number with no error, which is the failure class part 0 exists to prevent. |
| Placement | Beside the T1 total, not on its own tab | The question "what do I owe" and "what will I owe" are asked together. |

### Primitives check

Per `CLAUDE.md`. An instalment obligation is **derived** — from the return's net
owing across three years, which the engine already computes — so no table. Payments
already have `InstalmentPayment`, an existing model.

The forward view **extends an existing primitive**: a new `ScenarioKind` value on
**Scenario**, which is a discriminator on a thing that already exists, not a new
status machine. Per the build rule that is "a new variant → add a `kind` field
value", which Scenario already has. It needs a third branch in `resolveScenario` and **no
migration** — `migrations/20260526014957-scenarios.js:12` declares `kind` as an
unconstrained `Sequelize.STRING(20)`.

## Scope

**In:** `backend/src/tax/engine/instalments.ts` and its colocated
`instalments.test.ts`; a required-instalment computation reading the three years'
returns; an L47600 line split out of L48200 in `backend/src/tax/engine/t1.ts`;
`models/Scenario.ts`, `frontend/src/hooks/useScenarios.ts` and `useCorpScenarios.ts`
(the kind union is declared in all three), plus `tax/scenarios/resolveScenario.ts` and
`computeScenarioReturn.ts` for the new kind and its cache exemption;
`frontend/src/pages/tax/InstalmentTracker.tsx`; and a forward-view surface on the
Personal T1 tab (the scenario path — see part 0).

**Out:** corp instalments (T2). Automatic payment or reminders outside the app.

**Also in scope, and larger than instalments:** the **2027-04-30** balance-due date
for the 2026 return. `grep` for a filing or balance-due concept across
`backend/src/tax` returns nothing. The March instalment is first in time; the April
payment of ~$8,400–$16,610 is the biggest number in the picture, and nothing names
its deadline.

## Testing

- The two-year test: 2026 with net owing $8,400 and 2025 at ~$0 requires **no**
  instalments; 2027 with 2026 over $3,000 **does**. Table-driven across the
  three-year window, because the off-by-one here is the whole rule.
- Due dates land on the 15th of March, June, September, December — `DUE_DATES`
  already has these; assert they survive the rewrite.
- L47600 appears as its own line and L48200 still totals correctly.
- The forward view recomputes as the calendar advances with no fact change.
- Part 0's default-selection guard is not confused by the new kind: it still selects
  the baseline, and the forward view is not auto-selected.
- A forward-view scenario created parentless reaches its own branch in
  `resolveScenario`; one created with a parent is rejected at creation rather than
  silently rendering the parent's facts.
- Each of the three calculation options produces its documented amount for a fixture
  taxpayer, and the current-year option is flagged.
- The forward view projects the remainder from the run rate and **excludes months
  with no transactions at all** from the denominator, while **including** a month
  that has transactions but no draws — that month is a real zero and belongs in the
  average.
- The forward view is labelled a projection and states its assumption.
- With the year complete, the forward view converges on the actual return.

## Relationship to the other parts

Seven parts. Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.

Part 5 is last by dependency, not by importance: its instalment test needs three
years of returns that parts 0–4 make trustworthy, and its run-rate projection needs
its own covered-month derivation so it does not read an unimported month as a
zero-draw month. It is, however, the part that answers the question Connor actually asked.

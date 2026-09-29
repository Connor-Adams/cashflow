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

`backend/src/tax/engine/instalments.ts:7` exports `quarterlyInstalments`, and it is
**dead code** — the only hit across `backend/src` and `frontend/src` is its own
definition. It also divides an annual figure by four, which is not what CRA requires.

`InstalmentTracker.tsx` records payments made. There is no threshold test, no
calculation options, no due-date schedule, no reminder. `instalment_payments` is
empty in prod, and `carryforwards` carries an `instalments_paid` kind that
`buildPersonalFacts` reads into `PersonalCarryforwards.instalmentsPaid` and `t1.ts`
subtracts at L47600 — so the *credit* side exists and the *obligation* side does not.

**The facts for Connor specifically.** CRA requires instalments when net tax owing
exceeds $3,000 in the current year **and** in either of the two preceding years.

| Year | Net tax owing | Instalments required? |
|---|---|---|
| 2025 | ~$300 (prod snapshot: `totalPayable` 3,727.81 less T4 withholding 3,775.16 → refund of 47.35; net owing ≈ 0) | No |
| 2026 | ~$8,400–$16,600 depending on final draws (part 4) | **Not required** — 2025 and 2024 were both under $3,000 |
| 2027 | on any similar draw pattern, well over $3,000 | **Required**, first payment 2027-03-15 |

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
| Due dates | March 15, June 15, September 15, December 15 | Replaces `quarterlyInstalments`' divide-by-four, which matches no CRA schedule. |
| `quarterlyInstalments` | Delete it, or rewrite it as the schedule builder | Dead code that looks authoritative is worse than no code. |
| Forward view basis | **Year-to-date actuals + run-rate projection of the remainder**, never a scaled prior year | The prior-year scaling is the mechanism part 0 demotes. Reusing it here would reintroduce the same defect under a new name. |
| Run-rate source | Corp→personal draws per month over the elapsed year, excluding the coverage gap | The gap is part 3's blocker; the projection must not treat an unimported month as a zero-draw month, or it under-projects exactly when data is missing. |
| Forward view is labelled | Same provenance discipline as part 0 — it says it is a projection and states its assumption | A forward number that looks like a filed number is the failure part 0 exists to prevent. |
| Placement | Beside the T1 total, not on its own tab | The question "what do I owe" and "what will I owe" are asked together. |

### Primitives check

Per `CLAUDE.md`. An instalment obligation is **derived** — from the return's net
owing across three years, which the engine already computes — so no table. Payments
already have `InstalmentPayment`, an existing model. The forward view is a
**Scenario** computation over existing facts; `Scenario.kind` already discriminates.
No new primitive, no new status machine, no migration.

## Scope

**In:** `backend/src/tax/engine/instalments.ts` (rewrite), a required-instalment
computation reading the three years' returns, the forward-view computation,
`frontend/src/pages/tax/InstalmentTracker.tsx`, and a forward-view surface on the
Personal T1 tab (the scenario path — see part 0).

**Out:** corp instalments (T2). Automatic payment or reminders outside the app.

## Testing

- The two-year test: 2026 with net owing $8,400 and 2025 at ~$0 requires **no**
  instalments; 2027 with 2026 over $3,000 **does**. Table-driven across the
  three-year window, because the off-by-one here is the whole rule.
- Due dates land on the 15th of March, June, September, December.
- Each of the three calculation options produces its documented amount for a fixture
  taxpayer, and the current-year option is flagged.
- The forward view on a part-year 2026 projects the remainder from the run rate, and
  **excludes** months inside a coverage gap from the rate rather than counting them
  as zero.
- The forward view is labelled a projection and states its assumption.
- With the year complete, the forward view converges on the actual return.

## Relationship to the other parts

Seven parts. Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 3 → 1b → 5**. Part 1c is **cut**.

Part 5 is last by dependency, not by importance: its instalment test needs three
years of returns that parts 0–4 make trustworthy, and its run-rate projection needs
part 3's coverage blocker so it does not read an unimported month as a zero-draw
month. It is, however, the part that answers the question Connor actually asked.

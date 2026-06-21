# Corp dividend auto-flow to owner's T1 — design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)

## Problem

The household-plan orchestrator (`computeHouseholdPlan`) already routes owner
remuneration from a corp to a shareholder's personal T1: a corp scenario
declares `ownerComp.<shareholderEntityId>.{salary|eligibleDividend|nonEligibleDividend|…}`
overrides, `integrationRouter` derives per-shareholder `PersonalAdditions`, and
`applyAdditionsAndShifts` injects them into the personal facts before `buildT1`.

But those `ownerComp.*` amounts are **manual planning overrides**. A corp's
*actual* dividends — recorded as `ShareholderLoan` rows with `kind='dividend_credit'`
(already surfaced as `CorpTaxYearFacts.dividendsPaid` by `buildCorpFacts`) — are
**not** linked to that routing. So an owner who records real dividend draws still
sees nothing on their personal return unless they separately hand-enter an
`ownerComp` override. There is also **no model link** from a corp to its owner;
the shareholder identity lives only inside the override *key*.

This feeds the existing router from actuals — it does **not** add a parallel
dividend path (no fork).

## Goal

When a corp has a declared owner and recorded dividends, its dividend draws flow
to that owner's personal T1 automatically (through the existing
`integrationRouter`), with manual `ownerComp` overrides still taking precedence.

## Non-goals

- No new dividend-income line, slip ingestion, or routing path — reuse
  `integrationRouter` / `OwnerCompPlan` / `applyAdditionsAndShifts`.
- Eligible-dividend GRIP designation: dividends auto-flow as **non-eligible**
  (matches the existing `buildCorpFacts` hardcode and the common CCPC
  small-business case). Eligible/GRIP designation is a separate later refinement.
- Multi-shareholder splitting: v1 routes a corp's dividends to a single
  `ownerEntityId` (sole-shareholder case). Proportional splits are out of scope.
- Capital-dividend handling is unchanged (already tax-free pass-through).
- The standalone personal `/return` (`buildPersonalFacts`) is unchanged — corp
  dividends appear in the **household-plan** compute, which is the integrated view.

## Linkage: `Entity.ownerEntityId`

Add a nullable `ownerEntityId` to `Entity`, mirroring the existing
`spouseEntityId`:

- Model: `declare ownerEntityId: number | null;` + init column
  `{ type: DataTypes.INTEGER, field: 'owner_entity_id', allowNull: true }`.
- Migration: `addColumn('tax_entities', 'owner_entity_id', { INTEGER, allowNull: true })`
  (filename sorts after the latest existing migration).
- Semantics: set on a **corp** entity; points to the **personal** entity that is
  its shareholder. Same household.
- Setting it: extend `PATCH /api/tax/entities/:id` (`routes/tax.ts:38`) to accept
  `ownerEntityId`, validating that the target entity exists, is `kind='personal'`,
  and shares the household; `null` clears it. Follow the validation style of the
  existing `POST /api/tax/entities/:id/spouse` handler (`routes/tax.ts:105`),
  which does the analogous personal-entity-link validation.

## Derivation (in `computeHouseholdPlan`)

After corp scenarios are resolved (their `CorpTaxYearFacts`, hence `dividendsPaid`,
are available in `corpBaseFactsByScenarioId`) and `entityById` is loaded:

For each corp scenario `s`:
1. Let `ownerId = entityById.get(s.entityId)?.ownerEntityId`. Skip if null.
2. Let `manual` = whether `s.overrides` already contains any
   `ownerComp.<ownerId>.*` key (reuse `OWNER_COMP_RE`). If a manual ownerComp
   plan for that shareholder exists, **skip** (override wins).
3. Else synthesize one `OwnerCompPlan`:
   ```
   {
     corpScenarioId: s.id,
     shareholderEntityId: ownerId,
     salary: D(0), bonus: D(0),
     eligibleDividend: sum(dividendsPaid where kind==='eligible'),
     nonEligibleDividend: sum(dividendsPaid where kind==='non_eligible'),
     capitalDividend: D(0),
   }
   ```
   from `corpBaseFactsByScenarioId.get(s.id).dividendsPaid`.

Fold these synthesized plans into the `ownerCompPlans` list passed to
`integrationRouter` alongside the override-derived ones. Everything downstream
(gross-up, DTC, injection into the personal T1) is unchanged.

Implementation note: `buildRouterInputs(corp)` currently builds `OwnerCompPlan[]`
from override keys only. Extend it (or add a sibling step) to also take
`corpBaseFactsByScenarioId` + `entityById` so it can append the derived plans.
Keep the override-vs-derived precedence in one place.

## Testing (TDD)

- **computeHouseholdPlan** (integration-style test with seeded models):
  - A corp with `ownerEntityId` set + two `dividend_credit` `ShareholderLoan`
    rows, its scenario + a personal scenario both linked to a `HouseholdPlan`,
    no `ownerComp` override → the personal result's facts/T1 include the summed
    dividends as non-eligible (L12010 > 0).
  - Override precedence: same setup but with an `ownerComp.<ownerId>.nonEligibleDividend`
    override → the override amount is used, the ledger is ignored.
  - No `ownerEntityId` → no auto-routing (current behavior preserved).
- **Entity PATCH** (route test): set `ownerEntityId` to a valid personal entity
  (200); reject a corp/other-household/nonexistent target (400/422).

## Risks / out of scope

- Eligibility is non-eligible-only (no GRIP-based eligible designation yet).
- Sole-shareholder only (single `ownerEntityId`).
- `ShareholderLoan.dividend_credit` rows don't store eligibility; the engine
  default (non-eligible) is used. Storing per-row eligibility is a future change.
- Wiring a specific household's data (linking scenarios to a plan, setting
  `ownerEntityId`, recording dividend_credit rows) is **configuration done after
  deploy**, not part of this code change.

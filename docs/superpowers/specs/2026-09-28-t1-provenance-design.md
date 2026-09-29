# T1 Provenance — the number on screen says what it is

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Frontend + backend surface
**Part:** 0 of 7 — **ships first.** Until this lands, every other part's effect is invisible.

## Problem

The Personal T1 tab does not show actuals. It auto-selects a **projection**, and
nothing says so.

`frontend/src/pages/tax/PersonalT1Tab.tsx:91-98`:

```tsx
const latestFork = [...scenarios].reverse().find((s) => s.kind !== 'baseline');
setActiveId((latestFork ?? scenarios[0]).id);
```

The list arrives `order: [['createdAt','ASC']]` (`routes/tax-scenarios.ts:170-172`),
so this is the **last-created non-baseline scenario**. In prod, entity 1 / year 2026,
that is scenario 18 — `kind: 'projection_root'`, parented to the *2025* Scratch fork.

`tax/scenarios/resolveScenario.ts:25-28` branches on the kind:

```ts
const baseFacts = root.kind === 'projection_root'
  ? await projectPersonalFactsViaPort(root.id)
  : await buildPersonalFacts(root.entityId, root.year);
```

and `projectPersonalFactsFromPrevYear.ts:106-123` builds year N+1 **entirely from
year N scaled by inflation**, with `capitalGainEvents: []` and `slips: []`.

So the tab renders a 2025-scaled forecast holding **zero 2026 transactions**. Prod
`scenario_returns`:

| scenario | totalIncome | totalPayable | cppContrib | eiPremium |
|---|---|---|---|---|
| 12 (actuals fork) | 30,274.51 | 300.00 | 0 | 0 |
| **18 (projection)** | 40,353.49 | 2,556.95 | **1,168.96** | **384.23** |

The CPP and EI prove it: they can only come from employment income, and Connor had
none in 2026. They are his 2025 T4 scaled forward.

`ScenarioTree.tsx:65-67` renders a `projection_root` identically to a `fork` and
appends "(actuals)" only for `baseline`. There is no cue of any kind.

### The two tabs read different backends

This is why provenance is its own part, and why it must ship first.

`PersonalT1Tab.tsx:110` calls `useScenarioDetail(activeId)` and renders
`computed.totals.*` (`:323-326`). That is `GET /api/tax/scenarios/…`
(`routes/tax-scenarios.ts:328`, `res.json({ scenario, computed })`), served from
`computeScenarioReturn`'s own `scenario_returns` cache. It imports from
`useTaxReturn` only the `TaxLineDto` **type** (`:6`).

`OverviewTab.tsx:34` is the **only** consumer of `useTaxReturn(year)` →
`GET /api/tax/personal/:year/return` → `buildPersonalFacts` → `buildT1`, i.e. true
actuals.

So the two tabs on one page show different 2026 numbers with nothing reconciling
them — and **any work attached to `routes/tax.ts` lands on Overview and leaves the
Personal T1 tab untouched.** An earlier draft scoped the completeness gate that way.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Default selection | **The baseline**, always, for a year that has actuals | A projection is not the year on screen. Defaulting to one is worse than an incomplete actual: an incomplete actual is wrong by the gap; a projection is a different question's answer. |
| Labelling | The rendered number always states **actuals**, **actuals + overrides**, or **projection from `<year>`** | Absence of a label currently reads as "this is my tax". |
| A projection says what it lacks | Explicitly: "contains no transactions from `<year>`" | The scaled-2025 CPP and EI are what made this discoverable; a user should not need `scenario_returns` to notice. |
| `ScenarioTree` | Distinguishes all three kinds | It currently labels only `baseline`. |
| Where the work attaches | **`routes/tax-scenarios.ts` and `tax/scenarios/computeScenarioReturn.ts`**, plus `PersonalT1Tab.tsx` and `ScenarioTree.tsx` | This is the path that renders the number. Attaching to `routes/tax.ts` would be invisible on this tab. |
| Overview vs T1 | They must agree when the selected scenario is the actuals baseline, or visibly explain why they differ | Two numbers for one year on one page is its own trust failure. |
| Scope discipline | Provenance only. **No** completeness blockers, **no** bulk classify | Those are part 3. This part is small on purpose so it can ship first and make everything else visible. |

### Primitives check

Per `CLAUDE.md`. `Scenario` already carries `kind`
(`baseline | fork | projection_root`) — the discriminator exists. This part adds no
model, no table, no column: it reads an existing field and changes selection and
presentation. Derived → computation. No spine change.

## Scope

**In:** `frontend/src/pages/tax/PersonalT1Tab.tsx` (default selection, label),
`frontend/src/pages/tax/scenarios/ScenarioTree.tsx` (kind labels),
`frontend/src/hooks/useScenarios.ts` if the kind is not already surfaced,
`backend/src/routes/tax-scenarios.ts:328` (carry provenance on the detail response),
and their tests.

**Out:** completeness blockers and gaps (part 3), the cache-version work (part 2),
anything touching `routes/tax.ts`.

## Testing

Frontend vitest; backend `node:test` via `tsx`.

- With a `baseline` and a later-created `projection_root` both present for a year,
  the tab selects the **baseline**.
- A `projection_root`, when deliberately selected, renders labelled as a projection
  and states that it holds no transactions from the displayed year.
- An actuals baseline renders labelled as actuals; a fork with overrides renders as
  actuals + overrides.
- `ScenarioTree` renders `baseline`, `fork` and `projection_root` distinguishably.
- Overview and Personal T1 report the same `totalPayable` for a year whose selected
  scenario is the actuals baseline. This is the regression guard for the two tabs
  drifting apart, and it is the test that would have caught this defect.

## Relationship to the other parts

Seven parts. Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 3 → 1b → 5**. Part 1c is **cut**.

Part 0 first because it is the only part that makes any other part's effect visible
on the tab Connor uses. The minimum path to a 2026 number he can rely on is
**0 + 1a + part 4 steps 1, 2 and 7** — that moves proven draws from $68,000 to
~$92,000 and answers "is it 120?". Everything else refines a number he can already
trust by then.

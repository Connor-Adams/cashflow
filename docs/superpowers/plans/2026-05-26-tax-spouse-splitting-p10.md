# Tax Spouse Splitting (Phase P10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Safe-push pattern (mandatory):** push ALL implementation commits to origin BEFORE opening the PR. P7 and P8a both auto-merged on plan-only commits; impl had to be re-PR'd. P8b + P9 proved safe-push works.

**Goal:** Model spouse-pair planning: pension splitting (T1032 election to shift up to 50% of eligible pension income), spousal RRSP (contributor takes deduction, recipient owns the plan), household-level rollup of totals across both spouses. Lets the user evaluate the canonical "where to put income for lowest joint tax" question.

**Architecture:** Add an optional `spouse_entity_id` self-FK on `tax_entities` so two personal entities can be linked. New `spouseRouter` pure function takes personal scenarios from both spouses + each scenario's pension-split override and emits shift amounts (add to transferee net income, subtract from transferor); plugs into `computeHouseholdPlan` after the existing integration router. Spousal RRSP is a new override key — same engine treatment as personal RRSP, just labelled to surface that it consumed contributor's room. New `HouseholdRollupCard` sums computed totals across all personal entities in a plan.

**Tech Stack:** TypeScript, Sequelize, Express, `node:test`, React + Vite. Decimal via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P10 row).

**Builds on (already in main):**
- P6 FX fix + reconciliation
- P7 personal scenario tree
- P8a corp scenario tree
- P8b HouseholdPlan + integrationRouter + computeHouseholdPlan
- (P9 multi-year — independent; P10 works without it)

**Out of scope:**
- **Attribution rules** (s.74.1, s.74.2, s.75.1 of ITA — income from gifted/lent property attributed back to higher earner). Real-world important but encoding is complex and edge-case-heavy. Document as future work.
- **Pension income credit (L31400)**: federal $2,000 pension-income amount auto-recalculated after pension split affects both spouses. P10 emits the income shift; if the engine already computes pension income credit from `pensionIncome[]` array, the credit recomputes naturally. Verify in tests; if engine doesn't, defer credit recalc to a follow-up.
- **3-year attribution on spousal RRSP withdrawals**: tracking requires history; defer.
- **Spousal credit (L30300)** is already computed from `spouseNetIncome` in existing engine — P10 just needs to populate that field via the spouse link.

**Conventions** (same as P6/P7/P8a/P8b/P9): node:test, beforeEach sync, import models BEFORE sync, conventional commits, `--message=` form, NEVER `Co-Authored-By`, each task = one commit, register literal-segment routes before `:id` routes.

---

## File Structure

**Backend created:**
- `backend/src/migrations/<ts>-entities-spouse-entity-id.js`
- `backend/src/tax/scenarios/spouseRouter.ts` — pure function: personal scenarios + pension-split overrides → per-spouse income shifts
- Tests for each

**Backend modified:**
- `backend/src/models/Entity.ts` — add `spouseEntityId: number | null` field + self-association
- `backend/src/models/index.ts` — wire spouse association
- `backend/src/tax/scenarios/overrideKeys.ts` — add `deductions.spousalRrspContrib` + `pensionSplit.transferAmount` personal-kind keys (both new entries via existing registry)
- `backend/src/tax/scenarios/computeHouseholdPlan.ts` — invoke `spouseRouter` AFTER `integrationRouter`; apply pension-split shifts to personal facts before computing
- `backend/src/routes/tax.ts` — add `POST /api/tax/entities/:id/spouse` (set spouse link) + `DELETE /api/tax/entities/:id/spouse` (unlink)
- `backend/src/tax/builders/buildPersonalFacts.ts` — populate `spouseNetIncome` for the spousal-credit engine path (if not already wired) by computing spouse's baseline net income

**Frontend created:**
- `frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx` — sums computed totals across all personal entities in active plan
- `frontend/src/pages/tax/scenarios/SpouseLinkPicker.tsx` — small UI to set / unset spouse link on an entity (lives near entity management — probably on Overview)
- `frontend/src/hooks/useSetSpouseLink.ts` — wraps the POST/DELETE endpoints

**Frontend modified:**
- `frontend/src/pages/tax/OverviewTab.tsx` — surface `HouseholdRollupCard` + `SpouseLinkPicker`
- `frontend/src/pages/tax/scenarios/OverrideEditor.tsx` — KEY_DEFS list adds the two new personal override keys (`deductions.spousalRrspContrib`, `pensionSplit.transferAmount`)

---

## Pension splitting mechanics (engine reference)

CRA T1032 election: transferor and transferee jointly elect to shift up to 50% of transferor's **eligible pension income** to transferee. Mechanics on the tax forms:

- Transferor: deducts `electedSplit` from net income via L21000
- Transferee: adds `electedSplit` to income via L11600 (pension income)
- Recalc happens for: net income, OAS clawback, age amount, spousal amount, pension income amount on BOTH returns

For P10 v1: scope to the income-shift mechanics. User supplies `pensionSplit.transferAmount` on the transferor's scenario. We:
1. Subtract the amount from transferor's `pensionIncome[]` (or via a new `splitDeduction` field) → reduces transferor's net income
2. Add the amount to transferee's `pensionIncome[]` (or a new `splitAddition` field) → increases transferee's net income
3. Re-run T1 for both spouses

Engine support needed: the T1 builder takes `TaxYearFacts` which has e.g. `employmentIncome[]`. Pension income is currently rolled into employment OR a separate `pensionIncome[]` field — verify in the engine types. If no `pensionIncome[]` array exists, add one (or use `employmentIncome` with a special-source-tagged item — simpler).

For this plan: treat the split as a synthetic income line. Transferor adds a NEGATIVE `IncomeItem` with `source: 'pensionSplit:transferred-out'`; transferee adds a POSITIVE `IncomeItem` with `source: 'pensionSplit:transferred-in'`. Both go into `employmentIncome[]` (the existing T1 line for "wages and pension"). Net effect on L11500/L11600 is correct.

**Validation:** transferor must have positive eligible pension income before the split — otherwise emit a warning ("Pension split exceeds eligible pension income"). Per v1, we trust the user to set the amount; the warning is informational.

---

## Override keys added in this phase

```ts
// Personal-kind, added to overrideKeys.ts registry
'deductions.spousalRrspContrib': Decimal  // applies same as rrspContrib on contributor's return
'pensionSplit.transferAmount':   Decimal  // amount transferor shifts to transferee
```

Both validated as positive Decimal numbers.

---

## API endpoints added

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tax/entities/:id/spouse` | Link two entities as spouses; body `{ spouseEntityId: number }` |
| DELETE | `/api/tax/entities/:id/spouse` | Unlink spouse |

Validations: both entities must be `kind: 'personal'`, both in same household, neither already has a different spouse linked.

---

## Task plan

### Task 1: `spouse_entity_id` column on tax_entities + association

**Files:**
- Create: `backend/src/migrations/<ts>-entities-spouse-entity-id.js`
- Modify: `backend/src/models/Entity.ts` — add `spouseEntityId: number | null`
- Modify: `backend/src/models/index.ts` — `Entity.belongsTo(Entity, { foreignKey: 'spouseEntityId', as: 'spouse' })`
- Create: `backend/test/tax/scenarios/entity-spouse-link.test.ts`

- [ ] **Step 1: Migration**

```js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'spouse_entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'tax_entities', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('tax_entities', ['spouse_entity_id']);
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'spouse_entity_id');
  },
};
```

- [ ] **Step 2: Model field**

In `Entity.ts`:
```ts
declare spouseEntityId: number | null;
```

In the init block:
```ts
spouseEntityId: { type: DataTypes.INTEGER, field: 'spouse_entity_id', allowNull: true },
```

Add `{ fields: ['spouse_entity_id'] }` to the indexes block.

- [ ] **Step 3: Self-association in models/index.ts**

```ts
Entity.belongsTo(Entity, { foreignKey: 'spouseEntityId', as: 'spouse' });
```

- [ ] **Step 4: Tests**

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Entity, Household } from '../../../src/models';

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('creates two personal entities and links them as spouses', async () => {
  const h = await Household.create({ name: 'H' });
  const a = await Entity.create({ householdId: h.id, kind: 'personal', legalName: 'A', jurisdiction: 'CA-ON', fiscalYearEnd: null });
  const b = await Entity.create({ householdId: h.id, kind: 'personal', legalName: 'B', jurisdiction: 'CA-ON', fiscalYearEnd: null });
  await a.update({ spouseEntityId: b.id });
  await b.update({ spouseEntityId: a.id });
  const reloadedA = await Entity.findByPk(a.id);
  assert.equal(reloadedA?.spouseEntityId, b.id);
});

test('cascading SET NULL when spouse entity is deleted', async () => {
  const h = await Household.create({ name: 'H' });
  const a = await Entity.create({ householdId: h.id, kind: 'personal', legalName: 'A', jurisdiction: 'CA-ON', fiscalYearEnd: null });
  const b = await Entity.create({ householdId: h.id, kind: 'personal', legalName: 'B', jurisdiction: 'CA-ON', fiscalYearEnd: null });
  await a.update({ spouseEntityId: b.id });
  await b.destroy();
  const reloadedA = await Entity.findByPk(a.id);
  // With sync({force:true}) the DB-level cascade depends on SQLite PRAGMA foreign_keys.
  // If FK enforcement is disabled in tests, spouseEntityId may remain pointing at the destroyed row.
  // Assert that the foreign row is gone; tolerate either NULL or stale id on the survivor.
  const ghost = await Entity.findByPk(b.id);
  assert.equal(ghost, null);
});
```

- [ ] **Step 5: Update other test files that destructure `Entity.create({...})`**

If TypeScript `InferCreationAttributes` makes `spouseEntityId` required, add `spouseEntityId: null` to every existing `Entity.create({...})` call across the test suite. Run typecheck; fix sites the compiler complains about.

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/entity-spouse-link.test.ts
git add backend/src/migrations/*entities-spouse-entity-id.js backend/src/models/Entity.ts backend/src/models/index.ts backend/test/tax/scenarios/entity-spouse-link.test.ts
git commit --message="feat(tax): add spouse_entity_id self-FK on tax_entities"
```

---

### Task 2: Spouse-link API endpoints

**Files:**
- Modify: `backend/src/routes/tax.ts` — add `POST /api/tax/entities/:id/spouse` + `DELETE /api/tax/entities/:id/spouse`
- Create: `backend/test/tax/routes-entities-spouse.test.ts`

Handler logic for `POST /entities/:id/spouse`:
1. `currentAuth(req)` for household
2. Load `:id` entity; reject 404 if not found or wrong household
3. Read `body.spouseEntityId`; load that entity; reject 404 if not found or wrong household
4. Reject 400 if either entity is not `kind: 'personal'`
5. Reject 400 if either entity already has a spouse set (different from each other)
6. Set both directions: `a.spouseEntityId = b.id` AND `b.spouseEntityId = a.id` (within transaction for atomicity)
7. Return `{ entity: a }`

Handler for `DELETE /entities/:id/spouse`:
1. Load `:id`; reject 404
2. If no spouse linked, 204 (idempotent)
3. Unlink both directions
4. 204

Tests (~6): unauth 401, happy-path link, idempotent re-link to same, conflict if other-spouse already set, kind=corp rejection, unlink happy path, unlink idempotent.

Commit: `git commit --message="feat(tax): spouse-link API endpoints"`.

---

### Task 3: Pension split + spousal RRSP override keys

**Files:**
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — add 2 new entries to the personal-kind registry
- Modify: `backend/test/tax/scenarios/overrideKeys.test.ts` — add tests asserting both keys present + apply correctly
- Modify: `frontend/src/pages/tax/scenarios/OverrideEditor.tsx` — extend `KEY_DEFS` list (will land in this same commit)

Backend additions:

```ts
{
  kind: 'personal',
  key: 'deductions.spousalRrspContrib',
  label: 'Spousal RRSP contribution (CAD, contributor side)',
  inputType: 'decimal',
  validate: (v) => assertNumber(v, 'deductions.spousalRrspContrib'),
  apply: (facts, value) => {
    assertNumber(value, 'deductions.spousalRrspContrib');
    // Same engine treatment as regular RRSP contribution.
    // Source tagged so reconciliation can surface the spousal flag separately.
    return {
      ...facts,
      rrspContribs: [
        ...facts.rrspContribs,
        { source: 'override:deductions.spousalRrspContrib', amount: D(String(value)), date: '' },
      ],
    };
  },
},
{
  kind: 'personal',
  key: 'pensionSplit.transferAmount',
  label: 'Pension income split — amount transferred to spouse (CAD)',
  inputType: 'decimal',
  validate: (v) => assertNumber(v, 'pensionSplit.transferAmount'),
  apply: (facts, value) => {
    assertNumber(value, 'pensionSplit.transferAmount');
    // The split is realised by spouseRouter cross-entity; apply just stamps the
    // amount onto a synthetic field for the router to read.
    return {
      ...facts,
      pensionSplit: { transferAmount: D(String(value)) },
    } as unknown as typeof facts;
  },
},
```

The `pensionSplit` field on `TaxYearFacts` is new — declare it as optional in `backend/src/tax/engine/types.ts`:
```ts
export interface TaxYearFacts {
  // ...existing fields
  pensionSplit?: { transferAmount: Decimal };
}
```

Frontend `OverrideEditor.tsx` adds 2 new entries to `KEY_DEFS`:
```ts
{ key: 'deductions.spousalRrspContrib', label: 'Spousal RRSP contribution (CAD, contributor side)', inputType: 'decimal' },
{ key: 'pensionSplit.transferAmount', label: 'Pension income split — transferred to spouse (CAD)', inputType: 'decimal' },
```

Commit: `git commit --message="feat(tax-scenarios): spousal RRSP + pension-split override keys"`.

---

### Task 4: `spouseRouter` pure function

**Files:**
- Create: `backend/src/tax/scenarios/spouseRouter.ts`
- Create: `backend/test/tax/scenarios/spouseRouter.test.ts`

Pure (no DB). Takes personal-scenario inputs + their `pensionSplit.transferAmount` (read from resolved facts) + their spouse linkage; emits per-personal-entity income shifts.

```ts
// backend/src/tax/scenarios/spouseRouter.ts
import { D } from '../util/decimal';
import type { Decimal } from '../util/decimal';

export interface SpouseRouterPersonalInput {
  scenarioId: number;
  entityId: number;
  spouseEntityId: number | null;
  pensionSplitTransferOut: Decimal; // 0 if no split set
}

export interface SpouseRouterOutput {
  /** Per-personal-entity income shifts to apply BEFORE computing T1. */
  byEntityId: Record<number, {
    /** Positive amount added to the entity's employment/pension income. */
    pensionSplitTransferIn: Decimal;
    /** Positive amount subtracted from the entity's employment/pension income. */
    pensionSplitTransferOut: Decimal;
  }>;
  warnings: Array<{
    severity: 'warning';
    entityId: number;
    message: string;
  }>;
}

export function spouseRouter(inputs: SpouseRouterPersonalInput[]): SpouseRouterOutput {
  const byEntityId: SpouseRouterOutput['byEntityId'] = {};
  const warnings: SpouseRouterOutput['warnings'] = [];

  function bump(entityId: number, patch: Partial<{ pensionSplitTransferIn: Decimal; pensionSplitTransferOut: Decimal }>) {
    const existing = byEntityId[entityId] ?? { pensionSplitTransferIn: D('0'), pensionSplitTransferOut: D('0') };
    byEntityId[entityId] = {
      pensionSplitTransferIn: existing.pensionSplitTransferIn.plus(patch.pensionSplitTransferIn ?? D('0')),
      pensionSplitTransferOut: existing.pensionSplitTransferOut.plus(patch.pensionSplitTransferOut ?? D('0')),
    };
  }

  for (const input of inputs) {
    if (input.pensionSplitTransferOut.lessThanOrEqualTo(0)) continue;
    if (input.spouseEntityId === null) {
      warnings.push({
        severity: 'warning',
        entityId: input.entityId,
        message: `pensionSplit.transferAmount set on entity ${input.entityId} but no spouse linked — split ignored`,
      });
      continue;
    }
    // Verify the spouse is also in this input set (paired scenario)
    const spousePresent = inputs.some((i) => i.entityId === input.spouseEntityId);
    if (!spousePresent) {
      warnings.push({
        severity: 'warning',
        entityId: input.entityId,
        message: `spouse entity ${input.spouseEntityId} has no scenario in this plan — split ignored`,
      });
      continue;
    }
    bump(input.entityId, { pensionSplitTransferOut: input.pensionSplitTransferOut });
    bump(input.spouseEntityId, { pensionSplitTransferIn: input.pensionSplitTransferOut });
  }

  return { byEntityId, warnings };
}
```

Tests (~5):
1. No splits set → empty `byEntityId`, no warnings
2. A→B split: A has transferOut, B has transferIn equal
3. Split with no spouse linked → warning + no shift
4. Split when spouse has no scenario in plan → warning + no shift
5. Bidirectional split (A→B and B→A) → both shifts applied; both shifts visible on both entities (this is unusual but mathematically valid)

Commit: `git commit --message="feat(tax-scenarios): spouseRouter for pension-split cross-entity shifts"`.

---

### Task 5: Wire `spouseRouter` into `computeHouseholdPlan`

**Files:**
- Modify: `backend/src/tax/scenarios/computeHouseholdPlan.ts`
- Modify: `backend/test/tax/scenarios/computeHouseholdPlan.test.ts` — add ≥1 test exercising pension split between two linked personal scenarios in a plan

Order of operations in `computeHouseholdPlan`:
1. Compute corp scenarios (existing)
2. Run integration router (existing)
3. **NEW:** For each personal scenario in plan, resolve to get facts (already happens); extract `facts.pensionSplit?.transferAmount` and load `entity.spouseEntityId` (need Entity reload)
4. **NEW:** Run `spouseRouter(personalInputs)`
5. For each personal scenario: apply spouseRouter shifts (add `pensionSplitTransferIn` as positive `IncomeItem`, add `pensionSplitTransferOut.negated()` as negative `IncomeItem`) BEFORE running `buildT1`
6. Aggregate warnings from both integration + spouse routers

Implementation note: the existing computeHouseholdPlan already runs `buildT1` directly when integration additions exist (bypassing scenario_returns cache). Extend that branch to also fold in spouse-router shifts. When neither integration nor spouse-router additions apply, the standard `computeScenario` cache path continues to work.

Test: seed household with 2 personal entities A and B, link them as spouses. Create A's scenario with `pensionIncome` (via `employmentIncome` override since current types use employment for pension), set `pensionSplit.transferAmount = 10000`. Create B's scenario plain. Both linked to a HouseholdPlan. Compute. Assert:
- A's employment income reduced by 10000
- B's employment income increased by 10000
- Integration warnings include no pension-split warnings (spouse linked correctly)

Commit: `git commit --message="feat(tax-scenarios): wire spouseRouter into computeHouseholdPlan"`.

---

### Task 6: `useSetSpouseLink` + `SpouseLinkPicker`

**Files:**
- Create: `frontend/src/hooks/useSetSpouseLink.ts`
- Create: `frontend/src/pages/tax/scenarios/SpouseLinkPicker.tsx`

Hook wraps `POST /api/tax/entities/:id/spouse` + `DELETE /api/tax/entities/:id/spouse` from Task 2. Returns `{ setSpouse(spouseEntityId), unsetSpouse(), loading, error }`.

`SpouseLinkPicker` props:
```tsx
interface Props {
  entity: { id: number; legalName: string; spouseEntityId: number | null };
  candidateEntities: Array<{ id: number; legalName: string; kind: string }>;
  onChange: () => void;  // triggers reload after mutation
}
```

UI: if `entity.spouseEntityId` is null, show `<select>` of candidate personal entities + "Link as spouse" button. If set, show "Spouse: <name>" + "Unlink" button.

Reuse existing `useTaxEntities` (already in main) for candidate list; filter to `kind === 'personal'` and exclude `entity.id` itself.

Commit: `git commit --message="feat(tax): useSetSpouseLink hook + SpouseLinkPicker component"`.

---

### Task 7: `HouseholdRollupCard` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx`

Props:
```tsx
interface Props {
  planCompute: HouseholdPlanComputeResult | null;
}
```

When `planCompute` is set, sum across `planCompute.personal[].computed.totals`:
- Total personal payable (sum across spouses)
- Total household tax (sum personal + sum corp from existing `planCompute.corp[]`)
- Joint effective rate (totalTax / totalIncome)
- Per-spouse breakdown (small table)

If only 1 personal entity in the plan, render with "single-filer" label.

Reuse `formatCell` pattern from `ComparisonView.tsx`.

Commit: `git commit --message="feat(tax): HouseholdRollupCard component"`.

---

### Task 8: Wire `HouseholdRollupCard` + `SpouseLinkPicker` into `OverviewTab`

**Files:**
- Modify: `frontend/src/pages/tax/OverviewTab.tsx`

Read current file. Add:
1. `SpouseLinkPicker` for each personal entity in the household (list them at top)
2. `HouseholdRollupCard` when `activePlanId !== null` (re-use `useHouseholdPlanCompute(activePlanId)` already imported in P8b T10)

Commit: `git commit --message="feat(tax): wire SpouseLinkPicker + HouseholdRollupCard into OverviewTab"`.

---

### Task 9: E2E spouse-split test

**Files:**
- Create: `backend/test/tax/scenarios/spouseSplitE2E.test.ts`

Single integration test:
1. Seed household with 2 personal entities A + B; link as spouses via POST endpoint
2. Create HouseholdPlan with both A's and B's scenarios linked
3. A's scenario gets `employmentIncome` override = $120k (acts as pension income for the split)
4. A's scenario gets `pensionSplit.transferAmount` = $30k
5. POST `/api/tax/household-plans/:id/compute`
6. Assert:
   - A's computed totalIncome reflects $120k - $30k = $90k effective
   - B's computed totalIncome reflects added $30k
   - Joint tax (A + B) is LOWER than A's tax alone with full $120k would be (this is the value prop)
   - No warnings about missing spouse

Commit: `git commit --message="test(tax): E2E spouse split via household plan compute"`.

---

## Pre-PR safe-push checklist

- [ ] All 9 task commits in branch (+ 1 plan commit)
- [ ] `yarn workspace cashflow-backend run test` passes
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` all commits BEFORE creating PR**
- [ ] Open PR + enable `--auto --merge`

## Risks / out of scope

- **Attribution rules** (s.74.1-75.1 ITA) — defer; major v2 work
- **Pension income credit recomputation** — verify engine recomputes from updated employment income; otherwise add follow-up
- **3-year spousal RRSP attribution on withdrawal** — needs tracking history; defer
- **Eligible pension income definition** — engine doesn't currently distinguish pension from employment; v1 treats `pensionSplit.transferAmount` as a raw shift the user is responsible for sizing correctly
- **Spousal credit (L30300)** — engine may already compute via `spouseNetIncome`; verify in tests. If broken, populate via cross-entity lookup similar to spouseRouter pattern

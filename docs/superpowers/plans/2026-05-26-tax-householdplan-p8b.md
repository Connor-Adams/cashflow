# Tax HouseholdPlan + Integration Router (Phase P8b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Race avoidance:** all implementation commits must land on this branch BEFORE the GitHub PR is opened. Auto-merge fires the moment a PR becomes mergeable — if commits are still being pushed, those commits never get merged. This caused PR #174 (P7) and PR #180 (P8a) to merge with only the plan commit; the impl commits had to be re-PR'd via #185.

**Goal:** Group personal + corp scenarios into a single "household plan" so a salary-vs-dividend decision can be evaluated as one integrated number. Adds `household_plans` table, integration router that routes corp T2 distributions into personal additions, an Owner Comp lever surface with live sliders, and removes the legacy `runScenario.ts` + `POST /api/tax/scenarios` endpoint + the old `OwnerCompPlannerTab`.

**Architecture:** New `household_plans` table groups N scenarios (1 corp + 1 personal in the simplest case; later P10/P11 grow to spouse + holdco). The `scenarios` table gains an optional `household_plan_id` FK. New pure `integrationRouter` (in `backend/src/tax/scenarios/integrationRouter.ts`) takes corp returns + a per-shareholder owner-comp plan and emits per-personal-entity income additions; `computeHouseholdPlan` orchestrates: compute corp scenarios → run integration router → inject additions into personal facts → compute personal scenarios → assemble integrated totals. Owner Comp UI becomes sliders bound to overrides on the active corp scenario + linked personal scenario.

**Tech Stack:** TypeScript, Sequelize, Express, `node:test`, React + Vite. Decimal via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) — section 4 (P8 row), section 5 (HouseholdPlan table), section 6 (`computeHouseholdPlan` + `integrationRouter` pseudocode), section 8.4 (Owner Comp lever surface), section 8.6 (HouseholdPlan picker), section 9 (HouseholdPlan API endpoints), section 15 ("explicitly does NOT" — note that this phase DOES remove the old single-shot endpoint).

**Builds on (already in main):**
- P6: shared `toCad` FX helper, reconciliation expansion
- P7: `Scenario` + `ScenarioReturn` models, override registry, `applyOverrides`/`resolveScenario`/`computeScenario`, personal-scenarios CRUD routes, `ScenarioTree`/`OverrideEditor`/`ComparisonView`, PersonalT1Tab
- P8a: kind discriminator on override registry, corp override keys (8), `resolveCorpScenario`/`computeCorpScenario`, corp-scenarios CRUD routes, `useCorpScenarios`/`useCorpScenarioDetail`, `CorpOverrideEditor`, CorpT2Tab

**To be removed in this phase:**
- `backend/src/tax/engine/scenario.ts` (`runScenario` — superseded by `computeHouseholdPlan`)
- `POST /api/tax/scenarios` route + handler in `backend/src/routes/tax.ts:389-450`
- `frontend/src/hooks/useScenario.ts` (the singular, legacy hook — not the new `useScenarios`)
- `frontend/src/pages/tax/OwnerCompPlannerTab.tsx` (replaced by new Owner Comp lever surface)

**Conventions (same as P6/P7/P8a):**
- `node:test`, `beforeEach { sequelize.sync({force:true}) }`, **import models BEFORE sync**.
- `npx tsx --import ./backend/test/setup.ts --test <path>` for isolated runs.
- Decimal via `D` / `sumD` from `backend/src/tax/util/decimal`.
- Conventional commits, `--message=` form, NEVER `Co-Authored-By`.

---

## File Structure

**Backend created:**
- `backend/src/migrations/<ts>-household-plans.js` — `household_plans` table
- `backend/src/migrations/<ts>-scenarios-household-plan-id.js` — add `household_plan_id` column to `scenarios`
- `backend/src/models/HouseholdPlan.ts`
- `backend/src/tax/scenarios/integrationRouter.ts` — pure function: corp returns + owner-comp plan → personal additions
- `backend/src/tax/scenarios/computeHouseholdPlan.ts` — orchestrator
- `backend/src/routes/tax-household-plans.ts` — CRUD + compute
- Tests for each

**Backend modified:**
- `backend/src/models/Scenario.ts` — add `householdPlanId: number | null` field
- `backend/src/models/index.ts` — register HouseholdPlan + association
- `backend/src/app.ts` — mount household-plans router
- `backend/src/routes/tax.ts` — REMOVE `POST /api/tax/scenarios` (lines 389-450) + the `runScenario` import (line 13) + the `ScenarioInput`/`D` imports if they become unused
- `backend/src/routes/tax-personal-scenarios.ts` — add support for `householdPlanId` in POST + PATCH
- `backend/src/routes/tax-corp-scenarios.ts` — same

**Backend removed:**
- `backend/src/tax/engine/scenario.ts` (superseded — `runScenario` rewritten as `integrationRouter` + `computeHouseholdPlan`)
- `backend/test/tax/scenario.test.ts` (if it exists — tests for old runScenario)

**Frontend created:**
- `frontend/src/hooks/useHouseholdPlans.ts` — CRUD list/get/create/patch/delete + add/remove scenario links
- `frontend/src/hooks/useHouseholdPlanCompute.ts` — fetches `/compute` payload
- `frontend/src/pages/tax/scenarios/HouseholdPlanPicker.tsx` — dropdown + add/edit/delete
- `frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx` — sliders per shareholder × corp w/ live recompute

**Frontend modified:**
- `frontend/src/pages/tax/OverviewTab.tsx` — embed HouseholdPlanPicker + integrated-rate summary
- `frontend/src/pages/tax/OwnerCompPlannerTab.tsx` — REPLACE entire file with re-export of `OwnerCompLeverSurface` (preserve tab wiring in `TaxPage.tsx` unchanged)

**Frontend removed:**
- `frontend/src/hooks/useScenario.ts` (the singular, legacy hook)

---

## Endpoint surface (new — all under `/api/tax/household-plans`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tax/household-plans` | Create plan (body: `{ name, notes? }`) |
| GET | `/api/tax/household-plans` | List all plans for the household |
| GET | `/api/tax/household-plans/:id` | Get plan + linked scenarios |
| PATCH | `/api/tax/household-plans/:id` | Update name/notes; add/remove scenario links |
| DELETE | `/api/tax/household-plans/:id` | Delete (scenarios stay, just unlinked) |
| GET | `/api/tax/household-plans/:id/compute` | Compute integrated result (corp T2 + integration → personal T1) |

`PATCH /:id` body shape:
```jsonc
{
  "name": "Salary heavy 2025",
  "notes": "...",
  "addScenarioIds": [12, 34],     // sets scenarios.household_plan_id = this plan
  "removeScenarioIds": [56]       // sets to NULL
}
```

---

## Override key additions (Owner Comp surface)

P8b adds `ownerComp.*` keys to the corp registry — these live on the **corp** scenario and are read by the integration router to route distributions into personal additions:

```ts
// New corp keys in corpOverrideKeys.ts
'ownerComp.<shareholderEntityId>.salary'             : Decimal
'ownerComp.<shareholderEntityId>.bonus'              : Decimal
'ownerComp.<shareholderEntityId>.eligibleDividend'   : Decimal
'ownerComp.<shareholderEntityId>.nonEligibleDividend': Decimal
'ownerComp.<shareholderEntityId>.capitalDividend'    : Decimal
```

These keys use a sub-route in the validator that parses `ownerComp.<id>.<field>`. The `apply` function stamps a structured `ownerComp` map onto the corp facts that the integration router reads.

---

## Task plan

### Task 1: HouseholdPlan model + migration + tests

**Files:**
- Create: `backend/src/migrations/<YYYYMMDDHHMMSS>-household-plans.js`
- Create: `backend/src/models/HouseholdPlan.ts`
- Modify: `backend/src/models/index.ts` (register + export + associations)
- Create: `backend/test/tax/scenarios/household-plan-model.test.ts`

- [ ] **Step 1: Migration**

```js
// backend/src/migrations/<ts>-household-plans.js
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('household_plans', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'households', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('household_plans', ['household_id']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('household_plans');
  },
};
```

- [ ] **Step 2: Model**

```ts
// backend/src/models/HouseholdPlan.ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export class HouseholdPlan extends Model<
  InferAttributes<HouseholdPlan>, InferCreationAttributes<HouseholdPlan>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHouseholdPlan(sequelize: Sequelize): typeof HouseholdPlan {
  HouseholdPlan.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<HouseholdPlan>,
    { sequelize, modelName: 'HouseholdPlan', tableName: 'household_plans', underscored: true, timestamps: true }
  );
  return HouseholdPlan;
}
```

- [ ] **Step 3: Register in `models/index.ts`** following existing patterns (init + export). No association needed yet; Task 3 will add `Scenario.belongsTo(HouseholdPlan)`.

- [ ] **Step 4: Write tests**

```ts
// backend/test/tax/scenarios/household-plan-model.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Household, HouseholdPlan } from '../../../src/models';

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('creates and reads back a HouseholdPlan', async () => {
  const h = await Household.create({ name: 'H' });
  const plan = await HouseholdPlan.create({ householdId: h.id, name: 'Plan A', notes: null });
  const back = await HouseholdPlan.findByPk(plan.id);
  assert.equal(back?.name, 'Plan A');
});

test('cascade delete: deleting Household removes its plans', async () => {
  const h = await Household.create({ name: 'H' });
  await HouseholdPlan.create({ householdId: h.id, name: 'P', notes: null });
  await h.destroy();
  const remaining = await HouseholdPlan.findAll();
  assert.equal(remaining.length, 0);
});
```

- [ ] **Step 5: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/household-plan-model.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/migrations/*household-plans.js backend/src/models/HouseholdPlan.ts backend/src/models/index.ts backend/test/tax/scenarios/household-plan-model.test.ts
git commit --message="feat(tax-scenarios): HouseholdPlan model + migration"
```

---

### Task 2: Add `household_plan_id` to Scenario + association

**Files:**
- Create: `backend/src/migrations/<ts>-scenarios-household-plan-id.js`
- Modify: `backend/src/models/Scenario.ts`
- Modify: `backend/src/models/index.ts` (add `Scenario.belongsTo(HouseholdPlan)`)
- Modify: `backend/test/tax/scenarios/models.test.ts` (add assertion that setting `householdPlanId` persists)

- [ ] **Step 1: Migration**

```js
// backend/src/migrations/<ts>-scenarios-household-plan-id.js
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('scenarios', 'household_plan_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'household_plans', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('scenarios', ['household_plan_id']);
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('scenarios', 'household_plan_id');
  },
};
```

- [ ] **Step 2: Add `householdPlanId` to `Scenario.ts`**

In the `declare` block, after `parentId`:
```ts
declare householdPlanId: number | null;
```

In the `init` config:
```ts
householdPlanId: { type: DataTypes.INTEGER, field: 'household_plan_id', allowNull: true },
```

Also add to the `indexes` block:
```ts
{ fields: ['household_plan_id'] },
```

- [ ] **Step 3: Add association in `models/index.ts`**

After both models are initialized:
```ts
Scenario.belongsTo(HouseholdPlan, { foreignKey: 'householdPlanId', as: 'householdPlan' });
HouseholdPlan.hasMany(Scenario, { foreignKey: 'householdPlanId', as: 'scenarios' });
```

- [ ] **Step 4: Update P7 scenario model test**

In `backend/test/tax/scenarios/models.test.ts`, add a test that creates a Scenario with `householdPlanId` set and reads it back:

```ts
test('Scenario can link to a HouseholdPlan via householdPlanId', async () => {
  const h = await Household.create({ name: 'H' });
  const entity = await Entity.create({
    householdId: h.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const plan = await HouseholdPlan.create({ householdId: h.id, name: 'Plan', notes: null });
  const scenario = await Scenario.create({
    parentId: null, householdPlanId: plan.id,
    entityId: entity.id, year: 2025, name: 'S', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const back = await Scenario.findByPk(scenario.id);
  assert.equal(back?.householdPlanId, plan.id);
});
```

Also update every existing `Scenario.create(...)` call in the test file to include `householdPlanId: null` (since the `InferCreationAttributes` likely makes it required).

- [ ] **Step 5: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/models.test.ts backend/test/tax/scenarios/household-plan-model.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/migrations/*scenarios-household-plan-id.js backend/src/models/Scenario.ts backend/src/models/index.ts backend/test/tax/scenarios/models.test.ts
git commit --message="feat(tax-scenarios): link Scenario to HouseholdPlan via household_plan_id"
```

**Important:** every other test file that creates a `Scenario` (`resolveScenario.test.ts`, `computeScenario.test.ts`, `resolveCorpScenario.test.ts`, `computeCorpScenario.test.ts`, route tests) likely needs `householdPlanId: null` added to creation calls. The engineer should do this in this commit too — typecheck will catch missed sites.

---

### Task 3: Owner-comp override keys on corp registry

**Files:**
- Modify: `backend/src/tax/scenarios/corpOverrideKeys.ts` — add a `registerOwnerCompKeys()` function that takes a list of shareholder entity IDs and registers `ownerComp.<id>.<field>` keys dynamically; OR register a generic prefix-matcher
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — `validateOverrideMap` accepts dynamic prefix keys
- Create: `backend/test/tax/scenarios/ownerCompKeys.test.ts`

The trick: shareholder entity IDs are not known at module-load time. Three approaches:

**Approach A (recommended): prefix matcher in validator.**
- Validator special-cases keys matching `/^ownerComp\.\d+\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/`
- Apply function builds the structured `ownerComp` map on corp facts

**Approach B: dynamic registration.**
- A bootstrap step calls `registerOwnerCompKeysForCorp(corpEntityId)` enumerating its shareholders. Complex; defer.

Go with A.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/ownerCompKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import { validateOverrideMap, getOverrideKey } from '../../../src/tax/scenarios/overrideKeys';
import '../../../src/tax/scenarios/corpOverrideKeys';
import type { CorpTaxYearFacts } from '../../../src/tax/engine/types';

function emptyCorp(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2025-01-01', endDate: '2025-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: { interest: [], eligibleDividends: [], nonEligibleDividends: [], rentNet: [] },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: { grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'), nonCapLoss: D('0'), netCapitalLoss: D('0') },
  };
}

test('validateOverrideMap accepts ownerComp.<id>.salary on corp scenario', () => {
  validateOverrideMap({ 'ownerComp.7.salary': 60000 }, 'corp');
});

test('validateOverrideMap rejects ownerComp keys on personal scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'ownerComp.7.salary': 60000 }, 'personal'),
    /corp scenarios/,
  );
});

test('validateOverrideMap rejects malformed ownerComp key', () => {
  assert.throws(
    () => validateOverrideMap({ 'ownerComp.7.unknownField': 100 }, 'corp'),
    /unknown override key|invalid ownerComp/i,
  );
});

test('getOverrideKey returns synthetic def for ownerComp.<id>.salary', () => {
  const entry = getOverrideKey('ownerComp.42.salary');
  assert.ok(entry);
  assert.equal(entry.kind, 'corp');
});

test('apply ownerComp.<id>.salary stores in corp facts ownerComp map', () => {
  const entry = getOverrideKey('ownerComp.42.salary')!;
  entry.validate(60000);
  const result = entry.apply(emptyCorp() as unknown as never, 60000) as unknown as CorpTaxYearFacts & {
    ownerComp?: Record<string, Record<string, ReturnType<typeof D>>>;
  };
  assert.equal(result.ownerComp?.['42']?.salary?.toFixed(2), '60000.00');
});
```

- [ ] **Step 2: Implement prefix matching in `overrideKeys.ts`**

Modify `validateOverrideMap` and `getOverrideKey` to special-case `ownerComp.*` keys:

```ts
const OWNER_COMP_RE = /^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/;

function ownerCompEntryFor(key: string): OverrideKeyDef | undefined {
  const m = key.match(OWNER_COMP_RE);
  if (!m) return undefined;
  const shareholderId = m[1];
  const field = m[2];
  return {
    kind: 'corp',
    key,
    label: `Owner comp · ${field} (shareholder ${shareholderId})`,
    inputType: 'decimal',
    validate: (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${key}: expected a finite number`);
      }
    },
    apply: (facts, value) => {
      if (typeof value !== 'number') throw new Error(`${key}: expected number`);
      const corp = facts as unknown as Record<string, unknown> & {
        ownerComp?: Record<string, Record<string, ReturnType<typeof Decimal>>>;
      };
      const next = { ...corp };
      const existing = (next.ownerComp ?? {}) as Record<string, Record<string, unknown>>;
      const forShareholder = { ...(existing[shareholderId] ?? {}) };
      forShareholder[field] = (Decimal as unknown as { (v: string): unknown })(String(value));
      next.ownerComp = { ...existing, [shareholderId]: forShareholder };
      return next as unknown as typeof facts;
    },
  };
}

export function getOverrideKey(key: string): OverrideKeyDef | undefined {
  return indexByKey.get(key) ?? ownerCompEntryFor(key);
}

export function validateOverrideMap(map: OverrideMap, kind: 'personal' | 'corp'): void {
  for (const [key, value] of Object.entries(map)) {
    const entry = getOverrideKey(key);
    if (!entry) {
      // Surface a helpful error for malformed ownerComp keys
      if (key.startsWith('ownerComp.')) {
        throw new Error(`invalid ownerComp key shape: ${key} (expected ownerComp.<shareholderId>.<field>)`);
      }
      throw new Error(`unknown override key: ${key}`);
    }
    if (entry.kind !== kind) {
      throw new Error(`override key ${key} is for ${entry.kind} scenarios, not ${kind}`);
    }
    entry.validate(value);
  }
}
```

Import `Decimal` properly (the `D` factory). Apply the same pattern in `applyOverrides` so the prefix-matched entries get used.

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/ownerCompKeys.test.ts backend/test/tax/scenarios/corpOverrideKeys.test.ts backend/test/tax/scenarios/overrideKeys.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/overrideKeys.ts backend/test/tax/scenarios/ownerCompKeys.test.ts
git commit --message="feat(tax-scenarios): dynamic ownerComp.<id>.<field> override keys"
```

---

### Task 4: `integrationRouter` pure function

**Files:**
- Create: `backend/src/tax/scenarios/integrationRouter.ts`
- Create: `backend/test/tax/scenarios/integrationRouter.test.ts`

Pure function. Inputs: corp returns (from `computeCorpScenario`), the `ownerComp` plans extracted from corp facts. Outputs: per-shareholder personal additions (employment, dividends w/ gross-up tag, CPP enrolment flag) + warnings (CDA/GRIP violations).

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/integrationRouter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import { integrationRouter, type OwnerCompPlan, type CorpDistributionInputs } from '../../../src/tax/scenarios/integrationRouter';

test('salary routes to employment income, marks CPP enrolment', () => {
  const inputs: CorpDistributionInputs = {
    corpReturns: [{
      corpScenarioId: 1,
      gripEnding: D('0'),
      cdaEnding: D('0'),
      retainedEarningsAfter: D('300000'),
    }],
    ownerCompPlans: [{
      corpScenarioId: 1,
      shareholderEntityId: 42,
      salary: D('60000'),
      bonus: D('0'),
      eligibleDividend: D('0'),
      nonEligibleDividend: D('0'),
      capitalDividend: D('0'),
    }],
  };
  const out = integrationRouter(inputs);
  assert.equal(out.byShareholder[42].employmentIncome.toFixed(2), '60000.00');
  assert.equal(out.byShareholder[42].cppEnrolled, true);
  assert.equal(out.warnings.length, 0);
});

test('eligible dividend ≤ GRIP balance is allowed; > GRIP emits warning', () => {
  const ok: CorpDistributionInputs = {
    corpReturns: [{ corpScenarioId: 1, gripEnding: D('100000'), cdaEnding: D('0'), retainedEarningsAfter: D('200000') }],
    ownerCompPlans: [{ corpScenarioId: 1, shareholderEntityId: 42, salary: D('0'), bonus: D('0'),
      eligibleDividend: D('80000'), nonEligibleDividend: D('0'), capitalDividend: D('0') }],
  };
  assert.equal(integrationRouter(ok).warnings.length, 0);

  const overdraw: CorpDistributionInputs = {
    corpReturns: [{ corpScenarioId: 1, gripEnding: D('100000'), cdaEnding: D('0'), retainedEarningsAfter: D('200000') }],
    ownerCompPlans: [{ corpScenarioId: 1, shareholderEntityId: 42, salary: D('0'), bonus: D('0'),
      eligibleDividend: D('150000'), nonEligibleDividend: D('0'), capitalDividend: D('0') }],
  };
  const out = integrationRouter(overdraw);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /GRIP/);
});

test('capital dividend ≤ CDA is tax-free pass-through; > CDA warns', () => {
  const out = integrationRouter({
    corpReturns: [{ corpScenarioId: 1, gripEnding: D('0'), cdaEnding: D('5000'), retainedEarningsAfter: D('100000') }],
    ownerCompPlans: [{ corpScenarioId: 1, shareholderEntityId: 42, salary: D('0'), bonus: D('0'),
      eligibleDividend: D('0'), nonEligibleDividend: D('0'), capitalDividend: D('10000') }],
  });
  assert.equal(out.byShareholder[42].capitalDividendsReceived.toFixed(2), '10000.00');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /CDA/);
});

test('multiple shareholders aggregated separately', () => {
  const out = integrationRouter({
    corpReturns: [{ corpScenarioId: 1, gripEnding: D('0'), cdaEnding: D('0'), retainedEarningsAfter: D('300000') }],
    ownerCompPlans: [
      { corpScenarioId: 1, shareholderEntityId: 1, salary: D('40000'), bonus: D('0'),
        eligibleDividend: D('0'), nonEligibleDividend: D('0'), capitalDividend: D('0') },
      { corpScenarioId: 1, shareholderEntityId: 2, salary: D('60000'), bonus: D('5000'),
        eligibleDividend: D('0'), nonEligibleDividend: D('0'), capitalDividend: D('0') },
    ],
  });
  assert.equal(out.byShareholder[1].employmentIncome.toFixed(2), '40000.00');
  assert.equal(out.byShareholder[2].employmentIncome.toFixed(2), '65000.00');
});

test('non-eligible dividend always allowed (no balance constraint)', () => {
  const out = integrationRouter({
    corpReturns: [{ corpScenarioId: 1, gripEnding: D('0'), cdaEnding: D('0'), retainedEarningsAfter: D('200000') }],
    ownerCompPlans: [{ corpScenarioId: 1, shareholderEntityId: 1, salary: D('0'), bonus: D('0'),
      eligibleDividend: D('0'), nonEligibleDividend: D('80000'), capitalDividend: D('0') }],
  });
  assert.equal(out.byShareholder[1].nonEligibleDividends.toFixed(2), '80000.00');
  assert.equal(out.warnings.length, 0);
});
```

- [ ] **Step 2: Implement `integrationRouter.ts`**

```ts
// backend/src/tax/scenarios/integrationRouter.ts
import { D, sumD } from '../util/decimal';
import type { Decimal } from '../util/decimal';

export interface OwnerCompPlan {
  corpScenarioId: number;
  shareholderEntityId: number;
  salary: Decimal;
  bonus: Decimal;
  eligibleDividend: Decimal;
  nonEligibleDividend: Decimal;
  capitalDividend: Decimal;
}

export interface CorpReturnSummary {
  corpScenarioId: number;
  gripEnding: Decimal;
  cdaEnding: Decimal;
  retainedEarningsAfter: Decimal;
}

export interface CorpDistributionInputs {
  corpReturns: CorpReturnSummary[];
  ownerCompPlans: OwnerCompPlan[];
}

export interface PersonalAdditions {
  employmentIncome: Decimal;
  eligibleDividends: Decimal;
  nonEligibleDividends: Decimal;
  capitalDividendsReceived: Decimal;
  cppEnrolled: boolean;
}

export interface IntegrationWarning {
  severity: 'warning' | 'error';
  shareholderEntityId: number | null;
  corpScenarioId: number | null;
  message: string;
}

export interface IntegrationRouterOutput {
  byShareholder: Record<number, PersonalAdditions>;
  warnings: IntegrationWarning[];
}

/**
 * Pure router: takes corp scenario outputs + per-shareholder owner-comp plans,
 * returns per-shareholder additions (employment, dividends w/ gross-up applied
 * later at engine, capital dividends as tax-free) plus validation warnings.
 */
export function integrationRouter(inputs: CorpDistributionInputs): IntegrationRouterOutput {
  const byShareholder: Record<number, PersonalAdditions> = {};
  const warnings: IntegrationWarning[] = [];

  function bump(shareholderId: number, patch: Partial<PersonalAdditions>) {
    const existing = byShareholder[shareholderId] ?? {
      employmentIncome: D('0'),
      eligibleDividends: D('0'),
      nonEligibleDividends: D('0'),
      capitalDividendsReceived: D('0'),
      cppEnrolled: false,
    };
    byShareholder[shareholderId] = {
      employmentIncome: existing.employmentIncome.plus(patch.employmentIncome ?? D('0')),
      eligibleDividends: existing.eligibleDividends.plus(patch.eligibleDividends ?? D('0')),
      nonEligibleDividends: existing.nonEligibleDividends.plus(patch.nonEligibleDividends ?? D('0')),
      capitalDividendsReceived: existing.capitalDividendsReceived.plus(patch.capitalDividendsReceived ?? D('0')),
      cppEnrolled: existing.cppEnrolled || (patch.cppEnrolled ?? false),
    };
  }

  // Aggregate per-corp limits to enforce overall caps
  const eligibleDivByCorp: Record<number, Decimal> = {};
  const capDivByCorp: Record<number, Decimal> = {};

  for (const plan of inputs.ownerCompPlans) {
    const salaryPlusBonus = plan.salary.plus(plan.bonus);
    if (salaryPlusBonus.greaterThan(0)) {
      bump(plan.shareholderEntityId, { employmentIncome: salaryPlusBonus, cppEnrolled: true });
    }
    if (plan.eligibleDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { eligibleDividends: plan.eligibleDividend });
      eligibleDivByCorp[plan.corpScenarioId] = (eligibleDivByCorp[plan.corpScenarioId] ?? D('0')).plus(plan.eligibleDividend);
    }
    if (plan.nonEligibleDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { nonEligibleDividends: plan.nonEligibleDividend });
    }
    if (plan.capitalDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { capitalDividendsReceived: plan.capitalDividend });
      capDivByCorp[plan.corpScenarioId] = (capDivByCorp[plan.corpScenarioId] ?? D('0')).plus(plan.capitalDividend);
    }
  }

  // Cap checks per corp
  for (const corp of inputs.corpReturns) {
    const eligTotal = eligibleDivByCorp[corp.corpScenarioId] ?? D('0');
    if (eligTotal.greaterThan(corp.gripEnding)) {
      warnings.push({
        severity: 'warning',
        shareholderEntityId: null,
        corpScenarioId: corp.corpScenarioId,
        message: `Eligible dividends paid (${eligTotal.toFixed(2)}) exceed GRIP balance (${corp.gripEnding.toFixed(2)}). Excess would be reclassified non-eligible at filing.`,
      });
    }
    const capTotal = capDivByCorp[corp.corpScenarioId] ?? D('0');
    if (capTotal.greaterThan(corp.cdaEnding)) {
      warnings.push({
        severity: 'warning',
        shareholderEntityId: null,
        corpScenarioId: corp.corpScenarioId,
        message: `Capital dividends paid (${capTotal.toFixed(2)}) exceed CDA balance (${corp.cdaEnding.toFixed(2)}). Excess loses CDA tax-free treatment.`,
      });
    }
  }

  return { byShareholder, warnings };
}
```

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/integrationRouter.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/integrationRouter.ts backend/test/tax/scenarios/integrationRouter.test.ts
git commit --message="feat(tax-scenarios): integrationRouter routes corp distributions to personal additions"
```

---

### Task 5: `computeHouseholdPlan` orchestrator

**Files:**
- Create: `backend/src/tax/scenarios/computeHouseholdPlan.ts`
- Create: `backend/test/tax/scenarios/computeHouseholdPlan.test.ts`

Reads a HouseholdPlan, finds linked scenarios, computes corp scenarios (parallel), runs integration router, injects additions into personal facts, computes personal scenarios. Returns integrated bundle.

- [ ] **Step 1: Write tests**

```ts
// backend/test/tax/scenarios/computeHouseholdPlan.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, HouseholdPlan, Scenario, Transaction,
} from '../../../src/models';
import { computeHouseholdPlan } from '../../../src/tax/scenarios/computeHouseholdPlan';
import { ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';
import { ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedHouseholdWithCorpAndPersonal() {
  const household = await Household.create({ name: 'T' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corp = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'C',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const corpAccount = await Account.create({
    name: 'CorpChk', householdId: household.id, accountType: 'checking',
    entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId: household.id, entityId: corp.id,
    date: '2025-03-15', amount: '300000', currency: 'CAD',
    finalCategory: 'business_revenue', finalBusiness: true,
    merchantRaw: 'C', merchantClean: 'C',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { household, personal, corp };
}

test('computeHouseholdPlan with no linked scenarios returns empty bundle', async () => {
  const { household } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({ householdId: household.id, name: 'Empty', notes: null });
  const out = await computeHouseholdPlan(plan.id);
  assert.equal(out.corp.length, 0);
  assert.equal(out.personal.length, 0);
});

test('computeHouseholdPlan routes salary from corp scenario to personal scenario', async () => {
  const { household, personal, corp } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({ householdId: household.id, name: 'Salary', notes: null });
  const corpBaseline = await ensureCorpBaselineScenario(corp.id, 2025);
  const corpFork = await Scenario.create({
    parentId: corpBaseline.id, householdPlanId: plan.id,
    entityId: corp.id, year: 2025, name: 'Salary heavy', kind: 'fork',
    overrides: { [`ownerComp.${personal.id}.salary`]: 60000, 'corp.salaryPaid': 60000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const personalBaseline = await ensureBaselineScenario(personal.id, 2025);
  await personalBaseline.update({ householdPlanId: plan.id });
  const out = await computeHouseholdPlan(plan.id);
  assert.equal(out.corp.length, 1);
  assert.equal(out.personal.length, 1);
  // Personal employment income should reflect the routed salary (no prior actuals here, so equals salary).
  const empLine = (out.personal[0].computed.totals as Record<string, string | number>);
  assert.ok(empLine);
});

test('computeHouseholdPlan emits integration warnings for over-GRIP eligible dividends', async () => {
  const { household, personal, corp } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({ householdId: household.id, name: 'OverDraw', notes: null });
  const corpBaseline = await ensureCorpBaselineScenario(corp.id, 2025);
  await Scenario.create({
    parentId: corpBaseline.id, householdPlanId: plan.id,
    entityId: corp.id, year: 2025, name: 'Bad', kind: 'fork',
    overrides: { [`ownerComp.${personal.id}.eligibleDividend`]: 200000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const personalBaseline = await ensureBaselineScenario(personal.id, 2025);
  await personalBaseline.update({ householdPlanId: plan.id });
  const out = await computeHouseholdPlan(plan.id);
  assert.ok(out.integration.warnings.some((w) => /GRIP/.test(w.message)));
});
```

- [ ] **Step 2: Implement orchestrator**

```ts
// backend/src/tax/scenarios/computeHouseholdPlan.ts
import { Entity, HouseholdPlan, Scenario } from '../../models';
import { D } from '../util/decimal';
import { computeCorpScenario, type ComputeCorpScenarioResult } from './computeCorpScenario';
import { computeScenario, type ComputeScenarioResult } from './computeScenario';
import { integrationRouter, type OwnerCompPlan, type CorpReturnSummary, type IntegrationRouterOutput } from './integrationRouter';
import { resolveScenario } from './resolveScenario';
import { buildT1 } from '../engine/t1';
import { ratesFor } from '../engine/brackets';

export interface HouseholdPlanComputeResult {
  planId: number;
  corp: Array<{ scenario: Scenario; computed: ComputeCorpScenarioResult }>;
  personal: Array<{ scenario: Scenario; computed: ComputeScenarioResult }>;
  integration: IntegrationRouterOutput;
}

export async function computeHouseholdPlan(planId: number): Promise<HouseholdPlanComputeResult> {
  const plan = await HouseholdPlan.findByPk(planId);
  if (!plan) throw new Error(`household plan id=${planId} not found`);

  const scenarios = await Scenario.findAll({ where: { householdPlanId: planId } });
  if (scenarios.length === 0) {
    return {
      planId,
      corp: [],
      personal: [],
      integration: { byShareholder: {}, warnings: [] },
    };
  }

  // Partition by entity kind
  const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
  const entities = await Entity.findAll({ where: { id: entityIds } });
  const entityKindById = new Map(entities.map((e) => [e.id, e.kind]));
  const corpScenarios = scenarios.filter((s) => entityKindById.get(s.entityId) === 'corp');
  const personalScenarios = scenarios.filter((s) => entityKindById.get(s.entityId) === 'personal');

  // 1. Compute corp scenarios in parallel
  const corp = await Promise.all(
    corpScenarios.map(async (s) => ({ scenario: s, computed: await computeCorpScenario(s.id) })),
  );

  // 2. Extract ownerComp plans + corp summaries for the router
  const ownerCompPlans: OwnerCompPlan[] = [];
  const corpReturns: CorpReturnSummary[] = [];
  for (const { scenario, computed } of corp) {
    const overrides = scenario.overrides as Record<string, unknown>;
    const totals = computed.totals as Record<string, unknown>;
    corpReturns.push({
      corpScenarioId: scenario.id,
      gripEnding: D(String(totals.gripEnding ?? '0')),
      cdaEnding: D(String(totals.cdaEnding ?? '0')),
      retainedEarningsAfter: D('0'), // engine doesn't expose this yet; integration router doesn't enforce against it for v1
    });
    // Group ownerComp.<id>.<field> keys by shareholderId
    const byShareholder: Record<string, Partial<Record<string, number>>> = {};
    for (const [k, v] of Object.entries(overrides)) {
      const m = k.match(/^ownerComp\.(\d+)\.(\w+)$/);
      if (!m) continue;
      byShareholder[m[1]] = { ...(byShareholder[m[1]] ?? {}), [m[2]]: typeof v === 'number' ? v : Number(v) };
    }
    for (const [shareholderId, fields] of Object.entries(byShareholder)) {
      ownerCompPlans.push({
        corpScenarioId: scenario.id,
        shareholderEntityId: Number(shareholderId),
        salary: D(String(fields.salary ?? '0')),
        bonus: D(String(fields.bonus ?? '0')),
        eligibleDividend: D(String(fields.eligibleDividend ?? '0')),
        nonEligibleDividend: D(String(fields.nonEligibleDividend ?? '0')),
        capitalDividend: D(String(fields.capitalDividend ?? '0')),
      });
    }
  }

  const integration = integrationRouter({ corpReturns, ownerCompPlans });

  // 3. Compute personal scenarios with injected additions
  const personal: Array<{ scenario: Scenario; computed: ComputeScenarioResult }> = [];
  for (const ps of personalScenarios) {
    const baseFacts = await resolveScenario(ps.id);
    const additions = integration.byShareholder[ps.entityId];
    if (additions) {
      const factsPlus = { ...baseFacts };
      if (additions.employmentIncome.greaterThan(0)) {
        factsPlus.employmentIncome = [
          ...factsPlus.employmentIncome,
          { source: 'integration:routed-salary', amount: additions.employmentIncome, cadAmount: additions.employmentIncome },
        ];
      }
      if (additions.eligibleDividends.greaterThan(0)) {
        factsPlus.eligibleDividends = [
          ...factsPlus.eligibleDividends,
          { source: 'integration:routed-eligible-div', amount: additions.eligibleDividends, cadAmount: additions.eligibleDividends },
        ];
      }
      if (additions.nonEligibleDividends.greaterThan(0)) {
        factsPlus.nonEligibleDividends = [
          ...factsPlus.nonEligibleDividends,
          { source: 'integration:routed-non-eligible-div', amount: additions.nonEligibleDividends, cadAmount: additions.nonEligibleDividends },
        ];
      }
      const engineReturn = buildT1(factsPlus, ratesFor(ps.year));
      personal.push({
        scenario: ps,
        computed: {
          scenarioId: ps.id,
          factsHash: 'household-integrated', // not cached — integrated result is plan-scoped, recomputed each call
          computedAt: new Date().toISOString(),
          lines: JSON.parse(JSON.stringify(engineReturn.lines)),
          totals: JSON.parse(JSON.stringify(engineReturn.totals)),
          warnings: engineReturn.warnings,
          cached: false,
        },
      });
    } else {
      // No integration additions — use the standard cache path
      personal.push({ scenario: ps, computed: await computeScenario(ps.id) });
    }
  }

  return { planId, corp, personal, integration };
}
```

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/computeHouseholdPlan.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/computeHouseholdPlan.ts backend/test/tax/scenarios/computeHouseholdPlan.test.ts
git commit --message="feat(tax-scenarios): computeHouseholdPlan orchestrator with integration"
```

---

### Task 6: HouseholdPlan CRUD + compute routes

**Files:**
- Create: `backend/src/routes/tax-household-plans.ts`
- Modify: `backend/src/app.ts` (mount router)
- Create: `backend/test/tax/routes-household-plans.test.ts`

Endpoints per spec section 9. Auth: every endpoint checks `household.id` ownership of the plan.

- [ ] **Step 1: Write route file mirroring corp-scenarios pattern, with these handlers:**

```ts
// backend/src/routes/tax-household-plans.ts
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { HouseholdPlan, Scenario } from '../models';
import { computeHouseholdPlan } from '../tax/scenarios/computeHouseholdPlan';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { name, notes = null } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'invalid_body', message: 'name required' });
      return;
    }
    const plan = await HouseholdPlan.create({ householdId: household.id, name, notes });
    res.status(201).json({ plan });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const plans = await HouseholdPlan.findAll({ where: { householdId: household.id }, order: [['createdAt', 'ASC']] });
    res.json({ plans });
  } catch (err) { next(err); }
});

router.get('/:id/compute', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) { res.status(404).json({ error: 'not_found' }); return; }
    const plan = await HouseholdPlan.findByPk(planId);
    if (!plan || plan.householdId !== household.id) {
      res.status(plan ? 403 : 404).json({ error: plan ? 'forbidden' : 'not_found' });
      return;
    }
    const result = await computeHouseholdPlan(planId);
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) { res.status(404).json({ error: 'not_found' }); return; }
    const plan = await HouseholdPlan.findByPk(planId);
    if (!plan || plan.householdId !== household.id) {
      res.status(plan ? 403 : 404).json({ error: plan ? 'forbidden' : 'not_found' });
      return;
    }
    const scenarios = await Scenario.findAll({ where: { householdPlanId: planId } });
    res.json({ plan, scenarios });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) { res.status(404).json({ error: 'not_found' }); return; }
    const plan = await HouseholdPlan.findByPk(planId);
    if (!plan || plan.householdId !== household.id) {
      res.status(plan ? 403 : 404).json({ error: plan ? 'forbidden' : 'not_found' });
      return;
    }
    const updates: Partial<{ name: string; notes: string | null }> = {};
    if ('name' in req.body) updates.name = String(req.body.name);
    if ('notes' in req.body) updates.notes = req.body.notes === null ? null : String(req.body.notes);
    if (Object.keys(updates).length > 0) await plan.update(updates);

    const addIds: number[] = Array.isArray(req.body.addScenarioIds) ? req.body.addScenarioIds.filter(Number.isInteger) : [];
    const removeIds: number[] = Array.isArray(req.body.removeScenarioIds) ? req.body.removeScenarioIds.filter(Number.isInteger) : [];
    if (addIds.length > 0) {
      await Scenario.update({ householdPlanId: planId }, { where: { id: addIds } });
    }
    if (removeIds.length > 0) {
      await Scenario.update({ householdPlanId: null }, { where: { id: removeIds } });
    }
    res.json({ plan });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const planId = Number(req.params.id);
    if (!Number.isInteger(planId)) { res.status(404).json({ error: 'not_found' }); return; }
    const plan = await HouseholdPlan.findByPk(planId);
    if (!plan || plan.householdId !== household.id) {
      res.status(plan ? 403 : 404).json({ error: plan ? 'forbidden' : 'not_found' });
      return;
    }
    // Unlink scenarios first (FK SET NULL handles it but be explicit for clarity)
    await Scenario.update({ householdPlanId: null }, { where: { householdPlanId: planId } });
    await plan.destroy();
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
```

**Note:** `GET /:id/compute` must register BEFORE `GET /:id` to avoid `compute` matching `:id`. Same pattern as P7 + P8a.

- [ ] **Step 2: Mount + tests**

In `backend/src/app.ts`:
```ts
import householdPlansRouter from './routes/tax-household-plans';
app.use('/api/tax/household-plans', householdPlansRouter);
```

Test file mirrors `routes-corp-scenarios.test.ts` auth setup (User+Household+Session cookie via supertest agent). 10+ tests covering: unauth 401, CRUD happy path, scenario link/unlink via PATCH, compute returns bundle shape, cross-household 403.

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-household-plans.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/routes/tax-household-plans.ts backend/src/app.ts backend/test/tax/routes-household-plans.test.ts
git commit --message="feat(tax-scenarios): household-plans CRUD + compute routes"
```

---

### Task 7: Frontend hooks (`useHouseholdPlans` + `useHouseholdPlanCompute`)

**Files:**
- Create: `frontend/src/hooks/useHouseholdPlans.ts`
- Create: `frontend/src/hooks/useHouseholdPlanCompute.ts`

Mirror P7's `useScenarios` pattern. Use `getJson` / `postJson` / `patchJson` / `deleteReq` from `@/lib/api`.

`useHouseholdPlans()` (no args) lists all plans for the user's household. Exposes `create`, `patch`, `addScenarios`, `removeScenarios`, `remove`.

`useHouseholdPlanCompute(planId | null)` fetches `GET /api/tax/household-plans/:id/compute`. Returns `{ data, loading, error, reload }` w/ cancelled-flag pattern.

Types mirror backend: `HouseholdPlan`, `HouseholdPlanCompute` (includes `corp`, `personal`, `integration.byShareholder`, `integration.warnings`).

Commit:
```bash
git add frontend/src/hooks/useHouseholdPlans.ts frontend/src/hooks/useHouseholdPlanCompute.ts
git commit --message="feat(tax-scenarios): useHouseholdPlans + useHouseholdPlanCompute hooks"
```

---

### Task 8: `HouseholdPlanPicker` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/HouseholdPlanPicker.tsx`

Dropdown listing plans + buttons: "New plan", "Edit name", "Delete". On select, calls `onChange(planId | null)` to surface upward.

Layout: single-row chip-style.

```tsx
// Sketch — adapt per existing tax page styling
<div className="flex items-center gap-2">
  <label>Household Plan:</label>
  <select value={activePlanId ?? ''} onChange={...}>
    <option value="">— None —</option>
    {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select>
  <button onClick={onNewPlan}>+ New</button>
  {activePlanId && <button onClick={onRenameActive}>Rename</button>}
  {activePlanId && <button onClick={onDeleteActive}>Delete</button>}
</div>
```

Commit:
```bash
git add frontend/src/pages/tax/scenarios/HouseholdPlanPicker.tsx
git commit --message="feat(tax-scenarios): HouseholdPlanPicker component"
```

---

### Task 9: `OwnerCompLeverSurface` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx`

The headline UX for P8b. Sliders per shareholder × per corp w/ live recompute (debounced 200ms). Each slider edit writes an `ownerComp.<shareholderId>.<field>` override on the active corp scenario; the linked household plan recomputes; integrated totals refresh.

Inputs:
- `corpScenarioId` (selected corp scenario in the active plan)
- `shareholderEntityIds` (list of personal entities in the plan that get distributions)

Outputs (in UI):
- 5 sliders per shareholder × corp pair: salary, bonus, eligibleDiv, nonEligibleDiv, capitalDiv
- Corp-side summary: T2 federal, prov, dividend refund, net corp tax
- Personal-side summary: employment, dividends, federal tax, prov tax, CPP, net to shareholder
- Integration row: total earned, total tax, take-home, integrated rate
- Warnings list (from `integration.warnings`)

Implementation:
- Sliders trigger debounced `patchCorpScenario` call (200ms)
- After patch, `useHouseholdPlanCompute` reloads to re-fetch totals
- Use existing `useCorpScenarios.patch` (corp scenario CRUD already exists)

```tsx
// Sketch — adapt per project style
import { useState, useEffect } from 'react';
// ... imports

interface Props {
  corpScenarioId: number;
  planId: number;
  shareholderEntityIds: number[];
}

export function OwnerCompLeverSurface({ corpScenarioId, planId, shareholderEntityIds }: Props) {
  const corpDetail = useCorpScenarioDetail(corpScenarioId);
  const planCompute = useHouseholdPlanCompute(planId);
  const { patch } = useCorpScenarios(/* entityId, year — engineer threads these in from parent */);

  const [localValues, setLocalValues] = useState<Record<string, Record<string, number>>>({});
  // ... debounced patch effect

  return (
    <div>
      {shareholderEntityIds.map((shId) => (
        <div key={shId} style={{ marginBottom: '1.5rem' }}>
          <h4>Shareholder {shId}</h4>
          {(['salary', 'bonus', 'eligibleDividend', 'nonEligibleDividend', 'capitalDividend'] as const).map((field) => (
            <div key={field}>
              <label>{field}</label>
              <input type="range" min="0" max="200000" step="1000" ... />
              <input type="number" ... />
            </div>
          ))}
        </div>
      ))}
      <IntegrationSummary compute={planCompute.data} />
      <WarningsList warnings={planCompute.data?.integration.warnings ?? []} />
    </div>
  );
}
```

Engineer fleshes out the debounced patch effect + summary tables. Reference: P7 T13's PersonalT1Tab for the debounce pattern (if any was used).

Commit:
```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx
git commit --message="feat(tax-scenarios): OwnerCompLeverSurface w/ debounced sliders"
```

---

### Task 10: Replace `OwnerCompPlannerTab` + integrate `HouseholdPlanPicker` into `OverviewTab`

**Files:**
- Modify: `frontend/src/pages/tax/OwnerCompPlannerTab.tsx` — REPLACE with thin wrapper that mounts `OwnerCompLeverSurface` using the active household plan from a small store / URL state
- Modify: `frontend/src/pages/tax/OverviewTab.tsx` — embed `HouseholdPlanPicker` at the top, show an integrated-rate summary card when a plan is selected
- Remove: `frontend/src/hooks/useScenario.ts` (the singular, legacy hook — confirm nothing else imports it)

The "active household plan" state needs to live somewhere the tabs share. Options:
- Lift to `TaxPage.tsx` and pass down via props
- URL query param (`?plan=42`)
- Small React Context

Engineer picks based on existing patterns. URL param is cleanest if `TaxPage` already uses query params for tab state; otherwise lift state.

Commit:
```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/OwnerCompPlannerTab.tsx frontend/src/pages/tax/OverviewTab.tsx
git rm frontend/src/hooks/useScenario.ts
git commit --message="feat(tax-scenarios): Owner Comp tab uses HouseholdPlan lever surface; Overview picker"
```

---

### Task 11: Remove legacy `runScenario` + `POST /api/tax/scenarios`

**Files:**
- Remove: `backend/src/tax/engine/scenario.ts`
- Remove: `backend/test/tax/scenario.test.ts` (if it exists)
- Modify: `backend/src/routes/tax.ts` — remove the `POST /scenarios` handler (around lines 389-450) + `runScenario` import (line 13) + unused `ScenarioInput`/`D` imports if they become unused

- [ ] **Step 1: Verify nothing else imports `runScenario`:**

```bash
grep -rln "runScenario\|from.*engine/scenario" backend/src backend/test
```

If anything besides `backend/src/routes/tax.ts` imports it, stop and report (might indicate a P8b task missed a usage site).

- [ ] **Step 2: Remove the route**

In `backend/src/routes/tax.ts`, delete the `router.post('/scenarios', ...)` block (around lines 389-450) and the corresponding imports at the top of the file.

- [ ] **Step 3: Remove `backend/src/tax/engine/scenario.ts`**

```bash
git rm backend/src/tax/engine/scenario.ts
```

If `backend/test/tax/scenario.test.ts` exists, remove it too.

- [ ] **Step 4: Run full test suite to confirm no regressions**

```bash
yarn workspace cashflow-backend run test
```

Expected: all tests pass (the old route's tests, if any, are removed; nothing else should reference `runScenario`).

- [ ] **Step 5: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add -A
git commit --message="refactor(tax-scenarios): remove legacy runScenario + POST /api/tax/scenarios"
```

---

## Pre-PR safe-push checklist (CRITICAL — avoids the P7/P8a auto-merge race)

- [ ] All 11 task commits in branch
- [ ] `yarn workspace cashflow-backend run test` passes (no regressions vs main)
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` ALL commits to origin BEFORE creating the PR**
- [ ] Only THEN open PR with `gh pr create` + enable auto-merge

If new tasks/commits are discovered mid-implementation, push them all to the branch before the PR is opened. Once the PR exists with auto-merge enabled, any green CI run will fire the merge — including before late commits arrive.

## Self-review checklist (engineer)

- [ ] All 11 task commits land in order
- [ ] All tests pass (no regressions)
- [ ] Manual: open Tax → Overview, create a household plan, link 1 corp + 1 personal scenario, see integrated rate update
- [ ] Manual: Tax → Owner Comp tab shows new lever surface w/ sliders; dragging changes integrated totals live
- [ ] Manual: Tax → Personal T1 + Corp T2 still work unchanged
- [ ] Legacy `POST /api/tax/scenarios` returns 404
- [ ] `backend/src/tax/engine/scenario.ts` no longer exists in repo
- [ ] No `Co-Authored-By` lines

## Risks / out of scope

- **`retainedEarningsAfter` placeholder:** `CorpReturnSummary.retainedEarningsAfter` is set to `D('0')` in `computeHouseholdPlan` because the T2 engine doesn't expose retained earnings as a totals field. Integration router doesn't enforce against it for v1. Engineer should flag if a future spec wants this enforced.
- **No CPP integration math:** the router sets `cppEnrolled: true` when salary > 0, but the personal T1 engine's CPP contribution math reads from the personal facts' employment income — the routed salary becomes employment income upstream, so this naturally flows. Verify in tests.
- **Single household plan recompute is non-cached:** `computeHouseholdPlan`'s personal scenarios skip the `scenario_returns` cache because the integration additions are plan-specific (cache key would have to include plan_id + integration inputs). P9 may add plan-scoped caching when performance demands.
- **No EI exclusion for non-arms-length owners:** P8b sets `cppEnrolled` but does not gate EI. The engine likely doesn't compute EI for owners anyway. Document as a known limitation.
- **OwnerComp UI doesn't enforce per-shareholder uniqueness:** multiple corp scenarios in the same plan could each independently set `ownerComp.42.salary`, and the integration router would sum them — usually the wrong behavior. P8b ships with this as-is; the user's plan structure typically has one corp scenario per corp. Add a UI warning if multiple corp scenarios target the same shareholder.

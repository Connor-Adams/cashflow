# Tax Scenario Engine (Phase P7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a branching, persistable scenario tree for personal-T1 tax planning. Each scenario layers sparse overrides on top of either actuals (baseline) or a parent scenario; computation walks the ancestry, applies overrides, runs the existing pure `buildT1` engine, and caches the result.

**Architecture:** Three new layers stacked on the existing engine. (1) Persistence: two tables (`scenarios`, `scenario_returns`) and two Sequelize models. (2) Resolver: pure functions that walk the parent chain, layer overrides via a typed registry, and call `buildT1` unchanged. (3) UI: scenario tree control + override editor + comparison view, plumbed into the existing Personal T1 tab. The legacy `/api/tax/scenarios` owner-comp endpoint (Phase 5) is left alone; new endpoints live at `/api/tax/personal-scenarios/*` and are consolidated in P8.

**Tech Stack:** TypeScript, Sequelize, Express, Node's built-in `node:test` runner, React + Vite. Decimal arithmetic via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) — section 4 (P7 row), section 5 (`scenarios`/`scenario_returns` tables, override key registry), section 6 (`resolveScenario`/`computeScenario` pseudocode), section 8.2 (scenario tree UI), section 8.3 (comparison view), section 9 (API surface). Multi-year projection + household plans are P8/P9 — out of scope here. Branch must be based on main with P6 already merged.

**Conventions from P6 plan** ([2026-05-25-tax-foundation-p6.md](2026-05-25-tax-foundation-p6.md)) apply unchanged:
- Test framework: `node:test`, `await sequelize.sync({ force: true })` in `beforeEach`, **import models BEFORE sync** (P6 lesson).
- Per-PID test DB isolation via `backend/test/setup.ts` (already shipped in P6).
- Decimal via `D` / `sumD` from `backend/src/tax/util/decimal`.
- Commit messages: conventional. `git commit --message=...` form (heredoc form blocked by harness).
- NEVER add `Co-Authored-By` trailers.
- Each task ends with a commit.

---

## File Structure

**Created (backend):**
- `backend/src/migrations/<ts>-scenarios.js` — `scenarios` table
- `backend/src/migrations/<ts>-scenario-returns.js` — `scenario_returns` cache table
- `backend/src/models/Scenario.ts` — Sequelize model
- `backend/src/models/ScenarioReturn.ts` — Sequelize model
- `backend/src/tax/scenarios/types.ts` — internal types (`ScenarioKind`, `OverrideMap`, `AssumptionsMap`)
- `backend/src/tax/scenarios/overrideKeys.ts` — typed registry of valid override keys + per-key apply fn
- `backend/src/tax/scenarios/applyOverrides.ts` — applies an `OverrideMap` to a `TaxYearFacts`
- `backend/src/tax/scenarios/resolveScenario.ts` — ancestry walk + baseline auto-create + override layering
- `backend/src/tax/scenarios/computeScenario.ts` — hash + cache + `buildT1` call
- `backend/src/routes/tax-personal-scenarios.ts` — CRUD + fork + compute + compare endpoints
- Tests for each module under `backend/test/tax/scenarios/` + `backend/test/tax/routes-personal-scenarios.test.ts`

**Modified (backend):**
- `backend/src/models/index.ts` — register Scenario + ScenarioReturn
- `backend/src/app.ts` — mount new router

**Created (frontend):**
- `frontend/src/hooks/useScenarios.ts` — list/get/create/patch/fork/delete + compute
- `frontend/src/hooks/useScenarioComparison.ts` — fetch N scenarios for side-by-side diff
- `frontend/src/pages/tax/scenarios/ScenarioTree.tsx` — left-rail tree control
- `frontend/src/pages/tax/scenarios/OverrideEditor.tsx` — typed input panel
- `frontend/src/pages/tax/scenarios/ComparisonView.tsx` — N-column diff grid

**Modified (frontend):**
- `frontend/src/pages/tax/PersonalT1Tab.tsx` — embed scenario tree + selected-scenario view + comparison launcher

---

## Endpoint surface (new — all under `/api/tax/personal-scenarios`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tax/personal-scenarios` | Create scenario (baseline auto-created on first reference of entity+year) |
| GET | `/api/tax/personal-scenarios?entityId=&year=` | List scenarios for entity+year |
| GET | `/api/tax/personal-scenarios/:id` | Get scenario + computed return |
| PATCH | `/api/tax/personal-scenarios/:id` | Update overrides/name/notes |
| POST | `/api/tax/personal-scenarios/:id/fork` | Create child scenario inheriting overrides |
| DELETE | `/api/tax/personal-scenarios/:id` | Delete (baseline cannot delete; restricted if has children) |
| POST | `/api/tax/personal-scenarios/:id/compute` | Force recompute (bypass cache) |
| GET | `/api/tax/personal-scenarios/compare?ids=id1,id2,...` | Diff payload for N scenarios |

---

## Task plan

### Task 1: Scenarios + ScenarioReturns migrations + models

**Files:**
- Create: `backend/src/migrations/<YYYYMMDDHHMMSS>-scenarios.js`
- Create: `backend/src/migrations/<YYYYMMDDHHMMSS>-scenario-returns.js`
- Create: `backend/src/models/Scenario.ts`
- Create: `backend/src/models/ScenarioReturn.ts`
- Modify: `backend/src/models/index.ts` (register + export)
- Create: `backend/test/tax/scenarios/models.test.ts`

- [ ] **Step 1: Generate migration timestamps**

```bash
node -e "console.log(new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14))"
```

Use the output as the prefix for both migration filenames, incrementing the seconds by 1 for the second file.

- [ ] **Step 2: Write `scenarios` migration**

```js
// backend/src/migrations/<ts>-scenarios.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('scenarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      parent_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'scenarios', key: 'id' }, onDelete: 'RESTRICT' },
      entity_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'tax_entities', key: 'id' }, onDelete: 'CASCADE' },
      year: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      kind: { type: Sequelize.STRING(20), allowNull: false }, // 'baseline' | 'fork' | 'projection_root'
      overrides: { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
      assumptions: { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
      next_year_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'scenarios', key: 'id' }, onDelete: 'SET NULL' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('scenarios', ['parent_id']);
    await queryInterface.addIndex('scenarios', ['entity_id', 'year']);
    await queryInterface.addConstraint('scenarios', {
      fields: ['entity_id', 'year', 'name'],
      type: 'unique',
      name: 'scenarios_entity_year_name_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('scenarios');
  },
};
```

- [ ] **Step 3: Write `scenario_returns` migration**

```js
// backend/src/migrations/<ts>-scenario-returns.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('scenario_returns', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      scenario_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'scenarios', key: 'id' }, onDelete: 'CASCADE' },
      facts_hash: { type: Sequelize.STRING(64), allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      lines: { type: Sequelize.JSON, allowNull: false },
      totals: { type: Sequelize.JSON, allowNull: false },
      warnings: { type: Sequelize.JSON, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addConstraint('scenario_returns', {
      fields: ['scenario_id', 'facts_hash'],
      type: 'unique',
      name: 'scenario_returns_scenario_hash_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('scenario_returns');
  },
};
```

- [ ] **Step 4: Write `Scenario.ts` model**

```ts
// backend/src/models/Scenario.ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

export class Scenario extends Model<
  InferAttributes<Scenario>, InferCreationAttributes<Scenario>
> {
  declare id: CreationOptional<number>;
  declare parentId: number | null;
  declare entityId: number;
  declare year: number;
  declare name: string;
  declare kind: ScenarioKind;
  declare overrides: Record<string, unknown>;
  declare assumptions: Record<string, unknown>;
  declare nextYearId: number | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initScenario(sequelize: Sequelize): typeof Scenario {
  Scenario.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      parentId: { type: DataTypes.INTEGER, field: 'parent_id', allowNull: true },
      entityId: { type: DataTypes.INTEGER, field: 'entity_id', allowNull: false },
      year: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      overrides: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      assumptions: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      nextYearId: { type: DataTypes.INTEGER, field: 'next_year_id', allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<Scenario>,
    { sequelize, modelName: 'Scenario', tableName: 'scenarios', underscored: true, timestamps: true }
  );
  return Scenario;
}
```

- [ ] **Step 5: Write `ScenarioReturn.ts` model**

```ts
// backend/src/models/ScenarioReturn.ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export class ScenarioReturn extends Model<
  InferAttributes<ScenarioReturn>, InferCreationAttributes<ScenarioReturn>
> {
  declare id: CreationOptional<number>;
  declare scenarioId: number;
  declare factsHash: string;
  declare computedAt: Date;
  declare lines: unknown[];
  declare totals: Record<string, unknown>;
  declare warnings: string[];
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initScenarioReturn(sequelize: Sequelize): typeof ScenarioReturn {
  ScenarioReturn.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      scenarioId: { type: DataTypes.INTEGER, field: 'scenario_id', allowNull: false },
      factsHash: { type: DataTypes.STRING(64), field: 'facts_hash', allowNull: false },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
      lines: { type: DataTypes.JSON, allowNull: false },
      totals: { type: DataTypes.JSON, allowNull: false },
      warnings: { type: DataTypes.JSON, allowNull: false },
    } as ModelAttributes<ScenarioReturn>,
    { sequelize, modelName: 'ScenarioReturn', tableName: 'scenario_returns', underscored: true, timestamps: true }
  );
  return ScenarioReturn;
}
```

- [ ] **Step 6: Register the models in `backend/src/models/index.ts`**

Add the imports + init calls in the same pattern as existing models (look at how `Scenario` slots into the existing init list). Add to the exports.

- [ ] **Step 7: Write the model integration test**

```ts
// backend/test/tax/scenarios/models.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Entity, Household, Scenario, ScenarioReturn } from '../../../src/models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('creates and reads back a Scenario with overrides + assumptions JSON', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025,
    name: 'Baseline', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const reloaded = await Scenario.findByPk(scenario.id);
  assert.equal(reloaded?.name, 'Baseline');
  assert.deepEqual(reloaded?.overrides, {});
});

test('unique constraint on (entity_id, year, name)', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025, name: 'Plan A', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() =>
    Scenario.create({
      parentId: null, entityId: entity.id, year: 2025, name: 'Plan A', kind: 'fork',
      overrides: {}, assumptions: {}, nextYearId: null, notes: null,
    }),
  );
});

test('cascade delete: deleting Scenario removes its ScenarioReturn cache rows', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025, name: 'Baseline', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await ScenarioReturn.create({
    scenarioId: scenario.id, factsHash: 'abc', computedAt: new Date(),
    lines: [], totals: {}, warnings: [],
  });
  await scenario.destroy();
  const remaining = await ScenarioReturn.findAll();
  assert.equal(remaining.length, 0);
});
```

- [ ] **Step 8: Run the test to verify it passes** (sync creates the tables; migrations run only via sequelize-cli)

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/models.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/migrations/*scenarios.js backend/src/migrations/*scenario-returns.js \
  backend/src/models/Scenario.ts backend/src/models/ScenarioReturn.ts \
  backend/src/models/index.ts backend/test/tax/scenarios/models.test.ts
git commit --message="feat(tax-scenarios): add Scenario + ScenarioReturn models and migrations"
```

---

### Task 2: Override key registry

**Files:**
- Create: `backend/src/tax/scenarios/types.ts`
- Create: `backend/src/tax/scenarios/overrideKeys.ts`
- Create: `backend/test/tax/scenarios/overrideKeys.test.ts`

The registry is the single source of truth for which override keys are valid, how each one is parsed, and how each one mutates the facts struct. Adding a new key = adding one entry. P7 covers the personal-side keys only; corp + ownerComp keys land in P8.

- [ ] **Step 1: Write `types.ts`**

```ts
// backend/src/tax/scenarios/types.ts
import type { TaxYearFacts } from '../engine/types';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

/** Sparse map of override key → raw JSON-serialisable value. */
export type OverrideMap = Record<string, unknown>;

export type AssumptionsMap = Record<string, unknown>;

/** Mutator: receives the current facts struct, returns a new one with the override applied. */
export type OverrideApplier = (facts: TaxYearFacts, value: unknown) => TaxYearFacts;

/** Registry entry describing one valid override key. */
export interface OverrideKeyDef {
  /** Dotted key, e.g. "income.employment". */
  key: string;
  /** Human-readable label for UI. */
  label: string;
  /** Runtime check that `value` matches expected shape; throws on mismatch. */
  validate: (value: unknown) => void;
  /** Applies the override to a facts struct. Pure: returns new facts, does not mutate. */
  apply: OverrideApplier;
  /** Optional UI input hint for the editor (number, decimal, array, etc.). */
  inputType: 'decimal' | 'integer' | 'array_capgain_dispositions';
}
```

- [ ] **Step 2: Write the failing test for the registry**

```ts
// backend/test/tax/scenarios/overrideKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import {
  overrideKeyRegistry, getOverrideKey, validateOverrideMap,
} from '../../../src/tax/scenarios/overrideKeys';
import type { TaxYearFacts } from '../../../src/tax/engine/types';

function emptyFacts(): TaxYearFacts {
  return {
    year: 2025, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    slips: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0') },
    ageAtYearEnd: 40,
  };
}

test('registry contains expected P7 personal keys', () => {
  const keys = overrideKeyRegistry.map((k) => k.key);
  assert.ok(keys.includes('income.employment'));
  assert.ok(keys.includes('income.eligibleDividends'));
  assert.ok(keys.includes('income.nonEligibleDividends'));
  assert.ok(keys.includes('income.interest'));
  assert.ok(keys.includes('deductions.rrspContrib'));
  assert.ok(keys.includes('deductions.fhsaContrib'));
  assert.ok(keys.includes('deductions.donations'));
  assert.ok(keys.includes('capgains.dispositions'));
});

test('getOverrideKey returns the entry for a known key', () => {
  const entry = getOverrideKey('income.employment');
  assert.equal(entry?.label, 'Employment income (CAD)');
});

test('getOverrideKey returns undefined for an unknown key', () => {
  assert.equal(getOverrideKey('not.a.real.key'), undefined);
});

test('validateOverrideMap throws on unknown key', () => {
  assert.throws(
    () => validateOverrideMap({ 'totally.fake': 1 }),
    /unknown override key/i,
  );
});

test('validateOverrideMap throws when value fails per-key validator', () => {
  assert.throws(
    () => validateOverrideMap({ 'income.employment': 'not a number' }),
    /income.employment/,
  );
});

test('apply: income.employment replaces aggregated employment income', () => {
  const entry = getOverrideKey('income.employment')!;
  entry.validate(95000);
  const facts = entry.apply(emptyFacts(), 95000);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '95000.00');
  assert.equal(facts.employmentIncome[0].source, 'override:income.employment');
});

test('apply: capgains.dispositions appends events to capitalGainEvents', () => {
  const entry = getOverrideKey('capgains.dispositions')!;
  const dispositions = [
    { proceeds: 100000, acb: 60000, date: '2025-03-15' },
    { proceeds: 50000, acb: 40000, date: '2025-09-01' },
  ];
  entry.validate(dispositions);
  const facts = entry.apply(emptyFacts(), dispositions);
  assert.equal(facts.capitalGainEvents.length, 2);
  assert.equal(facts.capitalGainEvents[0].proceeds.toFixed(2), '100000.00');
  assert.equal(facts.capitalGainEvents[1].acb.toFixed(2), '40000.00');
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/overrideKeys.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 4: Implement `overrideKeys.ts`**

```ts
// backend/src/tax/scenarios/overrideKeys.ts
import { D } from '../util/decimal';
import type { CapGainEvent, IncomeItem, RrspContrib, TaxYearFacts } from '../engine/types';
import type { OverrideKeyDef, OverrideMap } from './types';

function assertNumber(value: unknown, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key}: expected a finite number, got ${typeof value}`);
  }
}

function singletonIncome(source: string, amount: number): IncomeItem {
  const cad = D(String(amount));
  return { source, amount: cad, cadAmount: cad };
}

function replaceIncomeArray(arrayName: keyof Pick<
  TaxYearFacts,
  'employmentIncome' | 'eligibleDividends' | 'nonEligibleDividends' | 'interestIncome'
>, label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    return { ...facts, [arrayName]: [singletonIncome(`override:${label}`, value)] };
  };
}

function singletonRrsp(source: string, amount: number): RrspContrib {
  return { source, amount: D(String(amount)), date: '' };
}

export const overrideKeyRegistry: OverrideKeyDef[] = [
  {
    key: 'income.employment',
    label: 'Employment income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.employment'),
    apply: replaceIncomeArray('employmentIncome', 'income.employment'),
  },
  {
    key: 'income.eligibleDividends',
    label: 'Eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.eligibleDividends'),
    apply: replaceIncomeArray('eligibleDividends', 'income.eligibleDividends'),
  },
  {
    key: 'income.nonEligibleDividends',
    label: 'Non-eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.nonEligibleDividends'),
    apply: replaceIncomeArray('nonEligibleDividends', 'income.nonEligibleDividends'),
  },
  {
    key: 'income.interest',
    label: 'Interest income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.interest'),
    apply: replaceIncomeArray('interestIncome', 'income.interest'),
  },
  {
    key: 'deductions.rrspContrib',
    label: 'RRSP contribution (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.rrspContrib'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.rrspContrib');
      return { ...facts, rrspContribs: [singletonRrsp('override:deductions.rrspContrib', value)] };
    },
  },
  {
    key: 'deductions.fhsaContrib',
    label: 'FHSA contribution (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.fhsaContrib'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.fhsaContrib');
      return { ...facts, fhsaContribs: [singletonRrsp('override:deductions.fhsaContrib', value)] };
    },
  },
  {
    key: 'deductions.donations',
    label: 'Donations (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.donations'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.donations');
      return { ...facts, donations: [singletonIncome('override:deductions.donations', value)] };
    },
  },
  {
    key: 'capgains.dispositions',
    label: 'Capital gain dispositions',
    inputType: 'array_capgain_dispositions',
    validate: (v) => {
      if (!Array.isArray(v)) throw new Error('capgains.dispositions: expected array');
      for (const d of v) {
        if (typeof d !== 'object' || d === null) throw new Error('capgains.dispositions: each item must be object');
        const row = d as Record<string, unknown>;
        assertNumber(row.proceeds, 'capgains.dispositions[].proceeds');
        assertNumber(row.acb, 'capgains.dispositions[].acb');
        if (typeof row.date !== 'string') throw new Error('capgains.dispositions[].date: expected string');
      }
    },
    apply: (facts, value) => {
      const events: CapGainEvent[] = (value as Array<{ proceeds: number; acb: number; date: string }>).map(
        (row, i) => ({
          source: `override:capgains.dispositions[${i}]`,
          securityId: null as unknown as number, // overrides bypass security linkage
          proceeds: D(String(row.proceeds)),
          acb: D(String(row.acb)),
          outlays: D('0'),
          date: row.date,
        }),
      );
      return { ...facts, capitalGainEvents: [...facts.capitalGainEvents, ...events] };
    },
  },
];

const indexByKey = new Map(overrideKeyRegistry.map((k) => [k.key, k]));

export function getOverrideKey(key: string): OverrideKeyDef | undefined {
  return indexByKey.get(key);
}

/**
 * Validates a complete override map: rejects unknown keys, runs per-key validators.
 * Throws on any failure with a message identifying the offending key.
 */
export function validateOverrideMap(map: OverrideMap): void {
  for (const [key, value] of Object.entries(map)) {
    const entry = indexByKey.get(key);
    if (!entry) throw new Error(`unknown override key: ${key}`);
    entry.validate(value);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/overrideKeys.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/types.ts backend/src/tax/scenarios/overrideKeys.ts backend/test/tax/scenarios/overrideKeys.test.ts
git commit --message="feat(tax-scenarios): typed override key registry with validators"
```

---

### Task 3: `applyOverrides` function

**Files:**
- Create: `backend/src/tax/scenarios/applyOverrides.ts`
- Create: `backend/test/tax/scenarios/applyOverrides.test.ts`

Layers a chain of override maps onto a facts struct. Each map is applied in order; later overrides win for keys that replace, accumulate for keys that append (like `capgains.dispositions`).

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/applyOverrides.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import { applyOverrides } from '../../../src/tax/scenarios/applyOverrides';
import type { TaxYearFacts } from '../../../src/tax/engine/types';

function emptyFacts(): TaxYearFacts {
  return {
    year: 2025, jurisdiction: 'CA-ON',
    employmentIncome: [], selfEmploymentIncome: [], selfEmploymentExpenses: [],
    interestIncome: [], eligibleDividends: [], nonEligibleDividends: [],
    capitalGainEvents: [], rrspContribs: [], fhsaContribs: [], donations: [],
    slips: [],
    carryforwards: { netCapitalLoss: D('0'), rrspRoom: D('0'), nonCapLoss: D('0'), instalmentsPaid: D('0') },
    ageAtYearEnd: 40,
  };
}

test('empty override map returns input unchanged (referentially identical not required)', () => {
  const facts = emptyFacts();
  const result = applyOverrides(facts, [{}]);
  assert.deepEqual(result.employmentIncome, []);
  assert.equal(result.year, 2025);
});

test('single override replaces employment income', () => {
  const result = applyOverrides(emptyFacts(), [{ 'income.employment': 95000 }]);
  assert.equal(result.employmentIncome.length, 1);
  assert.equal(result.employmentIncome[0].cadAmount.toFixed(2), '95000.00');
});

test('later override wins for replace-style keys', () => {
  const result = applyOverrides(emptyFacts(), [
    { 'income.employment': 95000 },
    { 'income.employment': 120000 },
  ]);
  assert.equal(result.employmentIncome.length, 1);
  assert.equal(result.employmentIncome[0].cadAmount.toFixed(2), '120000.00');
});

test('append-style keys accumulate across maps', () => {
  const result = applyOverrides(emptyFacts(), [
    { 'capgains.dispositions': [{ proceeds: 100000, acb: 60000, date: '2025-03-15' }] },
    { 'capgains.dispositions': [{ proceeds: 50000, acb: 40000, date: '2025-09-01' }] },
  ]);
  assert.equal(result.capitalGainEvents.length, 2);
});

test('unknown key in a map throws', () => {
  assert.throws(
    () => applyOverrides(emptyFacts(), [{ 'totally.fake': 1 }]),
    /unknown override key/i,
  );
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/applyOverrides.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `applyOverrides`**

```ts
// backend/src/tax/scenarios/applyOverrides.ts
import { getOverrideKey, validateOverrideMap } from './overrideKeys';
import type { OverrideMap } from './types';
import type { TaxYearFacts } from '../engine/types';

/**
 * Layers a chain of override maps onto a starting facts struct. Maps are applied
 * in order: layer N's overrides are applied to the result of layer N-1.
 *
 * Each override key's behavior (replace vs append) is determined by its registry
 * entry's `apply` function. The function is pure — returns a new facts struct,
 * does not mutate the input.
 *
 * Throws on any unknown key or value that fails its per-key validator.
 */
export function applyOverrides(
  baseFacts: TaxYearFacts,
  overrideChain: OverrideMap[],
): TaxYearFacts {
  let facts = baseFacts;
  for (const map of overrideChain) {
    validateOverrideMap(map);
    for (const [key, value] of Object.entries(map)) {
      const entry = getOverrideKey(key)!; // validated above
      facts = entry.apply(facts, value);
    }
  }
  return facts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/applyOverrides.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/applyOverrides.ts backend/test/tax/scenarios/applyOverrides.test.ts
git commit --message="feat(tax-scenarios): applyOverrides layers override chain onto facts"
```

---

### Task 4: `resolveScenario` function

**Files:**
- Create: `backend/src/tax/scenarios/resolveScenario.ts`
- Create: `backend/test/tax/scenarios/resolveScenario.test.ts`

Walks parent chain → builds baseline facts (auto-creates baseline scenario if missing) → applies override chain → returns final facts.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/resolveScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { resolveScenario, ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '80000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('ensureBaselineScenario creates a baseline row on first call, returns existing on second', async () => {
  const { entity } = await seedEntity();
  const first = await ensureBaselineScenario(entity.id, 2025);
  assert.equal(first.kind, 'baseline');
  assert.equal(first.name, 'Baseline');

  const second = await ensureBaselineScenario(entity.id, 2025);
  assert.equal(second.id, first.id);
  assert.equal((await Scenario.count()), 1);
});

test('resolveScenario(baseline) returns facts built from actuals', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const facts = await resolveScenario(baseline.id);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '80000.00');
});

test('resolveScenario(fork) layers override on top of baseline actuals', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'High salary', kind: 'fork',
    overrides: { 'income.employment': 120000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork.id);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '120000.00');
});

test('resolveScenario walks multi-level ancestry (baseline → fork1 → fork2)', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork1 = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'L1', kind: 'fork',
    overrides: { 'income.employment': 90000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const fork2 = await Scenario.create({
    parentId: fork1.id, entityId: entity.id, year: 2025,
    name: 'L2', kind: 'fork',
    overrides: { 'deductions.rrspContrib': 25000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork2.id);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '90000.00');
  assert.equal(facts.rrspContribs.length, 1);
  assert.equal(facts.rrspContribs[0].amount.toFixed(2), '25000.00');
});

test('resolveScenario throws on cyclic ancestry', async () => {
  // Build a cycle: a -> b -> a (only possible via raw update bypassing our APIs).
  const { entity } = await seedEntity();
  const a = await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025, name: 'A', kind: 'fork',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const b = await Scenario.create({
    parentId: a.id, entityId: entity.id, year: 2025, name: 'B', kind: 'fork',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await a.update({ parentId: b.id });
  await assert.rejects(() => resolveScenario(a.id), /cycle/i);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/resolveScenario.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `resolveScenario.ts`**

```ts
// backend/src/tax/scenarios/resolveScenario.ts
import { Scenario } from '../../models';
import { buildPersonalFacts } from '../builders/buildPersonalFacts';
import { applyOverrides } from './applyOverrides';
import type { OverrideMap } from './types';
import type { TaxYearFacts } from '../engine/types';

const MAX_ANCESTRY_DEPTH = 16;

/**
 * Find or create the baseline scenario for (entityId, year). Baselines are
 * system-generated, always named "Baseline", parentId=null, no overrides.
 */
export async function ensureBaselineScenario(
  entityId: number,
  year: number,
): Promise<Scenario> {
  const existing = await Scenario.findOne({
    where: { entityId, year, kind: 'baseline' },
  });
  if (existing) return existing;
  return Scenario.create({
    parentId: null,
    entityId,
    year,
    name: 'Baseline',
    kind: 'baseline',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });
}

/**
 * Resolve a scenario into final `TaxYearFacts` by walking the parent chain
 * from root to leaf, layering each node's override map onto the actuals.
 *
 * Throws if the ancestry exceeds `MAX_ANCESTRY_DEPTH` (cycle detection) or
 * if any scenario in the chain references an unknown override key.
 */
export async function resolveScenario(scenarioId: number): Promise<TaxYearFacts> {
  const ancestry = await loadAncestry(scenarioId);
  const root = ancestry[0];
  const baseFacts = await buildPersonalFacts(root.entityId, root.year);
  const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
  return applyOverrides(baseFacts, overrideChain);
}

/** Walk parentId chain from given scenario back to root. Returns root-first array. */
async function loadAncestry(leafId: number): Promise<Scenario[]> {
  const reverse: Scenario[] = [];
  const seen = new Set<number>();
  let currentId: number | null = leafId;
  while (currentId !== null) {
    if (seen.has(currentId)) {
      throw new Error(`scenario ancestry cycle detected at id=${currentId}`);
    }
    seen.add(currentId);
    if (reverse.length >= MAX_ANCESTRY_DEPTH) {
      throw new Error(`scenario ancestry exceeds max depth ${MAX_ANCESTRY_DEPTH}`);
    }
    const node: Scenario | null = await Scenario.findByPk(currentId);
    if (!node) throw new Error(`scenario id=${currentId} not found while walking ancestry`);
    reverse.push(node);
    currentId = node.parentId;
  }
  return reverse.reverse(); // root-first
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/resolveScenario.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/resolveScenario.ts backend/test/tax/scenarios/resolveScenario.test.ts
git commit --message="feat(tax-scenarios): resolveScenario walks ancestry and layers overrides"
```

---

### Task 5: `computeScenario` function (cache + engine call)

**Files:**
- Create: `backend/src/tax/scenarios/computeScenario.ts`
- Create: `backend/test/tax/scenarios/computeScenario.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/computeScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, ScenarioReturn, Transaction,
} from '../../../src/models';
import { computeScenario } from '../../../src/tax/scenarios/computeScenario';
import { ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '80000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('computeScenario returns a TaxReturn shape with lines + totals + warnings', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const result = await computeScenario(baseline.id);
  assert.ok(Array.isArray(result.lines));
  assert.ok('totalPayable' in result.totals);
  assert.ok(Array.isArray(result.warnings));
});

test('computeScenario writes a ScenarioReturn cache row on first call', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  await computeScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
});

test('computeScenario reuses cache on second call with same inputs', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const r1 = await computeScenario(baseline.id);
  const r2 = await computeScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
  assert.equal(r1.totals.totalPayable, r2.totals.totalPayable);
});

test('computeScenario recomputes when overrides change (different facts_hash)', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'F', kind: 'fork',
    overrides: { 'income.employment': 120000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  await computeScenario(fork.id);
  await fork.update({ overrides: { 'income.employment': 150000 } });
  await computeScenario(fork.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: fork.id } });
  assert.equal(cached.length, 2); // two distinct facts_hash rows
});

test('computeScenario({ force: true }) bypasses cache and writes a new row', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  await computeScenario(baseline.id);
  await computeScenario(baseline.id, { force: true });
  // Even if hash matches, the force path writes a fresh row.
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.ok(cached.length >= 1);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/computeScenario.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `computeScenario.ts`**

```ts
// backend/src/tax/scenarios/computeScenario.ts
import crypto from 'node:crypto';
import { Scenario, ScenarioReturn } from '../../models';
import { resolveScenario } from './resolveScenario';
import { ratesFor } from '../engine/brackets';
import { buildT1 } from '../engine/t1';
import type { TaxYearFacts } from '../engine/types';

export interface ComputeScenarioOptions {
  /** If true, skip the cache check and always re-run the engine. */
  force?: boolean;
}

export interface ComputeScenarioResult {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, unknown>;
  warnings: string[];
  cached: boolean;
}

/**
 * Compute a scenario's tax return: resolve facts → hash → check cache → run
 * engine on miss → persist new cache row. Returns the result either from
 * cache or freshly computed.
 */
export async function computeScenario(
  scenarioId: number,
  options: ComputeScenarioOptions = {},
): Promise<ComputeScenarioResult> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);

  const facts = await resolveScenario(scenarioId);
  const factsHash = hashFacts(facts);

  if (!options.force) {
    const cached = await ScenarioReturn.findOne({
      where: { scenarioId, factsHash },
    });
    if (cached) {
      return {
        scenarioId,
        factsHash,
        computedAt: cached.computedAt.toISOString(),
        lines: cached.lines as unknown[],
        totals: cached.totals as Record<string, unknown>,
        warnings: cached.warnings as string[],
        cached: true,
      };
    }
  }

  const engineReturn = buildT1(facts, ratesFor(facts.year));
  // Serialise Decimal → string so the cache row is JSON-safe round-trip.
  const lines = JSON.parse(JSON.stringify(engineReturn.lines));
  const totals = JSON.parse(JSON.stringify(engineReturn.totals));
  const warnings = engineReturn.warnings;

  const row = await ScenarioReturn.create({
    scenarioId,
    factsHash,
    computedAt: new Date(),
    lines,
    totals,
    warnings,
  });

  return {
    scenarioId,
    factsHash,
    computedAt: row.computedAt.toISOString(),
    lines,
    totals,
    warnings,
    cached: false,
  };
}

/**
 * Canonical hash of a facts struct + rate-table year. Identical inputs always
 * produce the same hash. JSON.stringify with sorted keys keeps Decimal values
 * (which serialise as objects) stable.
 */
function hashFacts(facts: TaxYearFacts): string {
  const canonical = JSON.stringify(facts, replacer);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function replacer(_key: string, value: unknown): unknown {
  // Decimal instances expose toString() that gives stable representation
  if (value && typeof value === 'object' && 'toFixed' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  return value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/computeScenario.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/computeScenario.ts backend/test/tax/scenarios/computeScenario.test.ts
git commit --message="feat(tax-scenarios): computeScenario with facts-hash cache"
```

---

### Task 6: API CRUD routes

**Files:**
- Create: `backend/src/routes/tax-personal-scenarios.ts`
- Modify: `backend/src/app.ts` (mount router)
- Create: `backend/test/tax/routes-personal-scenarios.test.ts`

- [ ] **Step 1: Write the failing route test (CRUD endpoints only — fork/compute/compare in Task 7)**

Follow the auth-helper pattern established in `backend/test/tax/routes-reconciliation.test.ts` — direct User + Household + HouseholdMember + Session creation, then `request.agent(app)` with cookie injection. **Import models BEFORE sync.**

```ts
// backend/test/tax/routes-personal-scenarios.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let entityId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../src/db.js');
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });
  const mod = await import('../../src/app.js');
  app = mod.default;
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `scenarios-${Date.now()}@example.com`,
    displayName: 'Scenarios Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Scenarios HH' });
  await models.HouseholdMember.create({
    householdId: household.id, userId: user.id, role: 'owner',
  });
  const entity = await models.Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  entityId = entity.id;

  // Seed one txn so baseline has employment income.
  const account = await models.Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  });
  await models.Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '80000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  });

  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id, tokenHash: await hashToken(token),
    expiresAt: new Date(Date.now() + 86400_000),
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../../src/db.js');
  await sequelize.close();
});

test('GET /api/tax/personal-scenarios without auth returns 401', async () => {
  const res = await request(app).get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 401);
});

test('POST /api/tax/personal-scenarios creates a fork', async () => {
  const res = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'High salary',
    overrides: { 'income.employment': 120000 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scenario.name, 'High salary');
  assert.equal(res.body.scenario.kind, 'fork');
  assert.ok(typeof res.body.scenario.parentId === 'number'); // baseline auto-created
});

test('GET /api/tax/personal-scenarios lists scenarios for entity+year', async () => {
  const res = await authed.get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 200);
  // Baseline + the fork from previous test → 2 scenarios
  assert.ok(res.body.scenarios.length >= 2);
});

test('GET /api/tax/personal-scenarios/:id returns scenario + computed return', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'For-get-test',
    overrides: { 'income.employment': 60000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.get(`/api/tax/personal-scenarios/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.scenario.id, id);
  assert.ok(res.body.computed);
  assert.ok('totalPayable' in res.body.computed.totals);
});

test('PATCH /api/tax/personal-scenarios/:id updates overrides', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'PatchMe',
    overrides: { 'income.employment': 50000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.patch(`/api/tax/personal-scenarios/${id}`).send({
    overrides: { 'income.employment': 75000 },
    notes: 'updated',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.scenario.overrides['income.employment'], 75000);
  assert.equal(res.body.scenario.notes, 'updated');
});

test('PATCH with invalid override key returns 400', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'InvalidPatch', overrides: {},
  });
  const res = await authed.patch(`/api/tax/personal-scenarios/${create.body.scenario.id}`).send({
    overrides: { 'totally.fake': 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /unknown override key/i);
});

test('DELETE /api/tax/personal-scenarios/:id removes a fork', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'DeleteMe', overrides: {},
  });
  const id = create.body.scenario.id;
  const del = await authed.delete(`/api/tax/personal-scenarios/${id}`);
  assert.equal(del.status, 204);
  const get = await authed.get(`/api/tax/personal-scenarios/${id}`);
  assert.equal(get.status, 404);
});

test('DELETE baseline is forbidden (409)', async () => {
  // Trigger baseline auto-create first
  await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'EnsureBaseline', overrides: {},
  });
  const list = await authed.get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  const baseline = list.body.scenarios.find((s: { kind: string }) => s.kind === 'baseline');
  assert.ok(baseline);
  const res = await authed.delete(`/api/tax/personal-scenarios/${baseline.id}`);
  assert.equal(res.status, 409);
});

test('DELETE scenario with children is forbidden (409)', async () => {
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'Parent', overrides: {},
  });
  const fork = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'ParentChild',
    parentId: parent.body.scenario.id, overrides: {},
  });
  const del = await authed.delete(`/api/tax/personal-scenarios/${parent.body.scenario.id}`);
  assert.equal(del.status, 409);
  // Cleanup
  await authed.delete(`/api/tax/personal-scenarios/${fork.body.scenario.id}`);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-personal-scenarios.test.ts
```

Expected: FAIL — route + module not yet implemented.

- [ ] **Step 3: Implement `backend/src/routes/tax-personal-scenarios.ts`**

```ts
// backend/src/routes/tax-personal-scenarios.ts
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';
import { validateOverrideMap } from '../tax/scenarios/overrideKeys';
import { ensureBaselineScenario } from '../tax/scenarios/resolveScenario';
import { computeScenario } from '../tax/scenarios/computeScenario';

const router = Router();

// Helper: resolve scenario ID + ensure caller's household owns the underlying entity.
async function loadAndAuthorize(req: import('express').Request, scenarioId: number) {
  const { household } = currentAuth(req);
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) return { error: 'not_found' as const };
  const entity = await Entity.findByPk(scenario.entityId);
  if (!entity || entity.householdId !== household.id) {
    return { error: 'forbidden' as const };
  }
  return { scenario, entity };
}

// POST /api/tax/personal-scenarios — create scenario (baseline auto-created on first reference)
router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { entityId, year, name, overrides = {}, assumptions = {}, parentId = null, notes = null } = req.body ?? {};

    if (!Number.isInteger(entityId) || !Number.isInteger(year) || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'invalid_body', message: 'entityId (int), year (int), name (non-empty string) required' });
      return;
    }
    const entity = await Entity.findByPk(entityId);
    if (!entity || entity.householdId !== household.id) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    try {
      validateOverrideMap(overrides);
    } catch (err) {
      res.status(400).json({ error: 'invalid_overrides', message: (err as Error).message });
      return;
    }
    // Auto-create baseline if not yet present. New scenario is a fork of baseline unless an explicit parentId was given.
    const baseline = await ensureBaselineScenario(entityId, year);
    const effectiveParentId = parentId ?? baseline.id;
    const scenario = await Scenario.create({
      parentId: effectiveParentId,
      entityId,
      year,
      name,
      kind: 'fork',
      overrides,
      assumptions,
      nextYearId: null,
      notes,
    });
    res.status(201).json({ scenario });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal-scenarios?entityId=&year=
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.query.entityId);
    const year = Number(req.query.year);
    if (!Number.isInteger(entityId) || !Number.isInteger(year)) {
      res.status(400).json({ error: 'invalid_query', message: 'entityId and year query params required' });
      return;
    }
    const entity = await Entity.findByPk(entityId);
    if (!entity || entity.householdId !== household.id) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    const scenarios = await Scenario.findAll({ where: { entityId, year }, order: [['createdAt', 'ASC']] });
    res.json({ scenarios });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal-scenarios/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const computed = await computeScenario(result.scenario.id);
    res.json({ scenario: result.scenario, computed });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tax/personal-scenarios/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const updates: Partial<{ name: string; notes: string | null; overrides: Record<string, unknown>; assumptions: Record<string, unknown> }> = {};
    if ('name' in req.body) updates.name = String(req.body.name);
    if ('notes' in req.body) updates.notes = req.body.notes === null ? null : String(req.body.notes);
    if ('overrides' in req.body) {
      try {
        validateOverrideMap(req.body.overrides);
      } catch (err) {
        res.status(400).json({ error: 'invalid_overrides', message: (err as Error).message });
        return;
      }
      updates.overrides = req.body.overrides;
    }
    if ('assumptions' in req.body) updates.assumptions = req.body.assumptions;
    await result.scenario.update(updates);
    res.json({ scenario: result.scenario });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tax/personal-scenarios/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    if (result.scenario.kind === 'baseline') {
      res.status(409).json({ error: 'baseline_cannot_be_deleted' });
      return;
    }
    const childCount = await Scenario.count({ where: { parentId: result.scenario.id } });
    if (childCount > 0) {
      res.status(409).json({ error: 'has_children', message: `Cannot delete scenario with ${childCount} descendant(s).` });
      return;
    }
    await result.scenario.destroy();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router in `backend/src/app.ts`**

Find where other tax routes are mounted (likely `app.use('/api/tax', taxRouter)`) and add:

```ts
import personalScenariosRouter from './routes/tax-personal-scenarios';
app.use('/api/tax/personal-scenarios', personalScenariosRouter);
```

Adjust import path to match the existing convention in the file.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-personal-scenarios.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/routes/tax-personal-scenarios.ts backend/src/app.ts backend/test/tax/routes-personal-scenarios.test.ts
git commit --message="feat(tax-scenarios): CRUD routes for personal scenarios"
```

---

### Task 7: Fork + compute + compare endpoints

**Files:**
- Modify: `backend/src/routes/tax-personal-scenarios.ts` (add 3 endpoints)
- Modify: `backend/test/tax/routes-personal-scenarios.test.ts` (add tests)

- [ ] **Step 1: Add test cases**

Append to `backend/test/tax/routes-personal-scenarios.test.ts`:

```ts
test('POST /:id/fork creates a child scenario inheriting parent overrides', async () => {
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'ForkParent',
    overrides: { 'income.employment': 85000 },
  });
  const res = await authed.post(`/api/tax/personal-scenarios/${parent.body.scenario.id}/fork`).send({
    name: 'ForkChild',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scenario.parentId, parent.body.scenario.id);
  assert.equal(res.body.scenario.name, 'ForkChild');
  // Child starts empty — inheritance is via ancestry resolution, not duplication.
  assert.deepEqual(res.body.scenario.overrides, {});
});

test('POST /:id/compute returns fresh computation (bypass cache)', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'ComputeMe',
    overrides: { 'income.employment': 70000 },
  });
  const r1 = await authed.post(`/api/tax/personal-scenarios/${create.body.scenario.id}/compute`).send({});
  assert.equal(r1.status, 200);
  assert.equal(r1.body.computed.cached, false);
});

test('GET /compare?ids=... returns a diff payload for N scenarios', async () => {
  const a = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'CompareA', overrides: { 'income.employment': 60000 },
  });
  const b = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'CompareB', overrides: { 'income.employment': 90000 },
  });
  const res = await authed.get(`/api/tax/personal-scenarios/compare?ids=${a.body.scenario.id},${b.body.scenario.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.scenarios.length, 2);
  assert.ok(res.body.scenarios[0].computed);
  assert.ok(res.body.scenarios[1].computed);
});

test('GET /compare with mixed ownership returns 403', async () => {
  // Create a scenario in another household to attempt cross-household leak
  const { sequelize } = await import('../../src/db.js');
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other' });
  const otherEntity = await models.Entity.create({
    householdId: otherHousehold.id, kind: 'personal', legalName: 'Other P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const otherScenario = await models.Scenario.create({
    parentId: null, entityId: otherEntity.id, year: 2025,
    name: 'Other', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const mine = await authed.post('/api/tax/personal-scenarios').send({
    entityId, year: 2025, name: 'Mine', overrides: {},
  });
  const res = await authed.get(`/api/tax/personal-scenarios/compare?ids=${mine.body.scenario.id},${otherScenario.id}`);
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-personal-scenarios.test.ts
```

Expected: 4 new failures (fork/compute/compare routes don't exist yet).

- [ ] **Step 3: Add the 3 endpoints to `backend/src/routes/tax-personal-scenarios.ts`**

Insert before `export default router;`:

```ts
// POST /:id/fork — create child scenario inheriting via ancestry (overrides empty by default)
router.post('/:id/fork', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const name = typeof req.body?.name === 'string' && req.body.name.trim() !== ''
      ? req.body.name
      : `${result.scenario.name} (fork)`;
    const child = await Scenario.create({
      parentId: result.scenario.id,
      entityId: result.scenario.entityId,
      year: result.scenario.year,
      name,
      kind: 'fork',
      overrides: {},
      assumptions: {},
      nextYearId: null,
      notes: null,
    });
    res.status(201).json({ scenario: child });
  } catch (err) {
    next(err);
  }
});

// POST /:id/compute — force recompute (bypass cache)
router.post('/:id/compute', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const computed = await computeScenario(result.scenario.id, { force: true });
    res.json({ computed });
  } catch (err) {
    next(err);
  }
});

// GET /compare?ids=1,2,3 — diff payload for N scenarios
router.get('/compare', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const idsRaw = String(req.query.ids ?? '');
    const ids = idsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      res.status(400).json({ error: 'invalid_query', message: 'ids query param required (comma-separated)' });
      return;
    }
    const scenarios = await Scenario.findAll({ where: { id: ids } });
    if (scenarios.length !== ids.length) {
      res.status(404).json({ error: 'scenario_not_found' });
      return;
    }
    // Authorize: all referenced scenarios' entities must belong to caller's household.
    const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
    const entities = await Entity.findAll({ where: { id: entityIds } });
    if (entities.some((e) => e.householdId !== household.id)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const computedAll = await Promise.all(
      scenarios.map(async (s) => ({ scenario: s, computed: await computeScenario(s.id) })),
    );
    res.json({ scenarios: computedAll });
  } catch (err) {
    next(err);
  }
});
```

**Important:** the `GET /compare` route must be registered BEFORE `GET /:id` to avoid Express matching `compare` as an `:id`. Place `compare` handler above the `GET /:id` handler in the file.

- [ ] **Step 4: Reorder the handlers**

Move `GET /compare` above `GET /:id` in the router file.

- [ ] **Step 5: Run the full route test suite to verify it passes**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-personal-scenarios.test.ts
```

Expected: 13 tests PASS (9 from Task 6 + 4 new).

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/routes/tax-personal-scenarios.ts backend/test/tax/routes-personal-scenarios.test.ts
git commit --message="feat(tax-scenarios): fork, compute, compare endpoints"
```

---

### Task 8: `useScenarios` hook (frontend)

**Files:**
- Create: `frontend/src/hooks/useScenarios.ts`

Read pattern from `frontend/src/hooks/useTaxReturn.ts`. Use `getJson` / `postJson` / `patchJson` / `deleteJson` from `@/lib/api` if those exist; otherwise raw fetch like in `useReconciliation.ts` (from P6 Task 12).

- [ ] **Step 1: Check the api lib + existing hook pattern**

```bash
cat frontend/src/hooks/useReconciliation.ts
cat frontend/src/lib/api.ts 2>/dev/null
```

- [ ] **Step 2: Create the hook**

```ts
// frontend/src/hooks/useScenarios.ts
import { useCallback, useEffect, useState } from 'react';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

export interface Scenario {
  id: number;
  parentId: number | null;
  entityId: number;
  year: number;
  name: string;
  kind: ScenarioKind;
  overrides: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  nextYearId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputedReturn {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, string | number>;
  warnings: string[];
  cached: boolean;
}

export interface ScenarioWithComputed { scenario: Scenario; computed: ComputedReturn }

interface UseScenariosResult {
  scenarios: Scenario[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (input: { name: string; overrides?: Record<string, unknown>; parentId?: number | null; notes?: string | null }) => Promise<Scenario>;
  patch: (id: number, body: Partial<Pick<Scenario, 'name' | 'notes' | 'overrides' | 'assumptions'>>) => Promise<Scenario>;
  fork: (id: number, name?: string) => Promise<Scenario>;
  remove: (id: number) => Promise<void>;
}

export function useScenarios(entityId: number, year: number): UseScenariosResult {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/tax/personal-scenarios?entityId=${entityId}&year=${year}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ scenarios: Scenario[] }>;
      })
      .then((body) => { if (!cancelled) setScenarios(body.scenarios); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityId, year, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async function patchJson<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  const create: UseScenariosResult['create'] = async (input) => {
    const body = await postJson<{ scenario: Scenario }>('/api/tax/personal-scenarios', { entityId, year, ...input });
    reload();
    return body.scenario;
  };

  const patch: UseScenariosResult['patch'] = async (id, body) => {
    const result = await patchJson<{ scenario: Scenario }>(`/api/tax/personal-scenarios/${id}`, body);
    reload();
    return result.scenario;
  };

  const fork: UseScenariosResult['fork'] = async (id, name) => {
    const body = await postJson<{ scenario: Scenario }>(`/api/tax/personal-scenarios/${id}/fork`, name ? { name } : {});
    reload();
    return body.scenario;
  };

  const remove: UseScenariosResult['remove'] = async (id) => {
    const res = await fetch(`/api/tax/personal-scenarios/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message ?? `HTTP ${res.status}`);
    }
    reload();
  };

  return { scenarios, loading, error, reload, create, patch, fork, remove };
}
```

- [ ] **Step 3: Lint + commit**

```bash
yarn workspace frontend run lint
git add frontend/src/hooks/useScenarios.ts
git commit --message="feat(tax-scenarios): useScenarios hook"
```

---

### Task 9: `useScenarioComparison` hook + `useScenarioDetail` hook

**Files:**
- Create: `frontend/src/hooks/useScenarioComparison.ts`
- Modify: `frontend/src/hooks/useScenarios.ts` (export an additional `useScenarioDetail`)

- [ ] **Step 1: Add `useScenarioDetail` to `useScenarios.ts`**

Append to the bottom of `frontend/src/hooks/useScenarios.ts`:

```ts
export function useScenarioDetail(id: number | null): {
  data: ScenarioWithComputed | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<ScenarioWithComputed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (id === null) { setData(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/tax/personal-scenarios/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<ScenarioWithComputed>;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
```

- [ ] **Step 2: Create `useScenarioComparison.ts`**

```ts
// frontend/src/hooks/useScenarioComparison.ts
import { useEffect, useState } from 'react';
import type { ScenarioWithComputed } from './useScenarios';

export function useScenarioComparison(ids: number[]): {
  data: ScenarioWithComputed[];
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<ScenarioWithComputed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) { setData([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/tax/personal-scenarios/compare?ids=${ids.join(',')}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ scenarios: ScenarioWithComputed[] }>;
      })
      .then((body) => { if (!cancelled) setData(body.scenarios); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ids.join(',')]);

  return { data, loading, error };
}
```

- [ ] **Step 3: Lint + commit**

```bash
yarn workspace frontend run lint
git add frontend/src/hooks/useScenarioComparison.ts frontend/src/hooks/useScenarios.ts
git commit --message="feat(tax-scenarios): useScenarioDetail + useScenarioComparison hooks"
```

---

### Task 10: `ScenarioTree` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/ScenarioTree.tsx`

Renders the parent → children tree for an entity-year using indented `<ul>`. Active scenario highlighted. "Fork from current" + "New baseline projection" buttons (the latter is a stub for P9; it surfaces a "Not yet implemented" tooltip in P7).

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/pages/tax/scenarios/ScenarioTree.tsx
import { useMemo } from 'react';
import type { Scenario } from '../../../hooks/useScenarios';

interface Props {
  scenarios: Scenario[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onForkActive: () => void;
  onDeleteActive: () => void;
}

interface TreeNode { scenario: Scenario; children: TreeNode[] }

function buildTree(scenarios: Scenario[]): TreeNode[] {
  const byParent = new Map<number | null, Scenario[]>();
  for (const s of scenarios) {
    const key = s.parentId;
    const arr = byParent.get(key) ?? [];
    arr.push(s);
    byParent.set(key, arr);
  }
  function makeNode(s: Scenario): TreeNode {
    return { scenario: s, children: (byParent.get(s.id) ?? []).map(makeNode) };
  }
  return (byParent.get(null) ?? []).map(makeNode);
}

export function ScenarioTree({ scenarios, activeId, onSelect, onForkActive, onDeleteActive }: Props) {
  const tree = useMemo(() => buildTree(scenarios), [scenarios]);
  return (
    <aside style={{ minWidth: 240 }}>
      <h3>Scenarios</h3>
      {tree.length === 0 ? (
        <p className="muted">No scenarios yet.</p>
      ) : (
        <TreeList nodes={tree} activeId={activeId} onSelect={onSelect} />
      )}
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
        <button onClick={onForkActive} disabled={activeId === null}>+ Fork from current</button>
        <button onClick={onDeleteActive} disabled={activeId === null}>Delete</button>
      </div>
    </aside>
  );
}

function TreeList({ nodes, activeId, onSelect }: {
  nodes: TreeNode[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <ul style={{ listStyle: 'none', paddingLeft: '1rem' }}>
      {nodes.map((n) => (
        <li key={n.scenario.id}>
          <button
            onClick={() => onSelect(n.scenario.id)}
            style={{
              background: n.scenario.id === activeId ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: 'none', color: 'inherit', cursor: 'pointer', padding: '0.25rem 0.5rem', textAlign: 'left',
            }}
          >
            {n.scenario.kind === 'baseline' ? '• ' : '├ '}
            {n.scenario.name}
            {n.scenario.kind === 'baseline' && <span className="muted"> (actuals)</span>}
          </button>
          {n.children.length > 0 && <TreeList nodes={n.children} activeId={activeId} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Lint + commit**

```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/scenarios/ScenarioTree.tsx
git commit --message="feat(tax-scenarios): ScenarioTree component"
```

---

### Task 11: `OverrideEditor` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/OverrideEditor.tsx`

Reads the override key registry's keys (frontend-mirrored, kept in sync with backend manually for v1 — P7 small enough that the duplication is acceptable). Lets user add/remove keys + edit values. Calls `onChange` with the new override map; parent persists via `useScenarios.patch`.

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/pages/tax/scenarios/OverrideEditor.tsx
import { useState } from 'react';

interface KeyDef { key: string; label: string; inputType: 'decimal' | 'integer' | 'array_capgain_dispositions' }

// Mirror of backend overrideKeyRegistry. Keep in sync manually for P7.
const KEY_DEFS: KeyDef[] = [
  { key: 'income.employment', label: 'Employment income (CAD)', inputType: 'decimal' },
  { key: 'income.eligibleDividends', label: 'Eligible dividends (CAD)', inputType: 'decimal' },
  { key: 'income.nonEligibleDividends', label: 'Non-eligible dividends (CAD)', inputType: 'decimal' },
  { key: 'income.interest', label: 'Interest income (CAD)', inputType: 'decimal' },
  { key: 'deductions.rrspContrib', label: 'RRSP contribution (CAD)', inputType: 'decimal' },
  { key: 'deductions.fhsaContrib', label: 'FHSA contribution (CAD)', inputType: 'decimal' },
  { key: 'deductions.donations', label: 'Donations (CAD)', inputType: 'decimal' },
  { key: 'capgains.dispositions', label: 'Capital gain dispositions', inputType: 'array_capgain_dispositions' },
];

interface Props {
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function OverrideEditor({ overrides, onChange }: Props) {
  const [pendingKey, setPendingKey] = useState<string>(KEY_DEFS[0].key);
  const present = Object.keys(overrides);
  const available = KEY_DEFS.filter((d) => !present.includes(d.key));

  function setValue(key: string, value: unknown) {
    onChange({ ...overrides, [key]: value });
  }
  function removeKey(key: string) {
    const next = { ...overrides };
    delete next[key];
    onChange(next);
  }
  function addKey() {
    const def = KEY_DEFS.find((d) => d.key === pendingKey);
    if (!def) return;
    if (def.inputType === 'array_capgain_dispositions') {
      setValue(def.key, []);
    } else {
      setValue(def.key, 0);
    }
  }

  return (
    <section>
      <h3>Overrides ({present.length})</h3>
      {present.length === 0 ? (
        <p className="muted">No overrides — using actuals.</p>
      ) : (
        <ul>
          {present.map((k) => {
            const def = KEY_DEFS.find((d) => d.key === k);
            const v = overrides[k];
            return (
              <li key={k} style={{ marginBottom: '0.5rem' }}>
                <strong>{def?.label ?? k}</strong>{' '}
                {def?.inputType === 'array_capgain_dispositions' ? (
                  <DispositionArrayEditor
                    value={(v as Array<{ proceeds: number; acb: number; date: string }>) ?? []}
                    onChange={(next) => setValue(k, next)}
                  />
                ) : (
                  <input
                    type="number"
                    step="0.01"
                    value={typeof v === 'number' ? v : 0}
                    onChange={(e) => setValue(k, Number(e.target.value))}
                  />
                )}
                <button onClick={() => removeKey(k)} style={{ marginLeft: '0.5rem' }}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <select value={pendingKey} onChange={(e) => setPendingKey(e.target.value)}>
            {available.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
          <button onClick={addKey} style={{ marginLeft: '0.5rem' }}>+ Add override</button>
        </div>
      )}
    </section>
  );
}

function DispositionArrayEditor({ value, onChange }: {
  value: Array<{ proceeds: number; acb: number; date: string }>;
  onChange: (next: Array<{ proceeds: number; acb: number; date: string }>) => void;
}) {
  function setRow(i: number, patch: Partial<{ proceeds: number; acb: number; date: string }>) {
    const next = value.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  }
  function addRow() { onChange([...value, { proceeds: 0, acb: 0, date: new Date().toISOString().slice(0, 10) }]); }
  function removeRow(i: number) { onChange(value.filter((_, idx) => idx !== i)); }
  return (
    <div style={{ display: 'inline-block', marginLeft: '0.5rem' }}>
      <table>
        <thead><tr><th>Proceeds</th><th>ACB</th><th>Date</th><th /></tr></thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              <td><input type="number" step="0.01" value={row.proceeds} onChange={(e) => setRow(i, { proceeds: Number(e.target.value) })} /></td>
              <td><input type="number" step="0.01" value={row.acb} onChange={(e) => setRow(i, { acb: Number(e.target.value) })} /></td>
              <td><input type="date" value={row.date} onChange={(e) => setRow(i, { date: e.target.value })} /></td>
              <td><button onClick={() => removeRow(i)}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow}>+ Add disposition</button>
    </div>
  );
}
```

- [ ] **Step 2: Lint + commit**

```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/scenarios/OverrideEditor.tsx
git commit --message="feat(tax-scenarios): OverrideEditor with typed inputs"
```

---

### Task 12: `ComparisonView` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/ComparisonView.tsx`

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/pages/tax/scenarios/ComparisonView.tsx
import { useScenarioComparison } from '../../../hooks/useScenarioComparison';

interface Props {
  ids: number[];
  onClose: () => void;
}

const TOTAL_KEYS = [
  'totalIncome', 'netIncome', 'taxableIncome',
  'federalTax', 'provincialTax', 'cppContrib', 'eiPremium',
  'totalPayable', 'refundOrOwing',
];

export function ComparisonView({ ids, onClose }: Props) {
  const { data, loading, error } = useScenarioComparison(ids);
  if (loading) return <p className="muted">Comparing…</p>;
  if (error) return <p className="error">Compare failed: {error}</p>;
  if (data.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h3>Comparing {data.length} scenario{data.length === 1 ? '' : 's'}</h3>
        <button onClick={onClose}>Close</button>
      </header>
      <table>
        <thead>
          <tr>
            <th>Line</th>
            {data.map((row) => <th key={row.scenario.id}>{row.scenario.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {TOTAL_KEYS.map((k) => (
            <tr key={k}>
              <td><strong>{k}</strong></td>
              {data.map((row) => (
                <td key={row.scenario.id}>
                  {formatCell(row.computed.totals[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

- [ ] **Step 2: Lint + commit**

```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/scenarios/ComparisonView.tsx
git commit --message="feat(tax-scenarios): ComparisonView grid"
```

---

### Task 13: Integrate scenario tree + editor + compare into PersonalT1Tab

**Files:**
- Modify: `frontend/src/pages/tax/PersonalT1Tab.tsx`

- [ ] **Step 1: Read the current file to know what's there**

```bash
cat frontend/src/pages/tax/PersonalT1Tab.tsx
```

- [ ] **Step 2: Rewrite `PersonalT1Tab.tsx` to embed scenario tree + selected-scenario view**

Resolve the personal entity ID from existing data (likely via an `useTaxEntities` hook that already exists). If no such hook exists, fetch `/api/tax/entities` directly. The exact integration shape depends on the current implementation — read the file first.

Skeleton (engineer adapts based on what's already in the file):

```tsx
// frontend/src/pages/tax/PersonalT1Tab.tsx (partial — preserve existing line breakdown UI)
import { useState } from 'react';
import { useTaxEntities } from '../../hooks/useTaxEntities'; // confirm hook name
import { useScenarios, useScenarioDetail } from '../../hooks/useScenarios';
import { ScenarioTree } from './scenarios/ScenarioTree';
import { OverrideEditor } from './scenarios/OverrideEditor';
import { ComparisonView } from './scenarios/ComparisonView';

export function PersonalT1Tab({ year }: { year: number }) {
  const { entities } = useTaxEntities();
  const personalEntity = entities?.find((e: { kind: string }) => e.kind === 'personal');
  if (!personalEntity) return <p className="muted">Create a personal entity first.</p>;

  const { scenarios, create, patch, fork, remove, loading } = useScenarios(personalEntity.id, year);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const active = useScenarioDetail(activeId);

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div style={{ display: 'flex', gap: '1.5rem' }}>
      <ScenarioTree
        scenarios={scenarios}
        activeId={activeId}
        onSelect={setActiveId}
        onForkActive={async () => {
          if (activeId !== null) {
            const child = await fork(activeId);
            setActiveId(child.id);
          }
        }}
        onDeleteActive={async () => {
          if (activeId !== null) {
            try { await remove(activeId); setActiveId(null); }
            catch (err) { alert((err as Error).message); }
          }
        }}
      />
      <div style={{ flex: 1 }}>
        {active.data ? (
          <>
            <h3>{active.data.scenario.name}</h3>
            <OverrideEditor
              overrides={active.data.scenario.overrides}
              onChange={(next) => patch(active.data!.scenario.id, { overrides: next }).then(() => active.reload())}
            />
            <section style={{ marginTop: '1rem' }}>
              <h4>Computed totals</h4>
              <ul>
                {Object.entries(active.data.computed.totals).map(([k, v]) => (
                  <li key={k}><strong>{k}</strong>: {String(v)}</li>
                ))}
              </ul>
            </section>
            <button
              onClick={() => setCompareIds([...compareIds.filter((id) => id !== active.data!.scenario.id), active.data!.scenario.id])}
              style={{ marginTop: '0.5rem' }}
            >
              + Add to compare
            </button>
          </>
        ) : (
          <p className="muted">Select a scenario to view details.</p>
        )}
        {compareIds.length > 1 && (
          <ComparisonView ids={compareIds} onClose={() => setCompareIds([])} />
        )}
      </div>
    </div>
  );
}
```

**Important:** the existing PersonalT1Tab probably renders T1 line breakdown using `useTaxReturn(year)`. The new scenario flow REPLACES that for the active scenario's totals. Keep the line breakdown UI as a "Baseline" section visible when no scenario is selected; otherwise the scenario's `computed.lines` should drive it. Engineer judges based on the actual current file.

- [ ] **Step 3: Lint**

```bash
yarn workspace frontend run lint
```

- [ ] **Step 4: Manual sanity check**

Start the dev server (`yarn dev`). Navigate to Tax → Personal T1. Confirm the scenario tree appears, baseline is auto-created on first load, you can fork + edit overrides + see recomputed totals + add 2 scenarios to compare and see the diff grid.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/PersonalT1Tab.tsx
git commit --message="feat(tax-scenarios): wire ScenarioTree+OverrideEditor+ComparisonView into PersonalT1Tab"
```

---

## Self-review checklist (engineer: run before opening PR)

- [ ] All 13 task commits land on the branch in order.
- [ ] `yarn workspace cashflow-backend run test` passes (full suite, no regressions vs main).
- [ ] `yarn workspace cashflow-backend run typecheck` passes.
- [ ] `yarn workspace frontend run lint` passes.
- [ ] Manual: open Personal T1, baseline auto-created on first view of a year, fork → edit → recompute → compare flow works end-to-end.
- [ ] No `Co-Authored-By` lines in any commit.
- [ ] Legacy `POST /api/tax/scenarios` (single-shot owner-comp) NOT modified — still works for Owner Comp tab. P8 will consolidate.
- [ ] `frontend/src/pages/tax/scenarios/OverrideEditor.tsx` key list matches `backend/src/tax/scenarios/overrideKeys.ts` registry. P8 may push these to `shared/api-types.ts` once corp keys land.

## Risks / out of scope

- **Override key registry duplication** (backend + frontend): documented, acceptable for v1. Move to `shared/` in P8 when the registry grows.
- **No projection/multi-year compute path yet:** `next_year_id` + `assumptions` columns exist on the table but are unused. P9 wires them.
- **No household plan integration:** all scenarios are personal-entity-only. P8 introduces `household_plans` to group sibling-entity scenarios.
- **No CDA/GRIP overrides:** corp-side keys land in P8.

# Tax Corp Scenarios (Phase P8a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the P7 scenario engine to support corp entities. Reuses the existing `scenarios` + `scenario_returns` tables (entity_id FK already supports both `personal` and `corp`); refactors `resolveScenario` / `computeScenario` to dispatch by `entity.kind`. New corp-side override keys, new `/api/tax/corp-scenarios/*` routes, scenario tree wired into the Corp T2 tab.

**Architecture:** Single Scenario model handles both personal + corp via the existing `entity_id` FK. The override key registry partitions by `entity.kind` (personal keys reject on corp scenarios + vice versa). The resolver/compute layer dispatches to `buildPersonalFacts`+`buildT1` or `buildCorpFacts`+`buildT2` based on the scenario's entity kind. P8a ships corp scenarios standalone — HouseholdPlan grouping + integration router + Owner Comp lever surface land in **P8b** (separate plan + PR).

**Tech Stack:** TypeScript, Sequelize, Express, Node's built-in `node:test` runner, React + Vite. Decimal via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) — section 4 (P8 row), section 5 (override key registry includes corp keys), section 6 (computeScenario dispatch + integration router), section 8.2 (scenario tree on Corp T2). HouseholdPlan + Owner Comp surface deferred to P8b.

**Builds on:** P7 (commit range `970433f..3101bf1`). Specifically:
- `Scenario` + `ScenarioReturn` models from P7 T1
- Override key registry from P7 T2 — extends with corp keys
- `applyOverrides`, `resolveScenario`, `computeScenario` from P7 T3-T5 — refactors to dispatch by entity kind
- API CRUD pattern from P7 T6-T7 — mirrors at `/api/tax/corp-scenarios`
- Frontend `ScenarioTree`, `OverrideEditor`, `ComparisonView` from P7 T10-T12 — reuses for corp variant

**Conventions** (same as P6 + P7 plans):
- `node:test` framework, `await sequelize.sync({ force: true })` in `beforeEach`, **import models BEFORE sync**.
- `npx tsx --import ./backend/test/setup.ts --test <path>` for isolated test runs.
- Decimal via `D` / `sumD` from `backend/src/tax/util/decimal`.
- Commit messages conventional. `git commit --message=...` form.
- NEVER add `Co-Authored-By`.
- Each task ends with a commit.

---

## File Structure

**Backend created:**
- `backend/src/tax/scenarios/corpOverrideKeys.ts` — corp-side typed registry
- `backend/src/tax/scenarios/resolveCorpScenario.ts` — corp variant of resolveScenario (uses `buildCorpFacts`)
- `backend/src/tax/scenarios/computeCorpScenario.ts` — corp variant of computeScenario (uses `buildT2`)
- `backend/src/routes/tax-corp-scenarios.ts` — CRUD + fork + compute + compare
- Tests for each module

**Backend modified:**
- `backend/src/tax/scenarios/overrideKeys.ts` — rename to `personalOverrideKeys.ts` semantically (keep file location for diff stability; add a `kind: 'personal' | 'corp'` discriminator to each entry, default existing entries to `personal`)
- `backend/src/tax/scenarios/applyOverrides.ts` — accept a `kind` parameter, dispatch to the right registry
- `backend/src/app.ts` — mount new corp-scenarios router

**Frontend created:**
- `frontend/src/hooks/useCorpScenarios.ts` — mirrors `useScenarios` (P7 T8) but for corp endpoints
- `frontend/src/hooks/useCorpScenarioDetail.ts` — mirrors `useScenarioDetail`
- `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx` — corp variant of OverrideEditor with corp key list

**Frontend modified:**
- `frontend/src/pages/tax/CorpT2Tab.tsx` — embed scenario tree + active-scenario panel (mirrors what P7 T13 did for PersonalT1Tab)

---

## Override key partitioning

The P7 registry currently treats all keys as personal. P8a adds a `kind` discriminator. Personal scenarios accept only `kind: 'personal'` keys, corp scenarios accept only `kind: 'corp'`. Cross-kind override usage rejects at the validator.

**Corp override keys (new, all `kind: 'corp'`):**
- `corp.activeIncome` — Decimal, replaces the corp's active business income
- `corp.passiveInvestmentIncome` — Decimal, replaces the corp's investment income
- `corp.aaiiTrailing` — Decimal, AAII trailing balance for SBD grind
- `corp.dividendsPaidEligible` — Decimal, eligible dividends paid (single line item)
- `corp.dividendsPaidNonEligible` — Decimal, non-eligible dividends paid
- `corp.salaryPaid` — Decimal, total T4 salary paid to all shareholders
- `corp.openingGrip` — Decimal, GRIP balance carried into year (overrides actuals)
- `corp.openingCda` — Decimal, CDA balance carried into year

These map onto the existing `CorpTaxYearFacts` struct from `backend/src/tax/engine/types.ts`.

---

## Task plan

### Task 1: Add `kind` discriminator to override key registry + split personal/corp registries

**Files:**
- Modify: `backend/src/tax/scenarios/types.ts` — add `kind` to `OverrideKeyDef`
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — tag all existing entries `kind: 'personal'`, partition lookup helpers by kind
- Modify: `backend/test/tax/scenarios/overrideKeys.test.ts` — assert kind tags on existing keys
- Modify: `backend/src/tax/scenarios/applyOverrides.ts` — accept `kind` parameter, dispatch
- Modify: `backend/test/tax/scenarios/applyOverrides.test.ts` — pass kind in calls
- Modify: `backend/src/tax/scenarios/resolveScenario.ts` — pass `'personal'` to applyOverrides
- Modify: `backend/test/tax/scenarios/resolveScenario.test.ts` — no signature change at the API; verify still passes

- [ ] **Step 1: Add `kind` to `OverrideKeyDef`**

Edit `backend/src/tax/scenarios/types.ts` — add to the interface:

```ts
export interface OverrideKeyDef {
  /** Which entity kind this override applies to. Personal scenarios reject corp keys and vice versa. */
  kind: 'personal' | 'corp';
  // ...existing fields unchanged
  key: string;
  label: string;
  validate: (value: unknown) => void;
  apply: OverrideApplier;
  inputType: 'decimal' | 'integer' | 'array_capgain_dispositions';
}
```

- [ ] **Step 2: Tag every existing entry in `overrideKeys.ts` with `kind: 'personal'`**

Add `kind: 'personal',` as the first field of each registry entry. Also export a kind-partitioned helper:

```ts
export function getOverrideKeysForKind(kind: 'personal' | 'corp'): OverrideKeyDef[] {
  return overrideKeyRegistry.filter((k) => k.kind === kind);
}
```

Change `validateOverrideMap` to take a kind:

```ts
export function validateOverrideMap(map: OverrideMap, kind: 'personal' | 'corp'): void {
  for (const [key, value] of Object.entries(map)) {
    const entry = indexByKey.get(key);
    if (!entry) throw new Error(`unknown override key: ${key}`);
    if (entry.kind !== kind) {
      throw new Error(`override key ${key} is for ${entry.kind} scenarios, not ${kind}`);
    }
    entry.validate(value);
  }
}
```

- [ ] **Step 3: Update `applyOverrides.ts` to take a kind**

```ts
export function applyOverrides<F>(
  baseFacts: F,
  overrideChain: OverrideMap[],
  kind: 'personal' | 'corp',
): F {
  let facts = baseFacts;
  for (const map of overrideChain) {
    validateOverrideMap(map, kind);
    for (const [key, value] of Object.entries(map)) {
      const entry = getOverrideKey(key)!;
      facts = entry.apply(facts as never, value) as F;
    }
  }
  return facts;
}
```

The generic `F` lets corp scenarios pass `CorpTaxYearFacts`. The cast `as never` inside the loop is because each apply function is typed against `TaxYearFacts` in the personal registry; the corp registry's apply functions will be typed against `CorpTaxYearFacts`. The shared `applyOverrides` is generic so it works for both.

- [ ] **Step 4: Update `resolveScenario.ts` to pass `'personal'`**

```ts
const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
return applyOverrides(baseFacts, overrideChain, 'personal');
```

- [ ] **Step 5: Update tests**

In `backend/test/tax/scenarios/applyOverrides.test.ts`, change every `applyOverrides(facts, [...])` call to `applyOverrides(facts, [...], 'personal')`.

In `backend/test/tax/scenarios/overrideKeys.test.ts`, add a test:

```ts
test('all existing P7 keys have kind=personal', () => {
  for (const entry of overrideKeyRegistry) {
    assert.equal(entry.kind, 'personal', `${entry.key} should be tagged personal`);
  }
});

test('validateOverrideMap rejects a personal key on a corp scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'income.employment': 95000 }, 'corp'),
    /personal scenarios/,
  );
});
```

Also import the new `validateOverrideMap` signature.

- [ ] **Step 6: Run all touched tests**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/overrideKeys.test.ts backend/test/tax/scenarios/applyOverrides.test.ts backend/test/tax/scenarios/resolveScenario.test.ts backend/test/tax/scenarios/computeScenario.test.ts
```

Expected: all pass (existing P7 tests + 2 new override-kind tests).

- [ ] **Step 7: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/types.ts backend/src/tax/scenarios/overrideKeys.ts backend/src/tax/scenarios/applyOverrides.ts backend/src/tax/scenarios/resolveScenario.ts backend/test/tax/scenarios/overrideKeys.test.ts backend/test/tax/scenarios/applyOverrides.test.ts
git commit --message="refactor(tax-scenarios): add kind discriminator to override registry"
```

---

### Task 2: Corp override key registry

**Files:**
- Create: `backend/src/tax/scenarios/corpOverrideKeys.ts`
- Create: `backend/test/tax/scenarios/corpOverrideKeys.test.ts`
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — re-export corp registry items so the unified `overrideKeyRegistry` includes both

The clean approach: keep one `overrideKeyRegistry` array (the source of truth), have `corpOverrideKeys.ts` define the corp entries and re-register them via a small init call in `overrideKeys.ts`. This avoids two index maps.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/scenarios/corpOverrideKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import { getOverrideKey, getOverrideKeysForKind, validateOverrideMap } from '../../../src/tax/scenarios/overrideKeys';
import '../../../src/tax/scenarios/corpOverrideKeys'; // side-effect: registers corp keys
import type { CorpTaxYearFacts } from '../../../src/tax/engine/types';

function emptyCorpFacts(): CorpTaxYearFacts {
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

test('corp registry exposes 8 P8a keys', () => {
  const keys = getOverrideKeysForKind('corp').map((k) => k.key);
  assert.ok(keys.includes('corp.activeIncome'));
  assert.ok(keys.includes('corp.passiveInvestmentIncome'));
  assert.ok(keys.includes('corp.aaiiTrailing'));
  assert.ok(keys.includes('corp.dividendsPaidEligible'));
  assert.ok(keys.includes('corp.dividendsPaidNonEligible'));
  assert.ok(keys.includes('corp.salaryPaid'));
  assert.ok(keys.includes('corp.openingGrip'));
  assert.ok(keys.includes('corp.openingCda'));
});

test('all corp keys have kind=corp', () => {
  for (const entry of getOverrideKeysForKind('corp')) {
    assert.equal(entry.kind, 'corp');
  }
});

test('validateOverrideMap accepts a corp key on a corp scenario', () => {
  validateOverrideMap({ 'corp.activeIncome': 250000 }, 'corp'); // should not throw
});

test('validateOverrideMap rejects a corp key on a personal scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'corp.activeIncome': 250000 }, 'personal'),
    /corp scenarios/,
  );
});

test('apply: corp.activeIncome replaces activeBusinessIncome array', () => {
  const entry = getOverrideKey('corp.activeIncome')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 250000) as unknown as CorpTaxYearFacts;
  assert.equal(result.activeBusinessIncome.length, 1);
  assert.equal(result.activeBusinessIncome[0].cadAmount.toFixed(2), '250000.00');
});

test('apply: corp.salaryPaid replaces salaryPaid Decimal', () => {
  const entry = getOverrideKey('corp.salaryPaid')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 60000) as unknown as CorpTaxYearFacts;
  assert.equal(result.salaryPaid.toFixed(2), '60000.00');
});

test('apply: corp.dividendsPaidEligible appends one dividend item', () => {
  const entry = getOverrideKey('corp.dividendsPaidEligible')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 80000) as unknown as CorpTaxYearFacts;
  assert.equal(result.dividendsPaid.length, 1);
  assert.equal(result.dividendsPaid[0].kind, 'eligible');
  assert.equal(result.dividendsPaid[0].amount.toFixed(2), '80000.00');
});

test('apply: corp.openingGrip overrides carryforward', () => {
  const entry = getOverrideKey('corp.openingGrip')!;
  const result = entry.apply(emptyCorpFacts() as unknown as never, 50000) as unknown as CorpTaxYearFacts;
  assert.equal(result.carryforwards.grip.toFixed(2), '50000.00');
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/corpOverrideKeys.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `corpOverrideKeys.ts`**

```ts
// backend/src/tax/scenarios/corpOverrideKeys.ts
import { D } from '../util/decimal';
import { registerOverrideKeys } from './overrideKeys';
import type { OverrideKeyDef } from './types';
import type { CorpTaxYearFacts, IncomeItem, CorpDividendPaid } from '../engine/types';

function assertNumber(value: unknown, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key}: expected a finite number, got ${typeof value}`);
  }
}

function singletonIncome(source: string, amount: number): IncomeItem {
  const cad = D(String(amount));
  return { source, amount: cad, cadAmount: cad };
}

function replaceActiveIncome(label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    return { ...corp, activeBusinessIncome: [singletonIncome(`override:${label}`, value)] } as unknown as typeof facts;
  };
}

function replaceInterest(label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    return {
      ...corp,
      investmentIncome: { ...corp.investmentIncome, interest: [singletonIncome(`override:${label}`, value)] },
    } as unknown as typeof facts;
  };
}

function appendDividendPaid(kind: 'eligible' | 'non_eligible', label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    const item: CorpDividendPaid = {
      source: `override:${label}`,
      date: corp.fiscalYear.endDate,
      amount: D(String(value)),
      kind,
    };
    return { ...corp, dividendsPaid: [...corp.dividendsPaid, item] } as unknown as typeof facts;
  };
}

const corpKeys: OverrideKeyDef[] = [
  {
    kind: 'corp',
    key: 'corp.activeIncome',
    label: 'Active business income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.activeIncome'),
    apply: replaceActiveIncome('corp.activeIncome'),
  },
  {
    kind: 'corp',
    key: 'corp.passiveInvestmentIncome',
    label: 'Passive investment income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.passiveInvestmentIncome'),
    apply: replaceInterest('corp.passiveInvestmentIncome'),
  },
  {
    kind: 'corp',
    key: 'corp.aaiiTrailing',
    label: 'AAII trailing (for SBD grind)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.aaiiTrailing'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.aaiiTrailing');
      const corp = facts as unknown as CorpTaxYearFacts;
      // Carryforwards do not currently expose aaii. Pass through via a synthetic field — engine should
      // consume corp.aaiiTrailing if present, otherwise compute from prior years. P8a relies on the
      // engine ignoring the field for now; P8b's integration math will read it. Document as a known gap.
      return { ...corp, aaiiTrailing: D(String(value)) } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.dividendsPaidEligible',
    label: 'Eligible dividends paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.dividendsPaidEligible'),
    apply: appendDividendPaid('eligible', 'corp.dividendsPaidEligible'),
  },
  {
    kind: 'corp',
    key: 'corp.dividendsPaidNonEligible',
    label: 'Non-eligible dividends paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.dividendsPaidNonEligible'),
    apply: appendDividendPaid('non_eligible', 'corp.dividendsPaidNonEligible'),
  },
  {
    kind: 'corp',
    key: 'corp.salaryPaid',
    label: 'Total T4 salary paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.salaryPaid'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.salaryPaid');
      const corp = facts as unknown as CorpTaxYearFacts;
      return { ...corp, salaryPaid: D(String(value)) } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.openingGrip',
    label: 'Opening GRIP (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.openingGrip'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.openingGrip');
      const corp = facts as unknown as CorpTaxYearFacts;
      return {
        ...corp,
        carryforwards: { ...corp.carryforwards, grip: D(String(value)) },
      } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.openingCda',
    label: 'Opening CDA (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.openingCda'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.openingCda');
      const corp = facts as unknown as CorpTaxYearFacts;
      return {
        ...corp,
        carryforwards: { ...corp.carryforwards, cda: D(String(value)) },
      } as unknown as typeof facts;
    },
  },
];

registerOverrideKeys(corpKeys);
```

- [ ] **Step 4: Add `registerOverrideKeys` to `overrideKeys.ts`**

Add to `backend/src/tax/scenarios/overrideKeys.ts` near the bottom (just before the bottom-of-file exports):

```ts
/**
 * Register additional override keys at module load time. Used by `corpOverrideKeys.ts`
 * to extend the registry without circular imports.
 */
export function registerOverrideKeys(entries: OverrideKeyDef[]): void {
  for (const e of entries) {
    if (indexByKey.has(e.key)) {
      throw new Error(`override key ${e.key} already registered`);
    }
    overrideKeyRegistry.push(e);
    indexByKey.set(e.key, e);
  }
}
```

Note: `overrideKeyRegistry` and `indexByKey` must be `let`-declared or have mutable methods; the existing `const overrideKeyRegistry: OverrideKeyDef[] = [...]` and `const indexByKey = new Map(...)` are mutable enough (Array.push, Map.set work on const-declared mutables).

Make sure `corpOverrideKeys.ts` is imported somewhere that runs at process boot so the corp keys register. Add the import to `backend/src/models/index.ts` or `backend/src/app.ts`:

```ts
// In app.ts (or models/index.ts) — load corp override keys at startup
import '../tax/scenarios/corpOverrideKeys';
```

Or simpler — add the import at the bottom of `backend/src/tax/scenarios/overrideKeys.ts`:

```ts
// At the very bottom of overrideKeys.ts, after registerOverrideKeys is exported:
// Self-register corp keys when this module loads (any consumer imports
// overrideKeys.ts, so corp keys are always present).
import './corpOverrideKeys';
```

The trailing import works in TypeScript ESM as a side-effect import. Verify it loads on test runs.

- [ ] **Step 5: Run the corp test + verify P7 personal tests still pass**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/corpOverrideKeys.test.ts backend/test/tax/scenarios/overrideKeys.test.ts
```

Expected: all corp + personal override-key tests PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/corpOverrideKeys.ts backend/src/tax/scenarios/overrideKeys.ts backend/test/tax/scenarios/corpOverrideKeys.test.ts
git commit --message="feat(tax-scenarios): corp override key registry"
```

---

### Task 3: `resolveCorpScenario` + `computeCorpScenario`

**Files:**
- Create: `backend/src/tax/scenarios/resolveCorpScenario.ts`
- Create: `backend/src/tax/scenarios/computeCorpScenario.ts`
- Create: `backend/test/tax/scenarios/resolveCorpScenario.test.ts`
- Create: `backend/test/tax/scenarios/computeCorpScenario.test.ts`

Mirrors the personal versions, but reads `buildCorpFacts` and runs `buildT2`. The ancestry walk + override layering is identical pattern; share a private helper if convenient or copy + adapt.

- [ ] **Step 1: Write the failing test for resolveCorpScenario**

```ts
// backend/test/tax/scenarios/resolveCorpScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { resolveCorpScenario, ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedCorp() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'C',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const account = await Account.create({
    name: 'CorpChk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '250000', currency: 'CAD',
    finalCategory: 'business_revenue', finalBusiness: true,
    merchantRaw: 'CUSTOMER', merchantClean: 'CUSTOMER',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('ensureCorpBaselineScenario creates a corp baseline on first call', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  assert.equal(baseline.kind, 'baseline');
  assert.equal(baseline.entityId, entity.id);
});

test('resolveCorpScenario(baseline) returns corp facts from actuals', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const facts = await resolveCorpScenario(baseline.id);
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '250000.00');
});

test('resolveCorpScenario(fork) layers corp override on baseline actuals', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'Higher revenue', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveCorpScenario(fork.id);
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '400000.00');
});

test('resolveCorpScenario rejects when scenario entity is personal', async () => {
  const household = await Household.create({ name: 'T2' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: personal.id, year: 2025,
    name: 'Wrong kind', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => resolveCorpScenario(scenario.id), /personal/i);
});
```

- [ ] **Step 2: Implement `resolveCorpScenario.ts`**

```ts
// backend/src/tax/scenarios/resolveCorpScenario.ts
import { Entity, Scenario } from '../../models';
import { buildCorpFacts } from '../builders/buildCorpFacts';
import { applyOverrides } from './applyOverrides';
import type { OverrideMap } from './types';
import type { CorpTaxYearFacts } from '../engine/types';

const MAX_ANCESTRY_DEPTH = 16;

export async function ensureCorpBaselineScenario(
  entityId: number,
  year: number,
): Promise<Scenario> {
  const existing = await Scenario.findOne({
    where: { entityId, year, kind: 'baseline' },
  });
  if (existing) return existing;
  return Scenario.create({
    parentId: null, entityId, year,
    name: 'Baseline', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
}

export async function resolveCorpScenario(scenarioId: number): Promise<CorpTaxYearFacts> {
  const ancestry = await loadAncestry(scenarioId);
  const root = ancestry[0];
  const entity = await Entity.findByPk(root.entityId);
  if (!entity) throw new Error(`entity id=${root.entityId} not found`);
  if (entity.kind !== 'corp') {
    throw new Error(`scenario id=${scenarioId} references entity kind=${entity.kind}, not corp`);
  }
  const baseFacts = await buildCorpFacts(root.entityId, {
    startDate: `${root.year}-01-01`,
    endDate: `${root.year}-12-31`,
  });
  const overrideChain: OverrideMap[] = ancestry.map((s) => s.overrides as OverrideMap);
  return applyOverrides(baseFacts, overrideChain, 'corp');
}

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
  return reverse.reverse();
}
```

Note: the corp builder's `fiscalYear` arg uses calendar-year defaults. If the corp's `fiscalYearEnd` differs, P8b will adapt; P8a assumes calendar year for simplicity.

- [ ] **Step 3: Run resolveCorpScenario tests**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/resolveCorpScenario.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 4: Write the failing test for computeCorpScenario**

```ts
// backend/test/tax/scenarios/computeCorpScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, ScenarioReturn, Transaction,
} from '../../../src/models';
import { computeCorpScenario } from '../../../src/tax/scenarios/computeCorpScenario';
import { ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedCorp() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'C',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const account = await Account.create({
    name: 'CorpChk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '250000', currency: 'CAD',
    finalCategory: 'business_revenue', finalBusiness: true,
    merchantRaw: 'C', merchantClean: 'C',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('computeCorpScenario returns a CorpTaxReturn-shape result', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const result = await computeCorpScenario(baseline.id);
  assert.ok(Array.isArray(result.lines));
  assert.ok('netTaxPayable' in result.totals);
});

test('computeCorpScenario writes a cache row and reuses it', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  await computeCorpScenario(baseline.id);
  await computeCorpScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
});

test('computeCorpScenario recomputes when overrides change', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'F', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const r1 = await computeCorpScenario(fork.id);
  await fork.update({ overrides: { 'corp.activeIncome': 600000 } });
  const r2 = await computeCorpScenario(fork.id);
  assert.notEqual(r1.factsHash, r2.factsHash);
});
```

- [ ] **Step 5: Implement `computeCorpScenario.ts`**

```ts
// backend/src/tax/scenarios/computeCorpScenario.ts
import crypto from 'node:crypto';
import { Scenario, ScenarioReturn } from '../../models';
import { resolveCorpScenario } from './resolveCorpScenario';
import { ratesFor } from '../engine/brackets';
import { buildT2 } from '../engine/t2';
import type { CorpTaxYearFacts } from '../engine/types';

export interface ComputeCorpScenarioOptions { force?: boolean }

export interface ComputeCorpScenarioResult {
  scenarioId: number;
  factsHash: string;
  computedAt: string;
  lines: unknown[];
  totals: Record<string, unknown>;
  warnings: string[];
  cached: boolean;
}

export async function computeCorpScenario(
  scenarioId: number,
  options: ComputeCorpScenarioOptions = {},
): Promise<ComputeCorpScenarioResult> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);

  const facts = await resolveCorpScenario(scenarioId);
  const factsHash = hashFacts(facts);

  if (!options.force) {
    const cached = await ScenarioReturn.findOne({ where: { scenarioId, factsHash } });
    if (cached) {
      return {
        scenarioId, factsHash,
        computedAt: cached.computedAt.toISOString(),
        lines: cached.lines as unknown[],
        totals: cached.totals as Record<string, unknown>,
        warnings: cached.warnings as string[],
        cached: true,
      };
    }
  }

  const engineReturn = buildT2(facts, ratesFor(Number(facts.fiscalYear.startDate.slice(0, 4))));
  const lines = JSON.parse(JSON.stringify(engineReturn.lines));
  const totals = JSON.parse(JSON.stringify(engineReturn.totals));
  const warnings = engineReturn.warnings;

  // Upsert: if force-recompute hit a row with same hash, refresh in place (matches P7 T5 pattern).
  const existing = await ScenarioReturn.findOne({ where: { scenarioId, factsHash } });
  let row: ScenarioReturn;
  if (existing) {
    await existing.update({ computedAt: new Date(), lines, totals, warnings });
    row = existing;
  } else {
    row = await ScenarioReturn.create({
      scenarioId, factsHash, computedAt: new Date(),
      lines, totals, warnings,
    });
  }

  return {
    scenarioId, factsHash,
    computedAt: row.computedAt.toISOString(),
    lines, totals, warnings,
    cached: false,
  };
}

function hashFacts(facts: CorpTaxYearFacts): string {
  const canonical = JSON.stringify(facts, (_k, v) =>
    v && typeof v === 'object' && 'toFixed' in (v as object)
      ? (v as { toString: () => string }).toString()
      : v
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
```

- [ ] **Step 6: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/resolveCorpScenario.test.ts backend/test/tax/scenarios/computeCorpScenario.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/resolveCorpScenario.ts backend/src/tax/scenarios/computeCorpScenario.ts backend/test/tax/scenarios/resolveCorpScenario.test.ts backend/test/tax/scenarios/computeCorpScenario.test.ts
git commit --message="feat(tax-scenarios): resolveCorpScenario + computeCorpScenario"
```

---

### Task 4: Corp scenario CRUD routes

**Files:**
- Create: `backend/src/routes/tax-corp-scenarios.ts`
- Modify: `backend/src/app.ts` (mount at `/api/tax/corp-scenarios`)
- Create: `backend/test/tax/routes-corp-scenarios.test.ts`

Mirror P7 T6's route file. Differences:
- Validates entity is `kind: 'corp'`
- Calls `ensureCorpBaselineScenario` instead of `ensureBaselineScenario`
- Validates overrides as `'corp'` kind
- `GET /:id` returns `computeCorpScenario(id)`

- [ ] **Step 1: Write the route + tests**

Copy `backend/src/routes/tax-personal-scenarios.ts` as starting point. Adapt:
- Path: `/api/tax/corp-scenarios`
- Entity kind validation: reject if `entity.kind !== 'corp'`
- Import `ensureCorpBaselineScenario` from `../tax/scenarios/resolveCorpScenario`
- Import `computeCorpScenario` from `../tax/scenarios/computeCorpScenario`
- Pass `'corp'` as the second arg to `validateOverrideMap` calls
- `GET /:id` and `POST /:id/compute` and `GET /compare` should call `computeCorpScenario`

For tests: copy `backend/test/tax/routes-personal-scenarios.test.ts`. Seed a corp entity instead of personal. Use corp override keys (`corp.activeIncome` instead of `income.employment`). Adjust assertions for corp totals shape (`netTaxPayable` instead of `totalPayable`).

Mount in `backend/src/app.ts`:

```ts
import corpScenariosRouter from './routes/tax-corp-scenarios';
app.use('/api/tax/corp-scenarios', corpScenariosRouter);
```

- [ ] **Step 2: Run tests + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/routes-corp-scenarios.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/routes/tax-corp-scenarios.ts backend/src/app.ts backend/test/tax/routes-corp-scenarios.test.ts
git commit --message="feat(tax-scenarios): corp scenarios CRUD + fork + compute + compare routes"
```

Expected: 9 tests pass (mirror of P7 T6's 9 tests).

---

### Task 5: Fork + compute + compare endpoints (corp)

**Files:**
- Modify: `backend/src/routes/tax-corp-scenarios.ts` (add 3 endpoints)
- Modify: `backend/test/tax/routes-corp-scenarios.test.ts` (add 4 tests)

If Task 4 included these from the personal route copy, skip Task 5 entirely. If Task 4 only did CRUD, add them now mirroring P7 T7.

Same rule applies: `GET /compare` must be registered BEFORE `GET /:id`.

After: 13 tests should pass (9 CRUD + 4 fork/compute/compare). Commit:

```bash
git commit --message="feat(tax-scenarios): corp fork/compute/compare endpoints"
```

---

### Task 6: `useCorpScenarios` + `useCorpScenarioDetail` hooks (frontend)

**Files:**
- Create: `frontend/src/hooks/useCorpScenarios.ts`
- Create: `frontend/src/hooks/useCorpScenarioDetail.ts`

Mirror `useScenarios` (P7 T8, commit `18fd472`) + `useScenarioDetail` (P7 T9, commit `3f44658`). Substitute `/api/tax/personal-scenarios` with `/api/tax/corp-scenarios` and the type names.

Use the project's `getJson`/`postJson`/`patchJson`/`deleteReq` helpers from `frontend/src/lib/api.ts`.

Commit:

```bash
git add frontend/src/hooks/useCorpScenarios.ts frontend/src/hooks/useCorpScenarioDetail.ts
git commit --message="feat(tax-scenarios): useCorpScenarios + useCorpScenarioDetail hooks"
```

---

### Task 7: Corp scenario tree + corp override editor + corp comparison

**Files:**
- Create: `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx`
- (`ScenarioTree` and `ComparisonView` are entity-kind agnostic from P7 — reuse as-is)

`CorpOverrideEditor.tsx` mirrors `OverrideEditor.tsx` (P7 T11, commit `51a5185`) but with the corp `KEY_DEFS` list:

```tsx
const KEY_DEFS: KeyDef[] = [
  { key: 'corp.activeIncome', label: 'Active business income (CAD)', inputType: 'decimal' },
  { key: 'corp.passiveInvestmentIncome', label: 'Passive investment income (CAD)', inputType: 'decimal' },
  { key: 'corp.aaiiTrailing', label: 'AAII trailing (for SBD grind)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidEligible', label: 'Eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidNonEligible', label: 'Non-eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.salaryPaid', label: 'Total T4 salary paid (CAD)', inputType: 'decimal' },
  { key: 'corp.openingGrip', label: 'Opening GRIP (CAD)', inputType: 'decimal' },
  { key: 'corp.openingCda', label: 'Opening CDA (CAD)', inputType: 'decimal' },
];
```

No array-input keys in P8a's corp registry, so the disposition sub-editor isn't needed; the file is simpler.

Commit:

```bash
git add frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx
git commit --message="feat(tax-scenarios): CorpOverrideEditor with corp key list"
```

---

### Task 8: Integrate scenario tree into CorpT2Tab

**Files:**
- Modify: `frontend/src/pages/tax/CorpT2Tab.tsx`

Mirror P7 T13's PersonalT1Tab integration. Steps:

1. Read current `CorpT2Tab.tsx` (~127 lines per investigation).
2. Resolve the corp entity via existing `useTaxEntities` hook.
3. Use `useCorpScenarios(corpEntity.id, fiscalYear)` for list, `useCorpScenarioDetail(activeId)` for detail.
4. Auto-bootstrap a "Scratch" fork on first view (POST to `/api/tax/corp-scenarios` triggers baseline auto-create + creates a starter fork).
5. Auto-select latest fork (or baseline) so detail pane has content.
6. Prune deleted IDs from compare set.
7. Layout: 2-col `flex-col md:flex-row` w/ tree on left, active scenario detail on right.
8. Detail panel uses existing `CorpTaxReturnDto` shape from `useCorpReturn` for line breakdown (the cache row's `lines` payload matches).
9. Embed `ScenarioTree` (reused from P7), `CorpOverrideEditor` (Task 7), `ComparisonView` (reused from P7, accepts any `ScenarioWithComputed[]` shape).

Lint + sanity check + commit:

```bash
yarn workspace frontend run lint
git add frontend/src/pages/tax/CorpT2Tab.tsx
git commit --message="feat(tax-scenarios): wire scenario tree + override editor into CorpT2Tab"
```

---

## Self-review checklist (engineer: run before opening PR)

- [ ] All 8 task commits land on the branch in order
- [ ] `yarn workspace cashflow-backend run test` passes (no regressions vs main)
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] Manual: open Corp T2 tab, baseline auto-created on first view of a year, fork → edit override → recompute → compare flow works
- [ ] No `Co-Authored-By` lines
- [ ] Legacy `POST /api/tax/scenarios` (single-shot owner-comp) NOT modified — Owner Comp tab still works
- [ ] `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx` key list matches `backend/src/tax/scenarios/corpOverrideKeys.ts`. P8b should move both registries to `shared/`

## Risks / out of scope

- **`corp.aaiiTrailing` override doesn't influence engine output yet:** P8a registers the key but `CorpTaxYearFacts.aaiiTrailing` isn't a real field in the type today. The override goes through `applyOverrides` fine, the engine just ignores it. P8b's integration math will read it. Document in the key's `label` / a comment.
- **Calendar-year only:** corp scenarios use `${year}-01-01` to `${year}-12-31` for `fiscalYear`. Corps with non-calendar fiscal years won't compute correctly. P8b will read `entity.fiscalYearEnd` if needed.
- **Override registry duplication frontend↔backend:** acceptable for v1, same as P7. P8b moves both to `shared/`.
- **HouseholdPlan integration + Owner Comp lever surface + legacy `runScenario.ts` removal — all P8b.**

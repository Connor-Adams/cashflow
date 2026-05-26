# Tax Multi-Year Scenarios (Phase P9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Safe-push pattern (mandatory):** push ALL implementation commits to origin BEFORE opening the PR. P7 and P8a both auto-merged on plan-only commits; their impl had to be re-PR'd. P8b proved the safe-push pattern works.

**Goal:** Chain scenarios across years. A scenario for year N can spawn a `projection_root` scenario for year N+1 whose base facts derive from year N's computed carryforwards (not actuals — those don't exist yet for future years). Existing `rollPersonalCarryforwards` + `rollCorpCarryforwards` services compute the next-year carryforward balances; new projection builders construct empty-actuals fact shells around those carryforwards plus assumption-driven income projections.

**Architecture:** The `scenarios` table already has `next_year_id` + `kind: 'projection_root'` + `assumptions` columns (P7 T1). P9 wires them up. New `projectPersonalFactsFromPrevYear` / `projectCorpFactsFromPrevYear` functions take a projection-root scenario, walk back to its parent year, compute that parent, roll carryforwards forward, and assemble a `TaxYearFacts` / `CorpTaxYearFacts` shell with: (a) zero actuals (no txns/slips), (b) carryforwards loaded from the roll-forward output, (c) projected income lines derived from prior year × `assumptions.inflation`. `resolveScenario` / `resolveCorpScenario` dispatch on `kind` — `baseline` → actuals (existing), `projection_root` → projection. New `/:id/project-next-year` endpoints create projection_root scenarios. New `/:id/chain` endpoint walks `next_year_id` forwards. Frontend gets a `YearStripNav` component (year nav strip + "Project next year" button) and an `AssumptionsEditor` for projection-root scenarios.

**Tech Stack:** TypeScript, Sequelize, Express, `node:test`, React + Vite. Decimal via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P9 row), section 6 (multi-year projection pseudocode), section 8.5 (year-strip UI).

**Builds on (already in main):**
- P7 `scenarios` table with `next_year_id`, `kind`, `assumptions` columns; `ensureBaselineScenario`, `resolveScenario`, `computeScenario`
- P8a corp equivalents (`resolveCorpScenario`, `computeCorpScenario`, `ensureCorpBaselineScenario`)
- Phase 4 services `rollPersonalCarryforwards` + `rollCorpCarryforwards` at `backend/src/tax/services/`
- P8b `HouseholdPlan` model (linked scenarios may live in plans; projection-root scenarios inherit the plan link from their parent)

**Out of scope:**
- Spouse splitting (P10), holdco (P11), lifetime modelling (P12)
- Per-line growth assumptions (uniform inflation across all income lines for v1)
- Year-N+2 chain (works structurally — `projectFromPrevYear` recurses through parent chain — but UI / tests focus on N+1 only)

**Conventions:** same as P6/P7/P8a/P8b:
- `node:test`, `beforeEach { sequelize.sync({force:true}) }`, **import models BEFORE sync**
- `npx tsx --import ./backend/test/setup.ts --test <path>` for isolated runs
- Decimal via `D` / `sumD` from `backend/src/tax/util/decimal`
- Conventional commits, `--message=` form, NEVER `Co-Authored-By`
- Each task ends with a commit
- `GET /compare` (or any literal segment) MUST register BEFORE `GET /:id` to avoid Express path-param shadowing

---

## File Structure

**Backend created:**
- `backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts`
- `backend/src/tax/scenarios/projectCorpFactsFromPrevYear.ts`
- Tests for each in `backend/test/tax/scenarios/`

**Backend modified:**
- `backend/src/tax/scenarios/resolveScenario.ts` — dispatch on `kind`: baseline → actuals (existing), projection_root → projection
- `backend/src/tax/scenarios/resolveCorpScenario.ts` — same
- `backend/src/routes/tax-personal-scenarios.ts` — add `POST /:id/project-next-year` + `GET /:id/chain`
- `backend/src/routes/tax-corp-scenarios.ts` — same
- Test files for both route files

**Frontend created:**
- `frontend/src/hooks/useScenarioChain.ts` — fetches chain for personal scenario
- `frontend/src/hooks/useCorpScenarioChain.ts` — same for corp
- `frontend/src/pages/tax/scenarios/YearStripNav.tsx` — year nav strip + project-next-year button
- `frontend/src/pages/tax/scenarios/AssumptionsEditor.tsx` — inflation + investmentReturn inputs for projection_root scenarios

**Frontend modified:**
- `frontend/src/pages/tax/PersonalT1Tab.tsx` — embed `YearStripNav` above scenario tree; if active scenario is projection_root, render `AssumptionsEditor` alongside `OverrideEditor`
- `frontend/src/pages/tax/CorpT2Tab.tsx` — same wiring

---

## Endpoint additions

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tax/personal-scenarios/:id/project-next-year` | Create a projection_root scenario for year+1 linked to `:id` via `next_year_id` |
| GET | `/api/tax/personal-scenarios/:id/chain` | Walk `next_year_id` forwards from `:id`'s root, return scenarios in year order |
| POST | `/api/tax/corp-scenarios/:id/project-next-year` | Corp variant |
| GET | `/api/tax/corp-scenarios/:id/chain` | Corp variant |

`POST /:id/project-next-year` body:
```jsonc
{
  "name": "Projected 2026",                                // optional; defaults to "Projection <year+1>"
  "assumptions": { "inflation": 0.025, "investmentReturn": 0.06 }  // optional; defaults to zero growth
}
```

Response: the created scenario.

`GET /:id/chain` response:
```jsonc
{
  "chain": [
    { "scenario": {...}, "computed": {...} },  // year N
    { "scenario": {...}, "computed": {...} },  // year N+1
    ...
  ]
}
```

---

## Task plan

### Task 1: `projectPersonalFactsFromPrevYear` function

**Files:**
- Create: `backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts`
- Create: `backend/test/tax/scenarios/projectPersonalFactsFromPrevYear.test.ts`

Takes a projection_root scenario id. Resolves its parent scenario (a year-N scenario), computes that scenario, runs `rollPersonalCarryforwards` to write the carryforward rows for `asOfYear = N`, then builds an empty-actuals `TaxYearFacts` for year N+1 where `buildPersonalFacts` would look up carryforwards keyed on `asOfYear = (N+1) - 1 = N` — which we just wrote.

Apply `assumptions.inflation` (default 0) by scaling prior year's income arrays: the projection seeds the year N+1 facts with prior year's income items multiplied by `(1 + inflation)`.

- [ ] **Step 1: Failing test**

```ts
// backend/test/tax/scenarios/projectPersonalFactsFromPrevYear.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { projectPersonalFactsFromPrevYear } from '../../../src/tax/scenarios/projectPersonalFactsFromPrevYear';
import { ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedPersonalWithEmployment() {
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

test('projects year+1 facts from year N actuals with zero inflation', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  assert.equal(facts.year, 2026);
  // Prior year had 80k employment; with inflation=0 (default) projection carries 80k.
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '80000.00');
});

test('applies inflation multiplier from assumptions', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  // 80000 × 1.025 = 82000
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '82000.00');
});

test('seeds carryforwards from prior year roll-forward', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  // RRSP room earned in 2025 (18% × $80k = $14,400 capped at annual limit) should appear in 2026 carryforwards.
  // The exact figure depends on rate table; assert non-zero.
  assert.ok(facts.carryforwards.rrspRoom.greaterThan(0), 'RRSP room should be projected from prior earned income');
});

test('rejects when parent is not a year-N scenario for the same entity', async () => {
  const household = await Household.create({ name: 'T' });
  const entityA = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'A',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const entityB = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'B',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const yearN = await ensureBaselineScenario(entityA.id, 2025);
  const orphan = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entityB.id, year: 2026, name: 'X', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => projectPersonalFactsFromPrevYear(orphan.id), /entity mismatch|same entity/i);
});

test('rejects when scenario kind is not projection_root', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  await assert.rejects(() => projectPersonalFactsFromPrevYear(yearN.id), /projection_root/i);
});
```

- [ ] **Step 2: Implementation**

```ts
// backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts
import { D } from '../util/decimal';
import { Scenario } from '../../models';
import { computeScenario } from './computeScenario';
import { resolveScenario } from './resolveScenario';
import { rollPersonalCarryforwards } from '../services/rollPersonalCarryforwards';
import { ratesFor } from '../engine/brackets';
import type { TaxYearFacts, IncomeItem, RrspContrib } from '../engine/types';

/**
 * Build a TaxYearFacts shell for a projection_root scenario.
 *
 * Algorithm:
 *   1. Validate scenario is kind='projection_root' with a parentId.
 *   2. Load parent scenario; require same entityId; require parent.year + 1 === this.year.
 *   3. Compute parent year (uses cache if available); resolve its facts.
 *   4. Run rollPersonalCarryforwards to upsert year-N carryforward rows.
 *   5. Build year-N+1 facts: empty actuals (no txns/slips for the future),
 *      carryforwards loaded from the rolled rows, income arrays seeded
 *      from prior year × (1 + inflation).
 */
export async function projectPersonalFactsFromPrevYear(
  scenarioId: number,
): Promise<TaxYearFacts> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);
  if (scenario.kind !== 'projection_root') {
    throw new Error(`projectPersonalFactsFromPrevYear requires kind='projection_root', got '${scenario.kind}'`);
  }
  if (scenario.parentId === null) {
    throw new Error(`projection_root scenario id=${scenarioId} must have a parent`);
  }

  const parent = await Scenario.findByPk(scenario.parentId);
  if (!parent) throw new Error(`parent scenario id=${scenario.parentId} not found`);
  if (parent.entityId !== scenario.entityId) {
    throw new Error(`projection_root entity mismatch: parent=${parent.entityId}, child=${scenario.entityId}`);
  }
  if (parent.year + 1 !== scenario.year) {
    throw new Error(`projection_root year ${scenario.year} must be parent year (${parent.year}) + 1`);
  }

  const parentFacts = await resolveScenario(parent.id);
  const parentReturn = await computeScenario(parent.id);
  const rates = ratesFor(parent.year);

  // Roll carryforwards so the DB has year-N balances queryable as asOfYear = N.
  // The buildPersonalFacts path queries asOfYear = year - 1 (i.e. N for the N+1 facts).
  await rollPersonalCarryforwards(
    parent.entityId,
    parent.year,
    {
      // computeScenario returns serialised totals/lines; rollPersonalCarryforwards
      // needs a TaxReturn-shape struct. Reconstruct only the fields it reads.
      year: parent.year,
      lines: parentReturn.lines as never,
      totals: {
        ...(parentReturn.totals as Record<string, unknown>),
      } as never,
      warnings: parentReturn.warnings,
    } as never,
    parentFacts,
    rates,
  );

  // Inflation multiplier
  const assumptions = scenario.assumptions as { inflation?: number };
  const inflationMult = D('1').plus(D(String(assumptions.inflation ?? 0)));

  function scaleItems(items: IncomeItem[], tag: string): IncomeItem[] {
    return items.map((item) => ({
      source: `projection:${tag}:${item.source}`,
      amount: item.amount.times(inflationMult),
      cadAmount: item.cadAmount.times(inflationMult),
    }));
  }
  function scaleRrsp(items: RrspContrib[]): RrspContrib[] {
    return items.map((item) => ({
      source: `projection:${item.source}`,
      amount: item.amount.times(inflationMult),
      date: item.date,
    }));
  }

  // Load freshly-rolled carryforwards via the standard builder path is overkill
  // (it would query txns/activity for next year which don't exist). Inline a
  // lean query — it just needs the carryforward shape.
  const { Carryforward, InstalmentPayment } = await import('../../models');
  const cfRows = await Carryforward.findAll({
    where: { entityId: scenario.entityId, asOfYear: parent.year },
  });
  const instRows = await InstalmentPayment.findAll({
    where: { entityId: scenario.entityId, year: scenario.year },
  });
  const carryforwards = {
    netCapitalLoss: D(cfRows.find(c => c.kind === 'cap_loss')?.amount ?? '0'),
    rrspRoom: D(cfRows.find(c => c.kind === 'rrsp_room')?.amount ?? '0'),
    nonCapLoss: D(cfRows.find(c => c.kind === 'non_cap_loss')?.amount ?? '0'),
    instalmentsPaid: instRows.length > 0
      ? instRows.reduce((sum, r) => sum.plus(D(r.amount as unknown as string)), D('0'))
      : D(cfRows.find(c => c.kind === 'instalments_paid')?.amount ?? '0'),
  };

  return {
    year: scenario.year,
    jurisdiction: parentFacts.jurisdiction,
    employmentIncome: scaleItems(parentFacts.employmentIncome, 'employment'),
    selfEmploymentIncome: scaleItems(parentFacts.selfEmploymentIncome, 'self-emp'),
    selfEmploymentExpenses: scaleItems(parentFacts.selfEmploymentExpenses, 'self-emp-exp'),
    interestIncome: scaleItems(parentFacts.interestIncome, 'interest'),
    eligibleDividends: scaleItems(parentFacts.eligibleDividends, 'eligible-div'),
    nonEligibleDividends: scaleItems(parentFacts.nonEligibleDividends, 'non-elig-div'),
    capitalGainEvents: [], // capital gains are realisation events; do not project forward by default
    rrspContribs: scaleRrsp(parentFacts.rrspContribs),
    fhsaContribs: scaleRrsp(parentFacts.fhsaContribs),
    donations: scaleItems(parentFacts.donations, 'donations'),
    slips: [], // future slips don't exist
    carryforwards,
    ageAtYearEnd: parentFacts.ageAtYearEnd + 1,
  };
}
```

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/projectPersonalFactsFromPrevYear.test.ts
yarn workspace cashflow-backend run typecheck
git add backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts backend/test/tax/scenarios/projectPersonalFactsFromPrevYear.test.ts
git commit --message="feat(tax-scenarios): projectPersonalFactsFromPrevYear for multi-year projections"
```

---

### Task 2: `projectCorpFactsFromPrevYear` function

Mirror of Task 1 for corp. Uses `computeCorpScenario` + `resolveCorpScenario` + `rollCorpCarryforwards` + builds `CorpTaxYearFacts` shell.

**Files:**
- Create: `backend/src/tax/scenarios/projectCorpFactsFromPrevYear.ts`
- Create: `backend/test/tax/scenarios/projectCorpFactsFromPrevYear.test.ts`

Same validation rules (kind='projection_root', parent year+1=this year, entity match). Apply inflation to corp income arrays (activeBusinessIncome, investmentIncome.{interest, eligibleDividends, nonEligibleDividends, rentNet}). Carryforwards loaded from `Carryforward` table where `kind ∈ {grip, cda, erdtoh, nerdtoh, non_cap_loss, cap_loss}` for `asOfYear = parent.year`. Capital gains events not projected forward.

Same structure as Task 1; 5 tests; commit:
```bash
git commit --message="feat(tax-scenarios): projectCorpFactsFromPrevYear for multi-year projections"
```

---

### Task 3: Dispatch on `kind` in `resolveScenario` + `resolveCorpScenario`

**Files:**
- Modify: `backend/src/tax/scenarios/resolveScenario.ts` — if root scenario's kind is 'projection_root', call `projectPersonalFactsFromPrevYear(root.id)` instead of `buildPersonalFacts(...)`
- Modify: `backend/src/tax/scenarios/resolveCorpScenario.ts` — same for corp
- Modify: `backend/test/tax/scenarios/resolveScenario.test.ts` — add test: resolving a fork whose root is projection_root layers overrides on top of projected facts
- Modify: `backend/test/tax/scenarios/resolveCorpScenario.test.ts` — same

Existing resolver code (sketch):
```ts
const root = ancestry[0];
const baseFacts = await buildPersonalFacts(root.entityId, root.year);
```

Change to:
```ts
const root = ancestry[0];
const baseFacts = root.kind === 'projection_root'
  ? await projectPersonalFactsFromPrevYear(root.id)
  : await buildPersonalFacts(root.entityId, root.year);
```

Add a new test:
```ts
test('resolveScenario(fork on projection_root) layers overrides on projected facts', async () => {
  const { entity } = await seedPersonalWithEmployment(); // seed helper as above
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1Root = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const fork = await Scenario.create({
    parentId: yearN1Root.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'High salary 2026', kind: 'fork',
    overrides: { 'income.employment': 100000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork.id);
  // override wins, replaces inflated 82k with 100k
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '100000.00');
});
```

Commit:
```bash
git commit --message="feat(tax-scenarios): resolver dispatches on kind for projection_root"
```

---

### Task 4: Project-next-year endpoints (personal + corp)

**Files:**
- Modify: `backend/src/routes/tax-personal-scenarios.ts` — add `POST /:id/project-next-year`
- Modify: `backend/src/routes/tax-corp-scenarios.ts` — same
- Modify: both route test files — add tests

`POST /:id/project-next-year` handler logic:
1. `loadAndAuthorize(:id)` (existing helper)
2. Reject if scenario kind is `projection_root` (avoid double projection in one step) — return 400
3. Reject if a projection_root already exists for next year + same entity — return 409
4. Create new Scenario: `parentId = :id`, `entityId = same`, `year = scenario.year + 1`, `name = body.name ?? "Projection ${year+1}"`, `kind = 'projection_root'`, `overrides: {}`, `assumptions = body.assumptions ?? {}`, `householdPlanId = scenario.householdPlanId` (inherit), `nextYearId: null`
5. Set parent's `nextYearId = newScenario.id` to link the chain
6. Return `{ scenario: newScenario }`

Tests per route:
- POST creates a projection_root for year+1
- Idempotency: second POST returns 409 (or 200 with existing — pick one and document; I recommend 409)
- POST with assumptions persists them
- POST inherits householdPlanId from parent
- Unauth 401, cross-household 403

Register the new route BEFORE `GET /:id` if it has any GET sibling… in this case it's `POST` so order doesn't matter for path-param shadowing, but place it near the existing `/:id/fork` for cohesion.

Commit:
```bash
git commit --message="feat(tax-scenarios): POST /:id/project-next-year on personal + corp scenario routes"
```

---

### Task 5: Chain endpoint (personal + corp)

**Files:**
- Modify: `backend/src/routes/tax-personal-scenarios.ts` — add `GET /:id/chain`
- Modify: `backend/src/routes/tax-corp-scenarios.ts` — same
- Test files

Handler logic:
1. Load scenario `:id`, authorise
2. Walk backwards via `parentId` to find the earliest ancestor (the year-N root) — actually no, simpler: walk to the original baseline at year N, then walk FORWARDS via `next_year_id`
3. Build the chain: `[{scenario, computed}, {scenario, computed}, ...]` in year order
4. Use `computeScenario` / `computeCorpScenario` for each (uses cache or projection path automatically via Task 3 dispatch)

`GET /:id/chain` must register BEFORE `GET /:id` because `chain` is a literal segment that would otherwise match the `:id` param.

Tests per route:
- Returns single entry when no next_year_id
- Returns 2 entries when /project-next-year was called once
- Returns 3 entries when called twice (year+2 chain)
- Returns scenarios in year order
- Unauth 401, cross-household 403

Commit:
```bash
git commit --message="feat(tax-scenarios): GET /:id/chain endpoint walks next_year_id"
```

---

### Task 6: Frontend chain hooks

**Files:**
- Create: `frontend/src/hooks/useScenarioChain.ts` — `useScenarioChain(personalScenarioId | null)`
- Create: `frontend/src/hooks/useCorpScenarioChain.ts` — `useCorpScenarioChain(corpScenarioId | null)`

Both follow the existing hook pattern (`getJson` from `@/lib/api`, cancelled flag, `useCallback` reload).

Return shape: `{ data: ChainEntry[] | null, loading, error, reload }` where `ChainEntry = { scenario, computed }`.

Endpoints: `GET /api/tax/personal-scenarios/:id/chain` / `GET /api/tax/corp-scenarios/:id/chain`.

Commit:
```bash
git commit --message="feat(tax-scenarios): useScenarioChain + useCorpScenarioChain hooks"
```

---

### Task 7: `YearStripNav` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/YearStripNav.tsx`

Props:
```tsx
interface Props {
  entityId: number;
  activeYear: number;
  activeScenarioId: number | null;
  chain: Array<{ scenario: { id: number; year: number; kind: string; name: string }; computed?: unknown }>;
  onSelectYear: (year: number, scenarioId: number) => void;
  onProjectNextYear: () => void;  // callback that invokes the POST /:id/project-next-year mutation
  isProjecting: boolean;
}
```

Renders a horizontal strip: `‹ 2024 │ 2025 ▶ │ 2026 ›` with the active year highlighted. Each year in the chain is a clickable button. Plus a `+ Project next year` button at the right end (disabled while `isProjecting`).

Project-next-year: the parent component owns the mutation (`useScenarios.fork`-style call via a new `useScenarios.projectNextYear(id)` method — Task 6 hook needs this). For v1 the parent can just call `fetch('/api/tax/personal-scenarios/:id/project-next-year', {method: 'POST', ...})` directly.

Commit:
```bash
git commit --message="feat(tax-scenarios): YearStripNav component"
```

---

### Task 8: `AssumptionsEditor` component

**Files:**
- Create: `frontend/src/pages/tax/scenarios/AssumptionsEditor.tsx`

Props:
```tsx
interface Props {
  assumptions: { inflation?: number; investmentReturn?: number };
  onChange: (next: { inflation?: number; investmentReturn?: number }) => void;
}
```

Two numeric inputs (inflation, investmentReturn) shown as percentages (display value × 100, divide on input). Save via debounced parent-side `patch({assumptions})` call.

Only rendered when the active scenario's kind is `projection_root`.

Commit:
```bash
git commit --message="feat(tax-scenarios): AssumptionsEditor for projection_root scenarios"
```

---

### Task 9: Wire into PersonalT1Tab

**Files:**
- Modify: `frontend/src/pages/tax/PersonalT1Tab.tsx`

Read current file first. Then:
1. Resolve active scenario (existing `useScenarioDetail`)
2. Add `useScenarioChain(activeScenarioId)` to get the year chain
3. Render `<YearStripNav>` above the scenario tree
4. When the active scenario's kind is `projection_root`, render `<AssumptionsEditor>` alongside the `<OverrideEditor>`
5. `onProjectNextYear` calls `POST /api/tax/personal-scenarios/:id/project-next-year`; on success, reloads scenarios + chain + selects the new scenario

Commit:
```bash
git commit --message="feat(tax-scenarios): wire YearStripNav + AssumptionsEditor into PersonalT1Tab"
```

---

### Task 10: Wire into CorpT2Tab

Same as Task 9 for corp side. Modify `frontend/src/pages/tax/CorpT2Tab.tsx`. Use `useCorpScenarioChain` + `useCorpScenarios.projectNextYear` (or direct fetch). Render `<YearStripNav>` + `<AssumptionsEditor>` on projection_root scenarios.

Commit:
```bash
git commit --message="feat(tax-scenarios): wire YearStripNav + AssumptionsEditor into CorpT2Tab"
```

---

### Task 11: End-to-end integration test

**Files:**
- Create: `backend/test/tax/scenarios/multiYearE2E.test.ts`

Higher-level test covering the full P9 flow:
1. Seed personal entity with year 2025 income
2. Create baseline scenario for 2025
3. POST /project-next-year → creates 2026 projection_root
4. Verify chain endpoint returns both scenarios
5. POST /project-next-year on 2026 → creates 2027 projection_root chained off 2026
6. Verify chain returns 3 scenarios in year order
7. Compute 2027 scenario → succeeds, RRSP room rolled twice, ageAtYearEnd is +2 from baseline
8. Fork 2026 with override → projection still works (Task 3 dispatch covers this)

Commit:
```bash
git commit --message="test(tax-scenarios): multi-year E2E covering year+2 chain"
```

---

## Pre-PR safe-push checklist

- [ ] All 11 task commits in branch (+ 1 plan commit)
- [ ] `yarn workspace cashflow-backend run test` passes (no regressions vs main)
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` ALL commits to origin BEFORE creating the PR**
- [ ] Only THEN open PR with `gh pr create` + enable auto-merge

## Risks / out of scope

- **Inflation applied uniformly across all income lines:** real-world salaries grow differently from investment returns. Per-line growth assumptions deferred.
- **Capital gains not projected forward:** they're realisation events; a 2026 projection has zero `capitalGainEvents` by default. User can add via `capgains.dispositions` override on the projection-root scenario.
- **Carryforward roll requires parent to be computed first:** `projectPersonalFactsFromPrevYear` triggers `computeScenario(parent)` which is cached; should be cheap on repeat. Document the cache dependency.
- **No projection on baseline scenarios that have multi-year chains broken by mid-chain deletion:** if user deletes a year-N+1 scenario in the middle of a chain, the year-N+2 scenario's parent link is broken. POST /:id/project-next-year requires walking parentId, so it fails cleanly. UI should hide the next-year nav for orphaned scenarios.
- **HouseholdPlan integration with projected years:** if a HouseholdPlan groups year-N personal + corp scenarios, projecting both to year N+1 creates two new scenarios that inherit `householdPlanId` from their parents. The plan automatically gains year N+1 too. `computeHouseholdPlan` would then return per-year bundles. P9 ships single-year compute; multi-year plan compute may want its own task in P9.x or P10.

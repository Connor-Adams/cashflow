# Corp dividend auto-flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A corp's recorded dividends (its `ShareholderLoan` `dividend_credit` ledger) auto-flow to its declared owner's personal T1 through the existing `integrationRouter`, with manual `ownerComp` overrides winning.

**Architecture:** Add `Entity.ownerEntityId` (corp → personal shareholder). In `computeHouseholdPlan`, synthesize an `OwnerCompPlan` for that shareholder from the corp's `dividendsPaid` facts when no manual `ownerComp.<ownerId>.*` override exists; the existing router/injection do the rest. No new dividend path.

**Tech Stack:** TypeScript, Sequelize (Postgres prod / SQLite tests via `sequelize.sync`), Express, sequelize-cli migrations, `node:test` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-06-01-corp-dividend-autoflow-design.md`

**Environment notes:**
- Backend unit tests: `cd backend && npx tsx --import ./test/setup.ts --test <file>` (use `sequelize.sync`, so model fields — not migrations — make columns exist in tests).
- Commit with `git commit --no-verify` (husky `lint-staged` not installed in the worktree). Connor sole author — no co-author trailer.
- Migration filenames must sort AFTER the latest existing (`20260615000001-*`). Use `20260616000001`.
- After each task: `cd backend && npx tsc --noEmit` — no new errors (one pre-existing `moduleResolution=node10` deprecation is fine). Editor/LSP cross-file errors can be stale — trust `tsc`.

---

### Task 1: `Entity.ownerEntityId` field + migration

**Files:**
- Modify: `backend/src/models/Entity.ts` (class field ~line 23; init column ~line 47, mirror `spouseEntityId`)
- Create: `backend/src/migrations/20260616000001-add-owner-entity-id.js`
- Test: `backend/test/tax/ownerEntityId.model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/ownerEntityId.model.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Entity, Household } from '../../src/models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('Entity.ownerEntityId defaults null and is settable', async () => {
  const hh = await Household.create({ name: 'O' });
  const personal = await Entity.create({
    householdId: hh.id, kind: 'personal', legalName: 'Me', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corp = await Entity.create({
    householdId: hh.id, kind: 'corp', legalName: 'Co', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  assert.equal(corp.ownerEntityId, null, 'defaults null');
  await corp.update({ ownerEntityId: personal.id });
  assert.equal(corp.ownerEntityId, personal.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/ownerEntityId.model.test.ts`
Expected: FAIL — `ownerEntityId` undefined (column not on model).

- [ ] **Step 3: Add the model field**

In `backend/src/models/Entity.ts`, add the class field after `spouseEntityId` (~line 23):

```ts
  declare ownerEntityId: number | null;
```

In `Entity.init({...})` after the `spouseEntityId` column (~line 51):

```ts
      ownerEntityId: {
        type: DataTypes.INTEGER,
        field: 'owner_entity_id',
        allowNull: true,
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/ownerEntityId.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the migration**

Create `backend/src/migrations/20260616000001-add-owner-entity-id.js`:

```js
'use strict';
/** Corp -> owner (personal shareholder) link, drives dividend auto-flow to the
 * owner's T1 in computeHouseholdPlan. See
 * docs/superpowers/specs/2026-06-01-corp-dividend-autoflow-design.md */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'owner_entity_id', {
      type: Sequelize.INTEGER, allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('tax_entities', 'owner_entity_id');
  },
};
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/Entity.ts backend/src/migrations/20260616000001-add-owner-entity-id.js backend/test/tax/ownerEntityId.model.test.ts
git commit --no-verify -m "feat(tax): add Entity.ownerEntityId (corp -> personal shareholder)"
```

---

### Task 2: `PATCH /entities/:id` accepts `ownerEntityId`

**Files:**
- Modify: `backend/src/routes/tax.ts:38-96` (the `PATCH /entities/:id` handler)
- Test: `backend/test/tax/routes-entity-patch.test.ts` (append, follow existing pattern)

The current handler only accepts `associatedGroupId` and 400s if it's absent. Relax to accept `associatedGroupId` and/or `ownerEntityId`.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/tax/routes-entity-patch.test.ts` (mirror its existing auth/setup; it already exercises `PATCH /api/tax/entities/:id`). Seed a corp + a personal entity in the same household, then:

```ts
test('PATCH /entities/:id sets ownerEntityId to a personal entity; rejects non-personal target', async () => {
  // corpId, personalId, corp2Id seeded for the authed household (reuse the file's helpers)
  const ok = await agent
    .patch(`/api/tax/entities/${corpId}`)
    .send({ ownerEntityId: personalId })
    .expect(200);
  assert.equal(ok.body.entity.ownerEntityId, personalId);

  // target must be kind=personal
  await agent
    .patch(`/api/tax/entities/${corpId}`)
    .send({ ownerEntityId: corp2Id })
    .expect(400);

  // clear
  const cleared = await agent
    .patch(`/api/tax/entities/${corpId}`)
    .send({ ownerEntityId: null })
    .expect(200);
  assert.equal(cleared.body.entity.ownerEntityId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-entity-patch.test.ts`
Expected: FAIL — `ownerEntityId` ignored (handler only reads `associatedGroupId`; an `ownerEntityId`-only body 400s as "associatedGroupId required").

- [ ] **Step 3: Implement**

Replace the body-parsing + update portion of the handler (`backend/src/routes/tax.ts`, lines ~47-92) so it accepts either field. Full replacement for that region:

```ts
    const body = (req.body ?? {}) as { associatedGroupId?: unknown; ownerEntityId?: unknown };
    const hasGroup = Object.prototype.hasOwnProperty.call(body, 'associatedGroupId');
    const hasOwner = Object.prototype.hasOwnProperty.call(body, 'ownerEntityId');
    if (!hasGroup && !hasOwner) {
      res.status(400).json({
        error: 'invalid_body',
        message: 'associatedGroupId or ownerEntityId required',
      });
      return;
    }

    const entity = await Entity.findByPk(entityId);
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    if (entity.householdId !== household.id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (entity.kind !== 'corp') {
      res.status(400).json({
        error: 'invalid_kind',
        message: 'associatedGroupId / ownerEntityId can only be set on kind=corp entities',
      });
      return;
    }

    const patch: { associatedGroupId?: string | null; ownerEntityId?: number | null } = {};

    if (hasGroup) {
      const raw = body.associatedGroupId;
      if (raw === null) {
        patch.associatedGroupId = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        patch.associatedGroupId = trimmed === '' ? null : trimmed;
      } else {
        res.status(400).json({ error: 'invalid_body', message: 'associatedGroupId must be a string or null' });
        return;
      }
    }

    if (hasOwner) {
      const raw = body.ownerEntityId;
      if (raw === null) {
        patch.ownerEntityId = null;
      } else if (Number.isInteger(raw)) {
        const target = await Entity.findByPk(raw as number);
        if (!target || target.householdId !== household.id) {
          res.status(400).json({ error: 'invalid_owner', message: 'ownerEntityId must be an entity in this household' });
          return;
        }
        if (target.kind !== 'personal') {
          res.status(400).json({ error: 'invalid_owner', message: 'ownerEntityId must be a personal entity' });
          return;
        }
        patch.ownerEntityId = raw as number;
      } else {
        res.status(400).json({ error: 'invalid_body', message: 'ownerEntityId must be an integer or null' });
        return;
      }
    }

    await entity.update(patch);
    res.status(200).json({ entity });
```

(Keep the surrounding `try` / `entityId` parsing / `catch` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-entity-patch.test.ts`
Expected: PASS (new test + existing entity-patch tests, incl. associatedGroupId behavior).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-entity-patch.test.ts
git commit --no-verify -m "feat(tax): PATCH /entities/:id accepts ownerEntityId (validated personal, same household)"
```

---

### Task 3: Derive owner dividends from the corp ledger in `computeHouseholdPlan`

**Files:**
- Modify: `backend/src/tax/scenarios/computeHouseholdPlan.ts` (`buildRouterInputs` ~line 124; its call site ~line 458; `sumD` import ~line 3)
- Test: `backend/test/tax/scenarios/computeHouseholdPlan.test.ts` (append; mirror the file's existing plan/scenario seeding)

**Context:** `buildRouterInputs(corp)` builds `OwnerCompPlan[]` from `ownerComp.*` override keys only. We extend it to also append a derived plan from the corp's `dividendsPaid` facts when the corp has an `ownerEntityId` and no manual ownerComp plan exists for that owner. `OwnerCompPlan` shape (from `ownerCompPlansForCorp`): `{ corpScenarioId, shareholderEntityId, salary, bonus, eligibleDividend, nonEligibleDividend, capitalDividend }` (all `Decimal`). The corp's resolved facts (with `dividendsPaid: CorpDividendPaid[]`, each `{ amount: Decimal, kind: 'eligible'|'non_eligible' }`) are in `corpBaseFactsByScenarioId`; `entityById` holds the corp `Entity` (with `ownerEntityId`).

- [ ] **Step 1: Write the failing test**

Append to `backend/test/tax/scenarios/computeHouseholdPlan.test.ts`, mirroring the file's existing seeding (it already creates a `HouseholdPlan`, corp + personal `Entity` + `Scenario`s linked via `householdPlanId`, and computes the plan). Add a corp with `ownerEntityId` set to the personal entity and two `ShareholderLoan` `dividend_credit` rows, no `ownerComp` override:

```ts
test('corp dividend ledger auto-flows to the owner T1 (non-eligible)', async () => {
  // Seed (reuse the file's helpers/pattern):
  //  - household, personal entity P, corp entity C with C.ownerEntityId = P.id
  //  - HouseholdPlan; a corp Scenario (C) and personal Scenario (P) both with householdPlanId = plan.id
  //  - ShareholderLoan { entityId: C.id, kind: 'dividend_credit', amount: '20000.0000', date: '<in corp FY>' }
  //    and another '3000.0000'
  //  - NO ownerComp.* override on the corp scenario
  const result = await computeHouseholdPlan(plan.id);
  const personal = result.personal.find((p) => p.scenario.entityId === P.id)!;
  // L12010 (taxable non-eligible dividends) > 0 — the $23,000 ledger flowed in, grossed up.
  const l12010 = (personal.computed.lines as Array<{ code: string; amount: string }>)
    .find((l) => l.code === 'L12010');
  assert.ok(l12010 && Number(l12010.amount) > 0, 'non-eligible dividends present on owner T1');
});

test('manual ownerComp override wins over the dividend ledger', async () => {
  // Same as above but the corp scenario has override key
  //   `ownerComp.${P.id}.nonEligibleDividend` = 5000
  // Assert the routed non-eligible actual (pre-gross-up) reflects 5000, not 23000
  // (check result.integration.byShareholder[P.id].nonEligibleDividends === '5000' style,
  //  per the integration output shape used elsewhere in this test file).
});
```

(Fill the seeding from the file's existing tests; keep the assertions above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/scenarios/computeHouseholdPlan.test.ts`
Expected: FAIL — first test: no L12010 (ledger not routed); second test passes trivially only if override already worked (it does), so focus the red on the first.

- [ ] **Step 3: Implement the derivation**

3a. Add `sumD` to the decimal import in `computeHouseholdPlan.ts` (line 3):

```ts
import { D, sumD, type Decimal } from '../util/decimal';
```

3b. Change `buildRouterInputs` (~line 124) to accept the facts map + entity map and append derived plans:

```ts
function buildRouterInputs(
  corp: CorpResult[],
  corpBaseFactsByScenarioId: Map<number, CorpTaxYearFacts>,
  entityById: Map<number, Entity>,
): { ownerCompPlans: OwnerCompPlan[]; corpReturns: CorpReturnSummary[] } {
  const ownerCompPlans: OwnerCompPlan[] = [];
  const corpReturns: CorpReturnSummary[] = [];
  for (const { scenario, computed } of corp) {
    const totals = computed.totals as Record<string, unknown>;
    corpReturns.push({
      corpScenarioId: scenario.id,
      gripEnding: D(String(totals.gripEnding ?? '0')),
      cdaEnding: D(String(totals.cdaEnding ?? '0')),
      retainedEarningsAfter: D('0'),
    });
    const manualPlans = ownerCompPlansForCorp(scenario, scenario.overrides as Record<string, unknown>);
    ownerCompPlans.push(...manualPlans);

    // Derive a plan from the corp's actual dividend ledger when an owner is
    // linked and no manual ownerComp plan already covers that shareholder.
    const ownerId = entityById.get(scenario.entityId)?.ownerEntityId ?? null;
    if (ownerId != null && !manualPlans.some((p) => p.shareholderEntityId === ownerId)) {
      const facts = corpBaseFactsByScenarioId.get(scenario.id);
      if (facts) {
        const eligibleDividend = sumD(
          facts.dividendsPaid.filter((d) => d.kind === 'eligible').map((d) => d.amount),
        );
        const nonEligibleDividend = sumD(
          facts.dividendsPaid.filter((d) => d.kind === 'non_eligible').map((d) => d.amount),
        );
        if (eligibleDividend.greaterThan(0) || nonEligibleDividend.greaterThan(0)) {
          ownerCompPlans.push({
            corpScenarioId: scenario.id,
            shareholderEntityId: ownerId,
            salary: D(0),
            bonus: D(0),
            eligibleDividend,
            nonEligibleDividend,
            capitalDividend: D(0),
          });
        }
      }
    }
  }
  return { ownerCompPlans, corpReturns };
}
```

3c. Update the call site (~line 458):

```ts
  const integration = integrationRouter(
    buildRouterInputs(corp, corpBaseFactsByScenarioId, entityById),
  );
```

`Entity` is already imported in this file (line 2); `CorpTaxYearFacts` is imported (line 30).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/scenarios/computeHouseholdPlan.test.ts`
Expected: PASS (new tests + all existing household-plan tests).

- [ ] **Step 5: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/tax/scenarios/computeHouseholdPlan.ts backend/test/tax/scenarios/computeHouseholdPlan.test.ts
git commit --no-verify -m "feat(tax): auto-route corp dividend ledger to owner T1 (override wins)"
```

---

### Task 4: Full verification + PR

- [ ] **Step 1: Run the tax suites**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/*.test.ts test/tax/scenarios/*.test.ts`
Expected: PASS for the touched suites. Pre-existing failures unrelated to this change (e.g. `routes*.test.ts` needing `sequelize-cli`) are environmental — note, don't treat as regressions.

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: only the pre-existing `moduleResolution=node10` deprecation.

- [ ] **Step 3: Open PR**

Push `claude/corp-dividend-autoflow`; open a PR against `main`; enable auto-merge (`gh pr merge --auto --merge --delete-branch`). Body: summarize that this feeds the existing `integrationRouter` from the corp dividend ledger via a new `Entity.ownerEntityId`, override-wins, non-eligible default; note the post-deploy wiring (link scenarios, set `ownerEntityId`, record dividend_credit rows) is config, not code.

- [ ] **Step 4 (post-deploy, separate, with Connor's sign-off): wire the real data**

Not part of the code PR. After deploy: link CDG Labs (entity 2) + personal (entity 1) scenarios to "Main plan" (id 2), set entity 2 `ownerEntityId = 1`, record Connor's dividend draws as `dividend_credit` `ShareholderLoan` rows on entity 2, then recompute the plan to confirm dividends appear on the personal T1.

# Tax Holdco — Intercorp Dividend Routing (Phase P11a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Safe-push pattern (mandatory):** push ALL implementation commits to origin BEFORE opening the PR. Proven by P8b/P9/P10.

**Goal:** Route dividends from one corp scenario to another corp scenario within the same HouseholdPlan. Enables opco → holdco dividend flow modelling. Existing T2 engine already handles Part IV on received dividends (38.33% on eligible / 30.67% on non-eligible, routed to ERDTOH / NERDTOH) — P11a just adds the routing layer.

**Architecture:** New dynamic prefix-matched corp override keys `intercorp.<receiverCorpId>.eligible|nonEligible|capital` (mirror of P8b's `ownerComp.<id>.<field>` shape). New pure `intercorpRouter` function — extracts these from corp scenarios' overrides, emits per-receiver-corp additions to `investmentIncome.{eligibleDividends,nonEligibleDividends}` (and a capital-div tracker). `computeHouseholdPlan` extended to run `intercorpRouter` BEFORE corp computes — topo order: route divs first → compute all corps with injected received divs → integrationRouter (existing) → spouseRouter (existing) → personals.

**Tech Stack:** TypeScript, Sequelize, Express, `node:test`, React + Vite. Decimal via `decimal.js`-backed `D()`.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P11 row, partial).

**Builds on (in main):**
- P7 personal scenario tree
- P8a corp scenarios + corp override registry + corp resolver/compute
- P8b HouseholdPlan + integrationRouter + computeHouseholdPlan
- Existing P3 corp engine `backend/src/tax/engine/integration.ts` already computes ERDTOH/NERDTOH additions on received dividends — no engine changes needed for v1

**Out of scope (defer to P11b):**
- Associated-corp grouping (shared $500k SBD + $50k AAII threshold across group)
- Connected (>10% ownership) vs portfolio dividend distinction — both currently treated identically (Part IV applies to all received divs); refund-on-payment refinement deferred
- GRIP/CDA designation flow (eligible div from opco GRIP → recipient GRIP)
- Cross-corp loss utilisation / transfer

**Conventions:** node:test, beforeEach sync, import models BEFORE sync, conventional commits, `--message=` form, NEVER `Co-Authored-By`, each task = one commit. `HUSKY=0 git commit ...` if husky-in-worktree hook fails (known issue per P10 notes).

---

## File Structure

**Backend created:**
- `backend/src/tax/scenarios/intercorpRouter.ts`
- `backend/test/tax/scenarios/intercorpRouter.test.ts`

**Backend modified:**
- `backend/src/tax/scenarios/overrideKeys.ts` — add dynamic prefix matcher for `intercorp.<corpId>.<field>` keys (mirror of existing `ownerComp.<id>.<field>` pattern)
- `backend/src/tax/scenarios/computeHouseholdPlan.ts` — invoke `intercorpRouter` BEFORE corp compute loop; inject received divs into corp facts
- `backend/test/tax/scenarios/computeHouseholdPlan.test.ts` — add ≥1 test exercising intercorp dividend flow

**Frontend modified:**
- `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx` — extend KEY_DEFS w/ a "linked corp recipient" picker for intercorp dividend distribution. UI thinking: a `<select>` of other corp entities in the plan, then 3 numeric inputs (eligible/nonEligible/capital). Engineer judges shape during implementation.

**Frontend optional (small):**
- `frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx` — display "holdco detected" annotation when intercorp links are present in plan compute output

---

## Override key shape

Pattern follows `ownerComp.<id>.<field>` (P8b T3):

```ts
// Dynamic regex-matched keys on corp scenarios:
'intercorp.<receiverCorpEntityId>.eligible'    : Decimal
'intercorp.<receiverCorpEntityId>.nonEligible' : Decimal
'intercorp.<receiverCorpEntityId>.capital'     : Decimal
```

Where `<receiverCorpEntityId>` is the integer `Entity.id` of the recipient corp (must also be in same household; router validates).

---

## Task plan

### Task 1: Dynamic `intercorp.<corpId>.<field>` override keys

**Files:**
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — add `INTERCORP_RE` regex + `intercorpEntryFor()` helper mirroring `ownerCompEntryFor()` from P8b T3
- Create: `backend/test/tax/scenarios/intercorpKeys.test.ts` — 5 tests (registry recognition, kind=corp, malformed-key error, apply correctness, cross-kind rejection)

Apply function stamps onto a structured `intercorp` map on corp facts so the router can read it: `corp.intercorp[receiverCorpId][field] = Decimal`.

Pattern (mirror of `ownerCompEntryFor` in same file):

```ts
const INTERCORP_RE = /^intercorp\.(\d+)\.(eligible|nonEligible|capital)$/;

function intercorpEntryFor(key: string): OverrideKeyDef | undefined {
  const m = key.match(INTERCORP_RE);
  if (!m) return undefined;
  const receiverId = m[1];
  const field = m[2];
  return {
    kind: 'corp',
    key,
    label: `Intercorp · ${field} dividend → corp ${receiverId} (CAD)`,
    inputType: 'decimal',
    validate: (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${key}: expected a finite number`);
      }
    },
    apply: (facts, value) => {
      if (typeof value !== 'number') throw new Error(`${key}: expected number`);
      const corp = facts as unknown as Record<string, unknown> & {
        intercorp?: Record<string, Record<string, ReturnType<typeof D>>>;
      };
      const next = { ...corp };
      const existing = (next.intercorp ?? {}) as Record<string, Record<string, unknown>>;
      const forReceiver = { ...(existing[receiverId] ?? {}) };
      forReceiver[field] = D(String(value));
      next.intercorp = { ...existing, [receiverId]: forReceiver };
      return next as unknown as typeof facts;
    },
  };
}
```

Extend `getOverrideKey` to fall back to `intercorpEntryFor(key) ?? ownerCompEntryFor(key)`. Extend `validateOverrideMap` to surface "invalid intercorp key shape" for malformed `intercorp.*` keys.

Tests (5):
1. `validateOverrideMap` accepts `intercorp.7.eligible` on corp scenario
2. Rejects on personal scenario (cross-kind)
3. Malformed `intercorp.7.unknownField` → "invalid intercorp key shape" error
4. `getOverrideKey` returns synthetic def with kind=corp
5. Apply: stamps onto `corp.intercorp[receiverId][field]` map

Run: `npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/intercorpKeys.test.ts backend/test/tax/scenarios/overrideKeys.test.ts`

Commit: `feat(tax-scenarios): dynamic intercorp.<corpId>.<field> override keys`

---

### Task 2: `intercorpRouter` pure function

**Files:**
- Create: `backend/src/tax/scenarios/intercorpRouter.ts`
- Create: `backend/test/tax/scenarios/intercorpRouter.test.ts`

Pure (no DB, no async). Inputs: corp scenarios with their `intercorp.*` distribution overrides + the set of corp entityIds in the plan. Outputs: per-receiver-corp additions to investmentIncome arrays + warnings (e.g., receiver corp not in plan).

```ts
// backend/src/tax/scenarios/intercorpRouter.ts
import { D } from '../util/decimal';
import type { Decimal } from '../util/decimal';
import type { IncomeItem } from '../engine/types';

export interface IntercorpDistribution {
  payerCorpScenarioId: number;
  payerCorpEntityId: number;
  receiverCorpEntityId: number;
  eligible: Decimal;
  nonEligible: Decimal;
  capital: Decimal;
}

export interface IntercorpDistributionInputs {
  distributions: IntercorpDistribution[];
  /** Set of corp entity IDs that have a scenario in this plan; receivers not in this set warn. */
  corpEntityIdsInPlan: Set<number>;
}

export interface CorpReceivedDivs {
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  /** Capital divs are tax-free; tracked separately for UI display only. */
  capitalDividends: IncomeItem[];
}

export interface IntercorpRouterWarning {
  severity: 'warning' | 'error';
  payerCorpScenarioId: number;
  receiverCorpEntityId: number;
  message: string;
}

export interface IntercorpRouterOutput {
  byReceiverEntityId: Record<number, CorpReceivedDivs>;
  warnings: IntercorpRouterWarning[];
}

export function intercorpRouter(inputs: IntercorpDistributionInputs): IntercorpRouterOutput {
  const byReceiverEntityId: Record<number, CorpReceivedDivs> = {};
  const warnings: IntercorpRouterWarning[] = [];

  function init(receiverId: number): CorpReceivedDivs {
    if (!byReceiverEntityId[receiverId]) {
      byReceiverEntityId[receiverId] = { eligibleDividends: [], nonEligibleDividends: [], capitalDividends: [] };
    }
    return byReceiverEntityId[receiverId];
  }

  for (const dist of inputs.distributions) {
    if (!inputs.corpEntityIdsInPlan.has(dist.receiverCorpEntityId)) {
      warnings.push({
        severity: 'warning',
        payerCorpScenarioId: dist.payerCorpScenarioId,
        receiverCorpEntityId: dist.receiverCorpEntityId,
        message: `receiver corp entity ${dist.receiverCorpEntityId} has no scenario in this plan — intercorp dividend ignored`,
      });
      continue;
    }
    if (dist.payerCorpEntityId === dist.receiverCorpEntityId) {
      warnings.push({
        severity: 'error',
        payerCorpScenarioId: dist.payerCorpScenarioId,
        receiverCorpEntityId: dist.receiverCorpEntityId,
        message: `corp ${dist.payerCorpEntityId} cannot pay intercorp dividend to itself`,
      });
      continue;
    }
    const target = init(dist.receiverCorpEntityId);
    if (dist.eligible.greaterThan(0)) {
      target.eligibleDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:eligible`,
        amount: dist.eligible,
        cadAmount: dist.eligible,
      });
    }
    if (dist.nonEligible.greaterThan(0)) {
      target.nonEligibleDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:nonEligible`,
        amount: dist.nonEligible,
        cadAmount: dist.nonEligible,
      });
    }
    if (dist.capital.greaterThan(0)) {
      target.capitalDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:capital`,
        amount: dist.capital,
        cadAmount: dist.capital,
      });
    }
  }

  return { byReceiverEntityId, warnings };
}
```

Tests (5):
1. No distributions → empty `byReceiverEntityId`, no warnings
2. Single A→B eligible div → B has 1 eligibleDividend item with correct source tag + amount
3. Receiver not in plan → warning, no addition
4. Self-loop (corp paying to itself) → error severity warning, no addition
5. Multiple types (eligible + nonEligible + capital from one payer) → all 3 arrays populated on receiver

Run: `npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/intercorpRouter.test.ts`

Commit: `feat(tax-scenarios): intercorpRouter for cross-corp dividend flow`

---

### Task 3: Wire `intercorpRouter` into `computeHouseholdPlan`

**Files:**
- Modify: `backend/src/tax/scenarios/computeHouseholdPlan.ts`
- Modify: `backend/test/tax/scenarios/computeHouseholdPlan.test.ts` — add ≥1 test exercising opco → holdco div flow

Existing orchestrator order:
1. Compute corp scenarios (parallel)
2. integrationRouter (corp → personal owner-comp)
3. spouseRouter (personal pension split)
4. Compute personals w/ injected additions

New order:
1. **Pre-resolve all corp facts** (need `facts.intercorp.*` for router input)
2. **intercorpRouter** — emit per-receiver-corp received-div additions
3. **Compute corp scenarios** — each corp resolves base facts, injects received divs from router, then `buildT2`
4. integrationRouter (existing)
5. spouseRouter (existing)
6. Compute personals (existing)

Implementation: extract corp-fact resolution into a helper; after intercorpRouter runs, build per-corp facts by merging base facts + received-div additions; pass to `buildT2 + ratesFor` directly (similar to the personal-side integration-additions path that already bypasses cache).

Add `intercorp: IntercorpRouterOutput` to `HouseholdPlanComputeResult` parallel to `integration` + `spouse`.

Cache behavior: corps that have no received divs (no other corp routes to them) still use the standard cache via `computeCorpScenario`. Corps that DO receive divs get a non-cached compute path (similar to personal-integration path) because their facts depend on plan state.

Test (1 new):
- Seed household w/ 2 corps (Opco + Holdco) + 1 personal
- Plan links all 3 scenarios
- Opco scenario override: `corp.activeIncome = 200000` + `intercorp.<HoldcoId>.nonEligible = 80000`
- Holdco scenario plain
- POST `/api/tax/household-plans/:id/compute`
- Assert:
  - `out.intercorp.warnings.length === 0`
  - `out.intercorp.byReceiverEntityId[Holdco.id].nonEligibleDividends.length === 1`
  - Holdco's `computed.totals.nerdtohEnding` > 0 (Part IV via NERDTOH addition = 80000 × 0.3067 = ~24,536)
  - Opco's tax unchanged by paying dividend (intercorp div is just a distribution, not a deduction)

Commit: `feat(tax-scenarios): wire intercorpRouter into computeHouseholdPlan`

---

### Task 4: Frontend — `intercorp.*` keys in `CorpOverrideEditor`

**Files:**
- Modify: `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx`

Current editor uses a flat `KEY_DEFS` list. The intercorp keys are dynamic (per receiver corp). Reasonable v1: add a small "Intercorp dividend distribution" section at the bottom that, when an active HouseholdPlan is known (passed as prop or via context), shows a `<select>` of other corps in the plan + 3 numeric inputs (eligible/nonEligible/capital), then writes `intercorp.<id>.<field>` keys into the override map.

If passing plan context is too invasive for v1, simpler fallback: a free-text "receiver corp entity id" input + 3 amount inputs. User has to know the other corp's id. Less friendly but lands the wiring.

Engineer picks based on existing prop boundaries. Document the choice in the commit.

Lint: `yarn workspace frontend run lint`.

Commit (use `HUSKY=0` if husky hook fails): `feat(tax-scenarios): intercorp dividend distribution UI in CorpOverrideEditor`

---

### Task 5: E2E intercorp dividend test

**Files:**
- Create: `backend/test/tax/scenarios/intercorpE2E.test.ts`

Integration test through the full HTTP path:
1. Seed household w/ User+Session+HouseholdMember (auth setup mirroring `routes-corp-scenarios.test.ts`)
2. Create 2 corp entities (Opco + Holdco) via POST `/api/tax/entities` if endpoint exists, else direct `Entity.create`
3. Create HouseholdPlan + 2 corp scenarios both linked to plan
4. PATCH Opco's scenario w/ overrides `{ corp.activeIncome: 200000, intercorp.<HoldcoId>.nonEligible: 80000 }`
5. GET `/api/tax/household-plans/:id/compute`
6. Assert:
   - `body.intercorp.byReceiverEntityId[Holdco.id].nonEligibleDividends[0].cadAmount === '80000'`
   - `body.intercorp.warnings.length === 0`
   - Holdco's computed totals contain NERDTOH addition reflecting the received div
   - Plan-wide total corp tax = Opco net tax + Holdco net tax (no double-count)

Run: `npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/intercorpE2E.test.ts`

Commit: `test(tax): E2E intercorp dividend flow via household plan compute`

---

## Pre-PR safe-push checklist

- [ ] All 5 task commits in branch (+ 1 plan commit)
- [ ] `yarn workspace cashflow-backend run test` passes
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` all commits BEFORE creating PR**
- [ ] Open PR + enable `--auto --merge`

## Risks / out of scope

- **Associated-corp grouping deferred:** shared SBD ($500k) + AAII ($50k threshold) across associated corps is the real-world rule. v1 treats each corp's SBD as independent. P11b territory.
- **Connected vs portfolio not distinguished:** Part IV is currently applied to ALL received corp divs at the same rate. Connected-corp divs should be Part IV = (payer's div refund × ownership %). Defer; document.
- **GRIP/CDA designation flow not modelled:** when opco pays eligible div from GRIP, recipient corp's GRIP should grow. v1: receiver gets div as Part IV-taxable received income; their GRIP doesn't grow. Defer.
- **No ownership % field:** routing assumes 100% — opco's full intercorp div goes to single named receiver. Real holdco may own 75% with rest owned by another shareholder. v1: user does the math + sets the override amount manually.
- **Single-direction routing:** `intercorp.<id>.<field>` on a payer scenario routes TO a receiver. Reverse routing (e.g. holdco pays back to opco) also works — both directions allowed. Cycle detection not enforced (real-world: cycles are tax-disadvantageous but legal).

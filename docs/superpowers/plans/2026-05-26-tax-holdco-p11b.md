# Tax Holdco P11b — Associated Groups + Part IV Refinement + GRIP Flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
>
> **Safe-push:** push ALL commits BEFORE opening PR.

**Goal:** Finish holdco mechanics: associated-corp groups (shared $500k SBD + $50k AAII), connected vs portfolio Part IV distinction with ownership-%, GRIP designation flow on intercorp eligible dividends.

**Architecture:** Add `associated_group_id` column on `tax_entities` to link corps in same SBD/AAII group. `computeHouseholdPlan` computes group AAII (sum across members) before per-corp T2; injects via new optional `facts.groupAaii` field. Engine's `sbdEligibleIncome` uses `groupAaii` when present, else per-corp `aaii`. Extend intercorp override keys w/ `intercorp.<id>.ownershipPercent` (0..100, default 100). New `corp.dividendRefund` engine total exposes payer's div refund for connected-corp Part IV calc. `intercorpRouter` extended to emit GRIP additions (receiver's GRIP grows by `eligible_div × ownership_pct/100`); `computeHouseholdPlan` injects via new `corp.openingGripBoost` field.

**Spec:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P11 row, completion).

**Builds on (in main):** P11a `intercorpRouter` + `intercorp.<id>.<field>` keys + `computeHouseholdPlan` orchestrator; existing P3 engine: `sbd.ts`, `aaii.ts`, `integration.ts`.

**Out of scope:** CDA designation flow on capital-div intercorp (real-world but tiny — defer); s.256 associated-corp eligibility rules (model lets user manually group; doesn't auto-detect).

**Conventions:** node:test, beforeEach sync, `--import ./backend/test/setup.ts`, decimal.js, conventional commits, `--message=` form, NEVER `Co-Authored-By`. Use `HUSKY=0 git commit ...` if husky-in-worktree fails.

---

## Task plan

### T1 — `associated_group_id` column on tax_entities

**Files:**
- Create: `backend/src/migrations/<ts>-entities-associated-group-id.js` — nullable string FK-less column (just a tag); index it
- Modify: `backend/src/models/Entity.ts` — add `associatedGroupId: string | null` (use STRING for easy group naming like "opco-holdco-group")
- Modify: `backend/test/tax/scenarios/entity-spouse-link.test.ts` OR new test file `backend/test/tax/scenarios/entity-associated-group.test.ts` — 2 tests: corps share groupId; personal entities can't be grouped (engine ignores)

Commit: `feat(tax): add associated_group_id on tax_entities`

---

### T2 — Group AAII rollup helper

**Files:**
- Create: `backend/src/tax/scenarios/computeGroupAaii.ts` — pure function: `computeGroupAaii(corpFactsByEntityId: Map<number, CorpTaxYearFacts>, entityById: Map<number, Entity>): Map<string, Decimal>` returns sum AAII per associated_group_id
- Create: `backend/test/tax/scenarios/computeGroupAaii.test.ts` — 4 tests: no group corps → empty map; 2 corps same group → AAII summed; 2 corps different groups → separate sums; corp w/ null groupId → not in any group

Reuse `computeAaii` from `backend/src/tax/engine/aaii.ts` for per-corp calc.

Commit: `feat(tax-scenarios): computeGroupAaii rollup helper`

---

### T3 — Engine accepts `groupAaii` override

**Files:**
- Modify: `backend/src/tax/engine/types.ts` — add `groupAaii?: Decimal` to `CorpTaxYearFacts`
- Modify: `backend/src/tax/engine/t2.ts` — when `facts.groupAaii` present, use it for SBD grind instead of per-corp `aaii`
- Modify: existing t2 tests — verify groupAaii override applies to SBD calc

```ts
// In t2.ts, replace:
const sbd = sbdEligibleIncome(abi, aaii, r);
// with:
const aaiiForSbd = facts.groupAaii ?? aaii;
const sbd = sbdEligibleIncome(abi, aaiiForSbd, r);
```

Add 1 test: corp w/ ABI=$400k, per-corp AAII=$0, groupAaii=$100k → SBD grind kicks in ($5 × (100k-50k) = $250k off limit) → SBD eligible = min(400k, 250k) = $250k.

Commit: `feat(tax-engine): SBD grind uses groupAaii override when present`

---

### T4 — Ownership-% on intercorp keys

**Files:**
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — extend `INTERCORP_RE` to match new `ownershipPercent` field: `^intercorp\.(\d+)\.(eligible|nonEligible|capital|ownershipPercent)$`; `intercorpEntryFor` apply fn stamps onto `corp.intercorp[receiverId].ownershipPercent` (number 0..100)
- Modify: `backend/test/tax/scenarios/intercorpKeys.test.ts` — add 2 tests: accepts `intercorp.7.ownershipPercent = 75`; rejects out-of-range value via validator (warning: just type-check number is finite; range validation can be deferred to router)

Commit: `feat(tax-scenarios): intercorp.<id>.ownershipPercent override key`

---

### T5 — Connected vs portfolio Part IV in integration.ts

**Files:**
- Modify: `backend/src/tax/engine/integration.ts` — extend ERDTOH/NERDTOH addition logic to distinguish "connected" (income items w/ source-tag prefix `intercorpRouter:from-corp-` AND ownership% known) from "portfolio" (everything else). For connected: Part IV = (payer_div_refund × ownership_pct/100); for portfolio: existing 38.33%/30.67%. Needs payer corp's div refund — for v1, accept as an optional `connectedPayerRefund` field on the IncomeItem source tag or via a new facts field.
- For v1 SIMPLIFICATION: when ownership% ≥ 10% (connected threshold), reduce Part IV to 0 (no Part IV on connected divs in v1 — payer-refund matching deferred). Document in comment.
- Modify: existing integration test — add 1 test: connected div (ownership 100%) → no Part IV → ERDTOH unchanged. Portfolio div (no ownership tag) → full 38.33% Part IV.

Note: the v1 simplification (connected = 0 Part IV) is INCORRECT for the case where payer received no div refund. Real rule: connected Part IV = payer's actual div refund × ownership%. v1 trades accuracy for tractability. Document loudly.

Commit: `feat(tax-engine): connected vs portfolio Part IV distinction (v1 simplified)`

---

### T6 — GRIP flow in intercorpRouter + computeHouseholdPlan

**Files:**
- Modify: `backend/src/tax/scenarios/intercorpRouter.ts` — extend `CorpReceivedDivs` w/ `gripBoost: Decimal` (sum of eligible dividends × ownership%/100 across received intercorp transfers). Source tag preserved.
- Modify: `backend/src/tax/scenarios/computeHouseholdPlan.ts` — when injecting received divs into receiver corp facts, also stamp `facts.openingGripBoost = gripBoost` (new optional CorpTaxYearFacts field per T3 pattern); engine adds gripBoost to GRIP carryforward output
- Modify: `backend/src/tax/engine/integration.ts` (or wherever GRIP-ending is calculated) — `gripEnding = priorGrip + gripBoost + (existing growth from corp's own eligible-rate income)`
- Modify: `backend/src/tax/engine/types.ts` — add `openingGripBoost?: Decimal` to CorpTaxYearFacts
- Modify: `backend/test/tax/scenarios/intercorpRouter.test.ts` — add 2 tests: gripBoost = eligible × ownership%; multiple payers aggregate gripBoost on same receiver

Commit: `feat(tax-scenarios): GRIP designation flow on intercorp eligible dividends`

---

### T7 — Frontend: associated-group picker + ownership-% UI

**Files:**
- Modify: `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx` — add ownership-% input field (default 100) per intercorp distribution row
- Modify: `frontend/src/hooks/useTaxEntities.ts` — expose `associatedGroupId` field on `TaxEntity` type
- New OR modify: associated-group picker. Options:
  - **A**: Simple text input on Corp T2 tab to set entity's `associatedGroupId` via PATCH `/api/tax/entities/:id` if such endpoint exists; otherwise add it
  - **B**: Dropdown listing existing distinct groupIds across household corps + "+ New group" option
- Pick A for v1 (simpler). New endpoint: `PATCH /api/tax/entities/:id` body `{ associatedGroupId: string | null }`

Modifies: `backend/src/routes/tax.ts` — add `PATCH /api/tax/entities/:id` (kind-corp-only validation for groupId; null clears).

Commit: `feat(tax): associated-group picker + ownership-% UI`

---

### T8 — E2E: associated group + connected div + GRIP flow

**Files:**
- Create: `backend/test/tax/scenarios/holdcoP11bE2E.test.ts`

Test scenario:
1. Seed household w/ 2 corps (Opco + Holdco) in same `associatedGroupId = "ABCorp"`
2. Plan links both
3. Opco: `corp.activeIncome = 400000`, `corp.passiveInvestmentIncome = 60000`, `intercorp.<HoldcoId>.eligible = 50000`, `intercorp.<HoldcoId>.ownershipPercent = 100`
4. Holdco: plain
5. GET `/api/tax/household-plans/:id/compute`
6. Assert:
   - Group AAII = $60k (Opco AAII only since Holdco has nothing)
   - Group AAII > $50k threshold → SBD grind kicks in on Opco
   - Opco's SBD limit grinds: ($60k - $50k) × $5 = $50k off → SBD = $450k → Opco's full $400k ABI gets SBD rate
   - Holdco's NERDTOH ≈ $0 (no non-eligible dividends received)
   - Holdco's GRIP increased by ($50k × 100% = $50k) gripBoost
   - Holdco's Part IV ≈ $0 on connected eligible div (v1 simplification)

Commit: `test(tax): E2E associated group + connected intercorp + GRIP flow`

---

## Pre-PR safe-push checklist

- [ ] All 8 task commits in branch (+ 1 plan)
- [ ] `yarn workspace cashflow-backend run test` passes
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` all commits BEFORE creating PR**
- [ ] Open PR + `--auto --merge`

## Risks / out of scope

- **v1 connected Part IV = 0 is inaccurate** when payer corp had no div refund. Real rule: Part IV = payer's actual div refund × ownership%. Defer accurate version to P11c (requires multi-pass compute: corp compute → div refund visible → recompute receivers).
- **CDA capital-div flow** not modelled — receiver corp's CDA should grow by capital div received. Defer.
- **s.256 associated-corp auto-detection** out of scope. User manually assigns groupId.
- **GRIP boost timing**: real rule is opening GRIP + designations made; v1 treats all intercorp eligible divs as designated to GRIP immediately. Edge: holdco choosing NOT to receive as GRIP-boosting (rare).
- **Ownership%-driven dividend split** not enforced: user sets the override amount; we don't validate it equals `payer_div × ownership%`. The override is the source of truth.

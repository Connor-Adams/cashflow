# Tax Planning Platform — Design

**Date:** 2026-05-25
**Status:** Draft (awaiting user review)
**Author:** Connor Adams
**Supersedes:** Phase 5 "Scenarios + instalment optimizer" placeholder (referenced in [2026-05-24-tax-tab-design.md](2026-05-24-tax-tab-design.md))
**Builds on:** Phase 1–5 (all shipped to main: T1+T2 engines, carryforward roll, multi-year compare, instalments, basic owner-comp scenario)

---

## 1. Problem framing

The tax module currently computes filing-grade T1 + T2 returns from real transaction/slip data and ships a single-shot owner-comp scenario simulator (`backend/src/tax/engine/scenario.ts`). It does not yet support what the user actually needs: a **lifetime tax planning platform** where the user explores branching what-ifs across multiple entities (self, spouse, opco, holdco), multiple years, and the four canonical what-ifs:

1. Salary vs dividend mix (opco → owner-manager)
2. RRSP / FHSA contribution sizing + timing
3. Capital gains realization (timing, harvesting, inclusion-rate awareness)
4. Corp retention vs payout (passive income SBD grind, RDTOH/CDA management)

This spec scopes the planning layer on top of the existing engine layer. Engine code is reused untouched. New work is concentrated in: (a) scenario persistence + tree resolution, (b) household-plan orchestration, (c) multi-year scenario chains, (d) UI surfaces for branching/comparison/lever editing, (e) extensions for spouse / holdco / lifetime modelling. Plus an immediate fix to a runtime FX bug surfaced in the current UI ("FX rate missing for USD→CAD on/before 2025-01-01").

**Intended use:** estimation + planning, not filing. An accountant still files. The platform must be precise enough to inform real decisions (especially salary vs dividend, where small percentage differences move thousands).

**Non-goals:** NETFILE / e-file output, replacing accountant judgment on novel transactions, jurisdictions outside Canada / provinces outside Ontario for the initial slice.

---

## 2. Constraints (additional to inherited Phase 1–5 constraints)

- **Entity scope:** All four — personal (self), spouse, opco (CCPC), holdco. Sequenced delivery (personal+opco first, then spouse, then holdco).
- **Horizon:** Lifetime. Realistically delivered as rolling 5-year first, retirement modelling later.
- **Inputs:** Hybrid — actuals from existing builders for current/past years, manual overrides per-line, synthetic projections for future years.
- **Scenario organisation:** Branching tree (each scenario has a parent; overrides layer on parent's overrides).
- **Persistence:** Scenarios are first-class persisted entities, not session state.
- **Precision:** Same Decimal arithmetic discipline as engines. Scenarios must reconcile against engine output exactly for the actuals baseline.
- **Engine reuse:** Pure `t1Engine` and `t2Engine` modules are not modified. Scenarios are an upstream concern — they assemble `TaxYearFacts` / `CorpTaxYearFacts` and call the existing engines.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1 — Pure engines (existing, untouched)               │
│  buildT1(facts, rateTable)   → TaxReturn                    │
│  buildT2(facts, rateTable)   → CorpTaxReturn                │
│  Pure functional, fully tested.                             │
└─────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────┴───────────────────────────────────┐
│  LAYER 2 — Facts builders + scenario resolver               │
│  - buildPersonalFactsFromActuals (existing)                 │
│  - buildCorpFactsFromActuals (existing)                     │
│  - resolveScenario(scenarioId) → facts            [NEW]     │
│      walks parent ancestry → layers overrides → returns     │
│      either TaxYearFacts or CorpTaxYearFacts                │
│  - projectFactsFromPrevYear(scenarioRoot) → facts [NEW]     │
│      uses rolled carryforwards + assumption growth          │
│  - integrationRouter(corpReturn, ownerCompPlan)   [REPLACES │
│      → additions for personal facts                  Phase  │
│      Replaces stateless runScenario.ts.              5 stub]│
└─────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────┴───────────────────────────────────┐
│  LAYER 3 — Scenario orchestration + API                     │
│  - Scenario CRUD (tree, fork, edit, delete)       [NEW]     │
│  - HouseholdPlan (groups sibling-entity scenarios)[NEW]     │
│  - Compute endpoints (one scenario / full plan)   [NEW]     │
│  - Carryforward chain across scenario years       [extends  │
│      (reuses rollPersonalCarryforwards.ts)         existing]│
│  - FX resolver with on-demand BoC fetch           [FIX]     │
└─────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────┴───────────────────────────────────┐
│  LAYER 4 — UI                                                │
│  - Scenario tree control (Personal T1, Corp T2)   [NEW]     │
│  - Comparison view (N scenarios diffed)           [NEW]     │
│  - Owner Comp lever surface (replaces current     [REPLACES │
│      OwnerCompPlannerTab with persisted scenario   existing]│
│      + live recompute)                                       │
│  - Household plan picker (Overview)               [NEW]     │
│  - Multi-year nav (year-strip on Personal T1)     [NEW]     │
│  - Expanded Reconciliation (slip-vs-txn,          [extends  │
│      missing slip detection, scenario drift)       existing]│
└─────────────────────────────────────────────────────────────┘
```

**Engine reuse principle:** the existing pure `buildT1` / `buildT2` are the kernel. Scenarios are an upstream concern. New code does not touch engine files.

---

## 4. Phased delivery

Each phase ships independently, gets its own writing-plans cycle. Phases numbered to continue from prior spec series (P5 was the stub being superseded).

| Phase | Scope | New tabs/lights | Engine status |
|---|---|---|---|
| **P6 — Foundation polish** | FX on-demand fetch via `ensureFxRate`, backfill historical USD/CAD rates (5 yr), Reconciliation tab expansion (missing-slip detector, slip-vs-txn divergence, category misclassification) | Reconciliation richer | T1 + T2 (no change) |
| **P7 — Scenario engine v2 (personal, current+next year)** | Scenario tree CRUD, override schema + registry, ancestry resolver, scenario UI on Personal T1, side-by-side comparison view. Replaces `runScenario.ts` for personal-side use | Scenario tree visible on Personal T1 | T1 |
| **P8 — Corp scenarios + Owner Comp interactive** | Scenario tree on Corp T2, full Owner Comp surface (sliders for salary/bonus/eligible div/non-elig div/cap div per shareholder per corp), HouseholdPlan model, integrated rate display. Replaces existing OwnerCompPlannerTab | Scenario tree on Corp T2, redesigned Owner Comp | T1 + T2 + integration |
| **P9 — Multi-year scenarios (rolling 5 yr)** | Scenario chains across years (`next_year_id`), automatic carryforward roll-forward inside scenarios (reuses existing `rollPersonalCarryforwards` / `rollCorpCarryforwards`), root-year assumptions (inflation/return) | Year-strip nav on Personal T1 + Corp T2 | T1 + T2 + projection |
| **P10 — Spouse / household splitting** | Spouse entity scenarios, pension splitting, spousal RRSP, attribution rules, household-level rollup on Overview | Spouse view on Overview | T1 (split rules) |
| **P11 — Holdco / multi-corp** | Second corp entity, intercorporate dividends, Part IV tax, AAII tracking across corps, full SBD grind modelling at group level | Multiple corps in entity picker | T2 (multi-corp) |
| **P12 — Lifetime / retirement** | RRIF conversion modelling, OAS clawback projection, RRSP melt-down strategy, decade-horizon projections, estate primer | Lifetime view on Overview | T1 + retirement |

Phases P6 → P9 cover the typical owner-manager use case (you + opco). P10 → P12 are progressive enhancement.

---

## 5. Data model

All new tables. No changes to existing tables.

### `scenarios`

```sql
CREATE TABLE scenarios (
  id                uuid PRIMARY KEY,
  parent_id         uuid REFERENCES scenarios(id) ON DELETE RESTRICT,  -- NULL = root
  household_plan_id uuid REFERENCES household_plans(id) ON DELETE SET NULL,
  entity_id         uuid NOT NULL REFERENCES tax_entities(id) ON DELETE CASCADE,
  year              int  NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL,    -- 'baseline' | 'fork' | 'projection_root'
  overrides         jsonb NOT NULL DEFAULT '{}',
  assumptions       jsonb NOT NULL DEFAULT '{}',  -- only on projection_root: { inflation, returns }
  next_year_id      uuid REFERENCES scenarios(id) ON DELETE SET NULL,  -- multi-year chain
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, year, name)
);
CREATE INDEX scenarios_parent_idx ON scenarios (parent_id);
CREATE INDEX scenarios_entity_year_idx ON scenarios (entity_id, year);
CREATE INDEX scenarios_plan_idx ON scenarios (household_plan_id);
```

The `baseline` kind is system-generated per (entity, year) on first access — represents the unmodified actuals. Cannot be deleted. Can be parent to forks. `projection_root` is a synthetic root for a future year (no actuals available). `fork` is everything else.

### `household_plans`

```sql
CREATE TABLE household_plans (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         text NOT NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

Groups sibling-entity scenarios for the same planning question. e.g. "Salary-heavy 2025 plan" includes: opco scenario, personal scenario, spouse scenario.

### `scenario_returns` (compute cache)

```sql
CREATE TABLE scenario_returns (
  id           uuid PRIMARY KEY,
  scenario_id  uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  facts_hash   text NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  lines        jsonb NOT NULL,    -- TaxLine[] or CorpTaxLine[]
  totals       jsonb NOT NULL,    -- engine totals shape
  warnings     jsonb NOT NULL,
  UNIQUE (scenario_id, facts_hash)
);
```

Cache invalidates by facts_hash mismatch (same pattern as existing `TaxReturn` snapshot in Phase 1).

### Override key registry

Lives in `backend/src/tax/scenarios/overrideKeys.ts`. Typed registry — each key has runtime validator + target layer (personal facts vs corp facts vs owner comp routing).

Example keys:

```jsonc
// Personal overrides (entity.kind = 'personal')
"income.employment"           : Decimal     // overrides aggregated T4 box14
"income.eligibleDividends"    : Decimal
"income.nonEligibleDividends" : Decimal
"income.interest"             : Decimal
"deductions.rrspContrib"      : Decimal
"deductions.fhsaContrib"      : Decimal
"deductions.donations"        : Decimal
"capgains.dispositions"       : Array<{ proceeds, acb, date }>

// Corp overrides (entity.kind = 'corp')
"corp.activeIncome"           : Decimal
"corp.passiveInvestmentIncome": Decimal
"corp.aaiiTrailing"           : Decimal
"corp.dividendPaidEligible"   : Decimal
"corp.dividendPaidNonEligible": Decimal
"corp.dividendPaidCapital"    : Decimal
"corp.salaryPaid"             : Decimal       // total to all shareholders

// Owner comp routing (lives in either personal OR corp scenario; corp side is canonical)
"ownerComp.<shareholderEntityId>.salary"           : Decimal
"ownerComp.<shareholderEntityId>.bonus"            : Decimal
"ownerComp.<shareholderEntityId>.eligibleDividend" : Decimal
"ownerComp.<shareholderEntityId>.nonEligibleDividend": Decimal
"ownerComp.<shareholderEntityId>.capitalDividend"  : Decimal
```

Registry enforces: type validation at API boundary, layer routing in resolver, allowed keys per entity kind, displayability in UI.

**Decimal storage:** values of type `Decimal` are stored as strings in jsonb (matches existing project convention with `decimal.js`). Registry validators deserialise on read, serialise on write. Engines see `Decimal` instances, never raw numbers.

### `shareholder_loans` (P9 phase; if not already in existing `ShareholderLoan` model from Phase 3 — verify)

Existing `ShareholderLoan` model from Phase 3 should suffice. If extension needed for s.15(2) timing alerts, add a computed view rather than new table.

### Carryforward extension

Existing `Carryforward` model already supports cap_loss, rrsp_room, grip, cda, erdtoh, nerdtoh, non_cap_loss, aaii, instalments_paid (per Phase 1+4 specs). No schema change. Scenario projections write into this table with `(entity_id, kind, as_of_year)` keys scoped to a scenario via a new optional `scenario_id` column.

```sql
ALTER TABLE carryforwards ADD COLUMN scenario_id uuid REFERENCES scenarios(id) ON DELETE CASCADE;
ALTER TABLE carryforwards DROP CONSTRAINT carryforwards_entity_kind_year_key;
ALTER TABLE carryforwards ADD CONSTRAINT carryforwards_entity_kind_year_scenario_key UNIQUE (entity_id, kind, as_of_year, scenario_id);
-- NULL scenario_id = actuals; non-NULL = belongs to that scenario chain.
```

---

## 6. Compute pipeline

### `resolveScenario(scenarioId)` → facts

```
1. ancestry = walk parent chain from root → scenarioId (in order)
2. if ancestry[0].kind === 'baseline':
       facts = buildXxxFactsFromActuals(entityId, year)   // existing builder
   else if ancestry[0].kind === 'projection_root':
       facts = projectFactsFromPrevYear(ancestry[0])
3. for each node in ancestry (root → leaf):
       facts = applyOverrides(facts, node.overrides)
4. return facts
```

`applyOverrides` is a typed dispatcher driven by the override key registry. Each override key has a known target field on the facts struct; some keys append to arrays (cap gain dispositions), some replace scalars (employment income), some merge maps (carryforwards).

### `computeScenario(scenarioId)` → return

```
facts = resolveScenario(scenarioId)
hash  = sha256(canonicalJSON(facts) + rateTableVersion(facts.year))
cached = scenario_returns.findOne({ scenario_id, facts_hash: hash })
if cached: return cached
result = entity.kind === 'corp' ? buildT2(facts) : buildT1(facts)
insert into scenario_returns (scenario_id, facts_hash, ...)
return result
```

### `computeHouseholdPlan(planId)` → integrated result

```
plan_scenarios = scenarios.find({ household_plan_id: planId })

// Topological order: corps first (T2 emits dividends), then personals (T1 receives)
corp_scenarios     = plan_scenarios.filter(s => entity.kind === 'corp')
personal_scenarios = plan_scenarios.filter(s => entity.kind === 'personal')

corp_returns = corp_scenarios.map(computeScenario)

// integrationRouter routes corp outputs to personal facts as additions
distributions_by_personal_entity = integrationRouter(
  corp_returns,
  extract_owner_comp_overrides(corp_scenarios + personal_scenarios)
)

personal_returns = personal_scenarios.map(s => {
  facts = resolveScenario(s.id)
  // applyDistributions merges integration-router output into facts:
  //   facts.employmentIncome.push(...additions.employmentIncome)
  //   facts.eligibleDividends.push(...additions.eligibleDividends)
  //   facts.nonEligibleDividends.push(...additions.nonEligibleDividends)
  //   facts.capitalDividendsReceived.push(...additions.capitalDividendsReceived)
  //   facts.cppEnrolled = facts.cppEnrolled || additions.cppEnrolled
  facts = applyDistributions(facts, distributions_by_personal_entity[s.entity_id])
  return buildT1(facts)
})

return {
  corp_returns,
  personal_returns,
  integrated: {
    total_household_tax: ...,
    integrated_rate: ...,
    warnings: validation_warnings_across_plan,
  }
}
```

### Multi-year projection

When a scenario has `next_year_id` set, computing it triggers projection of the next year's `projection_root`:

```
projectFactsFromPrevYear(rootScenario):
  prevReturn = computeScenario(rootScenario.parent_chain.find(year === rootScenario.year - 1))
  rolled_carryforwards = rollXxxCarryforwards(prevReturn, rootScenario.year)
       // reuses existing services rollPersonalCarryforwards.ts / rollCorpCarryforwards.ts
  return {
    carryforwards: rolled_carryforwards,
    income: applyGrowth(prevReturn.facts.income, rootScenario.assumptions.inflation ?? 0),
    ...
  }
```

### Integration router (replaces current `runScenario.ts`)

Pure function. Takes corp T2 results + owner-comp distribution plans, returns additions to apply to each personal facts struct:

```typescript
interface OwnerCompDistribution {
  shareholderEntityId: string;
  salary: Decimal;
  bonus: Decimal;
  eligibleDividend: Decimal;
  nonEligibleDividend: Decimal;
  capitalDividend: Decimal;
}

interface PersonalAdditions {
  employmentIncome: IncomeItem[];   // from salary + bonus
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  capitalDividendsReceived: IncomeItem[];   // non-taxable but tracked
  cppEnrolled: boolean;
}

function integrationRouter(
  corpReturns: CorpTaxReturn[],
  distributions: OwnerCompDistribution[]
): { byEntityId: Record<string, PersonalAdditions>, warnings: Warning[] }
```

Validations:
- `sum(eligibleDividend across distributions)` ≤ corp GRIP balance after computation → warning if exceeds
- `sum(capitalDividend)` ≤ corp CDA balance → warning
- Salary triggers CPP enrolment for shareholder; EI excluded for non-arms-length (default; toggle via override)
- Total cash distributed ≤ corp retained earnings + dividend (sanity check)

---

## 7. FX bug fix (P6, immediate)

**Current bug** (visible in UI banner): `Error: FX rate missing for USD→CAD on/before 2025-01-01`.

**Root cause:** `backend/src/tax/builders/buildPersonalFacts.ts` `toCad()` performs DB-only lookup of `FxRate`. If no row exists on/before the requested date, throws. Meanwhile `backend/src/fx/bankOfCanada.ts:115` `ensureFxRate(from, to, date)` already implements DB cache + on-demand BoC fetch + persist — but is not called from the tax builder path.

**Fix:**

1. **Inline:** Change `toCad()` to `await ensureFxRate(currency, 'CAD', date)`, propagate async upward through `buildPersonalFacts` (function may already be async; verify). Same change applied to `buildCorpFacts.ts` if it has a parallel toCad.

2. **Backfill job:** New service `backend/src/fx/backfillUsdCadHistory.ts`. On first boot (idempotent), fetches Bank of Canada daily noon USD→CAD rates for the last 5 years. Skips already-populated dates. Runs in background. Logs progress.

3. **Fallback:** If `ensureFxRate` returns no rate (date before BoC API range, e.g. pre-2000), use nearest available rate, emit warning carrying delta in days.

4. **Test:** Builder test with a USD txn on a date not in fx_rates → assert ensureFxRate called, rate fetched, computation proceeds. Contract test for BoC API via nock.

Migration: none. Service + builder edits only.

---

## 8. UI / UX

### 8.1 Tab map (post-platform)

| Tab | Purpose | Phase |
|---|---|---|
| **Overview** | Household rollup, integrated rate, top warnings, household plan picker | P6 (basic), P8 (integration), P10 (household) |
| **Personal T1** | Per-person T1 lines + scenario tree + comparison grid + year-strip nav | P7 (tree), P9 (multi-year) |
| **Slips** | Slip CRUD (existing, unchanged) | — |
| **Reconciliation** | Slip-vs-txn divergence (existing), missing slip detector, category misclassification, scenario actuals drift | P6 expansion |
| **Corp T2** | Per-corp T2 lines + scenario tree + GRIP/CDA/RDTOH ledger | P8 (tree) |
| **Shareholder Loans** | Ledger (existing) + s.15(2) timing alerts | P8 (alerts) |
| **Owner Comp** | Per-shareholder × per-corp lever surface (sliders + live recompute), supersedes current OwnerCompPlannerTab | P8 |

### 8.2 Scenario tree control (Personal T1 + Corp T2)

Persistent left rail shows scenario hierarchy for selected (entity, year). Right pane shows selected scenario.

```
┌─ Scenario tree (Personal · 2025) ──┐  ┌─ Selected: "Salary heavy 2025" ───┐
│ • Baseline (actuals)               │  │  ↑ inherits from Baseline          │
│   ├─ Salary heavy 2025  ◀ active   │  │                                    │
│   │   └─ + max RRSP                │  │  Overrides (3):                    │
│   └─ Dividend heavy 2025           │  │   income.employment      95,000 ⊗  │
│       └─ + cap gain harvest        │  │   deductions.rrspContrib 31,560 ⊗  │
│ [+ Fork from current]              │  │   ownerComp.salary       60,000 ⊗  │
│ [+ Project 2026]                   │  │                                    │
└────────────────────────────────────┘  │  T1 lines [grouped, collapsible]   │
                                        │  Federal tax        18,420         │
                                        │  Provincial tax      8,310         │
                                        │  CPP                 4,055         │
                                        │  Total payable      30,785         │
                                        │  Marginal rate      43.41%         │
                                        │  [Compare with…] [Edit overrides]  │
                                        └────────────────────────────────────┘
```

Fork from current creates a child node with empty overrides (inherits parent's). Override edit modal lets user add/remove typed override keys.

### 8.3 Comparison view

Modal or full-screen. Pick N scenarios → columnar diff. Identical lines greyed, differing lines highlighted with deltas. Marginal rate, total payable, integrated rate (if all scenarios are in same HouseholdPlan) at top.

```
                       Baseline     Salary heavy   Dividend heavy
Employment income      82,000       95,000  ▲13k   0       ▼82k
Non-elig div                0            0          80,000  ▲80k
RRSP deduction         20,000       31,560  ▲11k   8,000   ▼12k
─────────────────────────────────────────────────────────────────
Federal tax            14,820       18,420  ▲3.6k  9,840   ▼5k
Provincial tax          6,940        8,310  ▲1.4k  4,560   ▼2.4k
CPP                     4,055        4,055             0   ▼4k
Total payable          25,815       30,785  ▲5k   14,400  ▼11.4k
Marginal rate          38.29%       43.41%         38.29%
─── + household integration (when applicable) ───────────────────
Corp T2 paid              N/A          N/A          16,800
Integrated rate           N/A          N/A          32.18%  ◀
```

### 8.4 Owner Comp lever surface (P8, replaces existing OwnerCompPlannerTab)

For each shareholder × each corp the user owns. Lives at top of Corp T2 scenario (canonical home) and surfaces summary on Personal T1 scenario.

```
Owner Comp · 2025 · MyCorp Inc.
Shareholder: Connor Adams                Plan: "Salary heavy 2025"

Salary           $ [────●─────────] $60,000   CPP base used: 60K of 71.3K
Bonus            $ [●──────────────] $    0
Eligible div     $ [●──────────────] $    0   GRIP after: $0
Non-elig div     $ [────────●──────] $80,000  Retained earnings: −$80K
Capital div      $ [●──────────────] $    0   CDA after: $4,200

──────────────────────────────────────────────────────────────────
Corp side       T2 federal       12,800
                T2 provincial     4,000
                Div refund      (8,500)
                Net corp tax      8,300

Personal side   Employment       60,000
                Non-elig div     80,000 (gross-up 92,000)
                Federal tax      19,420
                Provincial tax    9,140
                CPP               4,055
                Net to Connor    66,565

──────────────────────────────────────────────────────────────────
Total corp earnings:  140,000
Total tax paid:        32,360  (23.11%)
Net take-home:        107,640
Integrated rate:       23.11%
```

Sliders debounced at 200ms; each change writes an override to the active corp scenario; recompute triggered immediately for that scenario + linked personal scenario via HouseholdPlan.

### 8.5 Multi-year navigation (P9)

Personal T1 + Corp T2 get a year-strip on top: `‹ 2024 │ 2025 ▶ │ 2026 │ 2027 │ 2028 ›`. Future years show projected scenario chain. Editing root-year assumptions (inflation/return) propagates. Horizontal bar chart of total tax per year with scenario overlay.

### 8.6 Household plan picker (P8 / P10)

Overview top bar: `Household Plan: [Salary-heavy 2025 ▼]`. Switching the plan switches the active scenario across all entities. Plans are persisted, branchable, named.

### 8.7 Reconciliation expansion (P6)

Current `ReconciliationTab` only catches T4 box14 vs computed divergence. Add:

- **Missing slip detector:** transactions categorized as employment / interest / dividend / cap gain income with no matching slip
- **Slip-vs-txn divergence:** T5 box24 ≠ sum(categorized interest income), T3 box49 ≠ sum(eligible div income), etc.
- **Category misclassification flags:** txn marked `dividend_eligible` but Security record says `non_eligible`
- **Scenario actuals drift:** scenario overrides that have been contradicted by new actual data — auto-flag for review

### 8.8 Component reuse

- Tailwind utilities + lookup tables for variant classes (per existing project convention)
- Existing tabs/card/form components from cashflow side
- React Query for compute endpoints, cache key includes facts_hash so server cache and client cache align

---

## 9. API surface (new endpoints)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tax/scenarios` | Create scenario (baseline auto-created on first use of entity+year) |
| GET | `/api/tax/scenarios?entity_id=&year=` | List scenarios for entity+year |
| GET | `/api/tax/scenarios/:id` | Get scenario detail + computed return |
| PATCH | `/api/tax/scenarios/:id` | Update overrides, name, notes |
| POST | `/api/tax/scenarios/:id/fork` | Create child scenario inheriting overrides |
| DELETE | `/api/tax/scenarios/:id` | Delete (baseline cannot delete; restricts if has children) |
| POST | `/api/tax/scenarios/:id/compute` | Force recompute (bypass cache) |
| POST | `/api/tax/scenarios/:id/project-next-year` | Create projection_root for year+1 |
| GET | `/api/tax/household-plans` | List plans for household |
| POST | `/api/tax/household-plans` | Create plan |
| PATCH | `/api/tax/household-plans/:id` | Update name/notes, add/remove scenario links |
| DELETE | `/api/tax/household-plans/:id` | Delete plan (scenarios remain, just unlinked) |
| GET | `/api/tax/household-plans/:id/compute` | Compute integrated result |
| GET | `/api/tax/scenarios/:id/compare?with=id1,id2,...` | Diff payload for N scenarios |

The existing Phase 5 `POST /api/tax/scenarios` (single-shot owner-comp) is replaced by the new shape. Backwards-incompat — must coordinate with frontend cutover in P7→P8 phases. Old single-shot endpoint removed once new persisted path lit.

---

## 10. Error handling

Tax computation must never silently produce wrong numbers. Two-tier failure:

- **Fatal** (throws, UI shows error banner — same pattern as current FX bug): inputs structurally invalid (missing required slip data, unknown jurisdiction, divisor=0, cyclic scenario ancestry).
- **Warning** (compute proceeds; surfaces in Reconciliation tab + scenario warnings): inputs possibly wrong but engine has a defensible default.

Every warning: severity, line key, message, suggested action.

| Case | Behavior |
|---|---|
| FX rate missing for date | Auto-fetch via ensureFxRate; if outside BoC range, use nearest + warning with day delta |
| Override key not in registry | API rejects with 400 |
| Override produces negative income line | Allow, emit warning |
| Scenario ancestry cycle | DB constraint + create-time check; reject |
| Carryforward roll-forward but prev year not computed | Auto-compute prev year first; if prev year blocked, surface as `parentBlockingError` |
| Corp distributes > GRIP / CDA | Warning, illegal distribution flag |
| Salary triggers EI on non-arms-length owner | Default no EI + warning + override toggle |
| Two scenarios in same plan claim same shareholder's salary | Reject |
| Rate table missing for projected year | Use most-recent year's rates + "extrapolated" warning |

---

## 11. Testing strategy

Layered to match arch.

### Layer 1 (engines — existing tests preserved)

Existing test files in `backend/test/tax/`. No changes for P6. P10 (spouse splitting) adds pension-split + attribution tests. P11 (holdco) adds Part IV + intercorp tests. P12 adds RRIF/OAS clawback tests.

### Layer 2 (builders + resolver — new)

- `buildPersonalFactsFromActuals` (existing): add FX on-demand path test (P6)
- `buildCorpFactsFromActuals` (existing): same FX test
- `resolveScenario` [NEW]: ancestry walk, override layering precedence, sparse merge correctness, cycle detection, baseline auto-creation
- `projectFactsFromPrevYear` [NEW]: carryforward roll correctness, growth application, missing prev-year handling
- `applyOverrides` [NEW]: per registry key, validate target field correctly updated

In-memory sqlite for these tests (per project convention: prod DB only for ad-hoc checking, not test fixtures).

### Layer 3 (orchestration — new)

- Create HouseholdPlan with 1 corp + 1 personal + spouse
- Build salary-heavy + dividend-heavy scenario set
- Verify integrated rate matches manually-calculated reference (Manning Elliott / EY published Ontario integration tables)
- Fork scenario, edit override, verify computation diverges correctly
- Multi-year chain: project 2026 from 2025 baseline + fork, verify carryforward roll

### Layer 4 (FX + external — new)

- BoC API contract test (nock record + replay)
- Backfill job idempotency (run twice, no duplicate rows)
- ensureFxRate cache hit / miss / API-fail boundaries

### Frontend tests

- Scenario tree control: fork, select, edit override, delete
- Comparison view: N scenarios render, deltas computed correctly, integrated row appears when plan-linked
- Owner Comp sliders: change → debounced override write → recompute → display update

---

## 12. Cross-cutting

### Performance

- Compute cache keyed on facts_hash (sha256 canonical). Hash includes rate table version. Override edit → only that scenario recomputes.
- HouseholdPlan compute is parallel for independent personal scenarios; sequential only for corp→personal integration.
- Frontend uses React Query `staleTime: Infinity` + manual invalidation on scenario mutation. Cache key includes facts_hash to align with server cache.
- Target latencies: <100ms personal scenario compute (warm engine + cache hit), <300ms cold corp, <500ms full household plan (warm).

### Migrations

- P6: no schema change (FX fix is code-only + new backfill service).
- P7: `scenarios`, `scenario_returns` tables.
- P8: `household_plans` table; `scenarios.household_plan_id` FK already on P7 table.
- P9: `carryforwards.scenario_id` column.
- P10–P12: no new schema in design (composition over new tables).

Each phase migration reviewable independently.

### FX (long-term)

After P6 USD→CAD fix lands, same `ensureFxRate(fromCurrency, 'CAD', date)` already supports any currency BoC publishes. Adding EUR/GBP is a one-line builder change + backfill seed for that currency.

### Rate table maintenance

Annual update is a separate maintenance task (already per existing convention). Rate table version embedded in facts_hash so cached returns invalidate on rate changes.

### Security / privacy

- All scenario endpoints require existing auth middleware
- Audit log on scenario CRUD (who, when, what changed) — new `scenarios_audit` table appended to (P7)
- No PII in logs. Override values may be sensitive → log scenario IDs + key names but not values.

### Observability

- Compute durations logged per scenario
- Cache hit ratio metric
- Warnings count per warning kind → prioritise which warnings to refine in later phases

---

## 13. Risks + open questions

1. **Override key sprawl.** As more what-ifs land, override key registry grows. Need to keep flat + typed; resist nested objects. If registry > 100 keys, revisit.
2. **Scenario ancestry depth.** Branching tree could grow deep; recompute walks the chain. In practice probably 3–5 deep max; add depth limit (say 10) with hard error.
3. **HouseholdPlan link semantics.** Currently `scenarios.household_plan_id` is nullable single-FK — a scenario can belong to at most one plan. If user wants to share a scenario across plans (e.g. "Baseline 2025" reused in 3 plans), need join table. Defer to P10; revisit if user need surfaces.
4. **Projection root assumptions.** Growth rate applied uniformly to all income lines is crude. Real planning needs per-line assumptions (salary growth ≠ investment income growth). Defer to P12 when retirement modelling justifies the complexity.
5. **Integration router edge case: multiple corps distributing to same shareholder.** Order of integration matters for stacking (CPP fully consumed by first salary; second corp's salary creates no further CPP). Defined order: by corp creation date. Documented in router. Add test.
6. **Carryforward roll vs scenario-scoped carryforwards.** Adding `scenario_id` to carryforwards table conflates "actuals carryforward" (NULL scenario_id) and "scenario-projected carryforward" (non-NULL). Resolver must always prefer non-NULL when chain matches. Document this precedence rule. Add test.
7. **Performance cliff for full lifetime projection.** 30-year scenario chain × 4 entities = 120 compute nodes. With cache warm, fine. Cold = ~36 seconds at 300ms each. Mitigate by computing on demand per year-visible-in-UI; full lifetime compute is on-request only.
8. **Spouse attribution rules.** Income attribution back to higher-earner spouse (gifting investment cap, second-gen rules) is genuinely complex; P10 may need narrower initial scope (pension split + spousal RRSP only, attribution deferred).
9. **Lifetime tax-rate uncertainty.** Beyond ~5 years, rate tables are guesses. P12 must surface "speculative" badge prominently and avoid implying precision that isn't there.

---

## 14. Files this design touches/creates

**New code (per phase, in dependency order):**

P6:
- `backend/src/tax/builders/buildPersonalFacts.ts` (edit toCad to use ensureFxRate)
- `backend/src/tax/builders/buildCorpFacts.ts` (same if has FX path)
- `backend/src/fx/backfillUsdCadHistory.ts` (NEW)
- `backend/src/index.ts` or boot file (call backfill once on first boot)
- `frontend/src/pages/tax/ReconciliationTab.tsx` (expand)

P7:
- `backend/src/migrations/<ts>-scenarios.js`
- `backend/src/migrations/<ts>-scenario-returns.js`
- `backend/src/models/Scenario.ts`
- `backend/src/models/ScenarioReturn.ts`
- `backend/src/tax/scenarios/overrideKeys.ts`
- `backend/src/tax/scenarios/resolveScenario.ts`
- `backend/src/tax/scenarios/applyOverrides.ts`
- `backend/src/tax/scenarios/computeScenario.ts`
- `backend/src/routes/tax-scenarios.ts` (or merge into tax.ts)
- `frontend/src/pages/tax/scenarios/ScenarioTree.tsx`
- `frontend/src/pages/tax/scenarios/OverrideEditor.tsx`
- `frontend/src/pages/tax/scenarios/ComparisonView.tsx`
- `frontend/src/hooks/useScenarios.ts`
- Edits to `frontend/src/pages/tax/PersonalT1Tab.tsx`

P8:
- `backend/src/migrations/<ts>-household-plans.js`
- `backend/src/models/HouseholdPlan.ts`
- `backend/src/tax/scenarios/integrationRouter.ts` (replaces engine/scenario.ts)
- `backend/src/tax/scenarios/computeHouseholdPlan.ts`
- `backend/src/routes/tax-household-plans.ts`
- `frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx` (replaces existing OwnerCompPlannerTab)
- `frontend/src/pages/tax/scenarios/HouseholdPlanPicker.tsx`
- Edits to `frontend/src/pages/tax/CorpT2Tab.tsx`, `frontend/src/pages/tax/OverviewTab.tsx`
- Delete `backend/src/tax/engine/scenario.ts` (logic moved to scenarios/ subtree)

P9:
- `backend/src/migrations/<ts>-carryforwards-scenario-id.js`
- `backend/src/tax/scenarios/projectFactsFromPrevYear.ts`
- `frontend/src/pages/tax/scenarios/YearStripNav.tsx`
- Edits to `PersonalT1Tab.tsx`, `CorpT2Tab.tsx`

P10:
- `backend/src/tax/scenarios/splitRules.ts` (pension split, spousal RRSP)
- `backend/src/tax/scenarios/attributionRules.ts`
- Frontend household rollup view

P11:
- Multi-corp scenario linkage extensions
- Part IV + intercorp dividend handling in `integrationRouter.ts`

P12:
- `backend/src/tax/scenarios/retirementProjection.ts`
- Lifetime view UI

---

## 15. What this design explicitly does NOT do

- Modify the existing pure `t1.ts` or `t2.ts` engines
- Re-document existing Phase 1–4 work (canonical: prior specs)
- Add CRA NETFILE / e-filing
- Add jurisdictions outside CA / provinces outside ON (engine has the structure to add later)
- Replace any of the existing Slips, Carryforward, ShareholderLoan, Instalment models
- Rework the existing `TaxReturn` snapshot cache (parallel `scenario_returns` table is the new cache; existing snapshot remains for non-scenario API path)

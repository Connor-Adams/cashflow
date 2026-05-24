# Tax Tab — Design

**Date:** 2026-05-24
**Status:** Draft (awaiting user review)
**Author:** Connor Adams
**Context:** Canadian filing-grade tax engine (personal T1 + corporate T2, Ontario) layered on existing Cashflow data.

---

## Goals

1. Surface a tax tab in the app that estimates, to filing-grade precision, both personal (T1) and corporate (T2) tax liability for any open or filed year.
2. Reuse existing categorized transactions, investment activity, and FX rates so the estimate stays current as data lands.
3. Keep math in a pure, testable engine separated from data and UI, so correctness is provable against CRA-published examples and prior filed returns.
4. Lay down schema once, so phases 2–5 layer features without rework.

Non-goals for the program: replacing accountant judgment on novel transactions; e-filing; supporting jurisdictions outside Canada / provinces outside Ontario in Phase 1.

---

## Constraints

- **Jurisdiction:** Personal and corp both Ontario. Federal + ON provincial only.
- **Entity types:** Personal (T1) and CCPC corp (T2). Corp income mix: active business (SBD-eligible) + capital gains. Owner draws via dividends + shareholder loan.
- **Precision:** Filing-grade. Tax payable must reconcile within $1 of CRA examples and within $1 of prior filed returns supplied as fixtures.
- **Year scope:** Multi-year (3–7 yrs) for carryforwards (net capital loss, RRSP room, GRIP, CDA, ERDTOH/NERDTOH, non-cap loss, instalments paid, AAII history).
- **Tech stack:** Postgres (prod) + SQLite (dev). Sequelize ORM. React + Vite frontend. Decimal arithmetic mandatory in dollar math (`decimal.js`).
- **Reporting currency:** CAD. Non-CAD amounts converted via existing `FxRate` (Bank of Canada source) before entering engine.

---

## Architecture

Three layers, each independently testable:

```
┌─────────────────────────────────────────────────────────┐
│  UI: TaxPage (frontend/src/pages/TaxPage.tsx)           │
│  Tabs: Overview · Personal T1 · Corp T2 · Slips · Plan  │
└───────────────────────────┬─────────────────────────────┘
                            │ REST
┌───────────────────────────▼─────────────────────────────┐
│  API: backend/src/routes/tax.ts                          │
│  GET  /api/tax/years                                     │
│  GET  /api/tax/personal/:year/return                     │
│  GET  /api/tax/corp/:fiscalYear/return                   │
│  POST /api/tax/slips                                     │
│  GET  /api/tax/carryforwards                             │
│  POST /api/tax/scenarios                                 │
└───────────────────────────┬─────────────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌─────────────┐    ┌─────────────────┐   ┌──────────────┐
│ Data layer  │    │  Tax engine     │   │ Carryforward │
│ (Sequelize) │    │  (pure TS lib)  │   │ ledger       │
│             │    │                 │   │              │
│ + Entity    │    │ buildT1(facts)  │   │ CapLoss      │
│ + TaxLine   │    │ buildT2(facts)  │   │ RRSPRoom     │
│ + Slip      │    │ integration()   │   │ GRIP/CDA     │
│ + Carryfwd  │    │ instalments()   │   │ AAII history │
│ + ShareLoan │    │                 │   │ ERDTOH       │
└─────────────┘    └─────────────────┘   └──────────────┘
```

The engine is a pure TypeScript module. It accepts a `TaxYearFacts` value (income items, deductions, prior-year carryforwards) plus a year-keyed `RateTable`, and returns a `TaxReturn` with every line, formula trace, and source-input attribution. It performs no IO, no DB access, no FX lookup. FX conversion happens upstream in the builder layer.

---

## Schema additions

New tables and columns. All scoped by `householdId` to match existing multi-tenant pattern.

### `Entity`
```
id              UUID PK
householdId     FK Household
kind            ENUM('personal','corp')
legalName       VARCHAR(160)
jurisdiction    VARCHAR(8)        -- 'CA-ON' for Phase 1
fiscalYearEnd   DATEONLY NULL     -- corp only; personal = Dec 31
createdAt, updatedAt
```

### `TaxCategory`
```
id                  UUID PK
code                VARCHAR(64) UNIQUE     -- 'employment_income', 'office_rent', 'meals_50pct'
label               VARCHAR(160)
t1Line              VARCHAR(8) NULL        -- 'L10100', 'L21200', ...
t2Schedule          VARCHAR(8) NULL        -- 'S1', 'S8', ...
t2Line              VARCHAR(8) NULL
isDeductible        BOOLEAN
businessUseDefault  DECIMAL(5,2) NULL      -- e.g. 100 for office rent; 50 for meals
```

### `TaxSlip`
```
id              UUID PK
entityId        FK Entity
year            INT
slipType        ENUM('T4','T5','T3','T4A','T5008')
issuer          VARCHAR(256)
boxValues       JSONB                      -- { box14: 82000.00, box22: ... }
sourceDocId     UUID NULL                  -- future: link to uploaded PDF
createdAt, updatedAt
```

### `Carryforward`
```
id          UUID PK
entityId    FK Entity
kind        ENUM('cap_loss','rrsp_room','grip','cda','erdtoh','nerdtoh','non_cap_loss','aaii','instalments_paid')
asOfYear    INT
amount      DECIMAL(14,4)
notes       TEXT NULL
createdAt, updatedAt
UNIQUE(entityId, kind, asOfYear)
```

### `ShareholderLoan`
```
id              UUID PK
entityId        FK Entity                  -- corp
ownerUserId     FK User                    -- shareholder
date            DATEONLY
kind            ENUM('advance','repayment','dividend_credit','salary_credit')
amount          DECIMAL(14,4)
transactionId   FK Transaction NULL        -- if backed by a real txn
notes           TEXT NULL
createdAt, updatedAt
```

### `TaxReturn` (snapshot cache)
```
id          UUID PK
entityId    FK Entity
year        INT
computedAt  TIMESTAMPTZ
factsHash   VARCHAR(64)                    -- sha256(canonicalize(facts))
lines       JSONB                          -- TaxLine[]
totals      JSONB                          -- engine totals
warnings    JSONB                          -- string[]
UNIQUE(entityId, year)
```

### Column additions to existing tables
- `Account.entityId` (FK Entity, nullable until backfilled)
- `Account.taxStatus` ENUM(`registered_rrsp`,`registered_tfsa`,`registered_fhsa`,`registered_rrif`,`non_registered`,`n_a`) DEFAULT `n_a` — RRSP contribs deduct, TFSA ignored, non-reg taxable.
- `Transaction.entityId` (FK Entity, denormalized from Account for query speed)
- `Category.taxCategoryId` (FK TaxCategory, nullable)

### Backfill
- Phase 1 migration: create one `Entity{kind:'personal'}` per household, assign to every existing Account where `taxStatus` is not corp-flagged, then propagate to Transactions.
- Corp Entity is created manually in Phase 3 via UI; Phase 1 ships personal only.

---

## Engine module layout

`backend/src/tax/`:

```
tax/
  engine/
    t1.ts            # personal return assembly
    t2.ts            # corp return (Phase 3)
    integration.ts   # dividend gross-up + DTC math
    brackets.ts      # year-keyed rate-table lookup
    cpp-ei.ts        # contribution calcs
    capital-gains.ts # ACB + 50% inclusion + superficial loss
    dividends.ts     # eligible/non-eligible gross-up + DTC
    credits.ts       # BPA, spousal, age, DTC, medical, donation
    instalments.ts   # quarterly liability schedule
    types.ts         # TaxYearFacts, TaxReturn, TaxLine
  builders/
    buildPersonalFacts.ts
    buildCorpFacts.ts          # Phase 3
  data/
    rates-2024.ts              # frozen
    rates-2025.ts              # frozen
    rates-2026.ts              # current
```

Year-keyed rate files are immutable per filed year. A new year is a new file. Old files never edit.

### Engine type contract

```ts
type TaxReturn = {
  year: number
  lines: TaxLine[]
  totals: {
    totalIncome: Decimal        // L15000
    netIncome: Decimal          // L23600
    taxableIncome: Decimal      // L26000
    federalTax: Decimal
    provincialTax: Decimal
    cppContrib: Decimal
    eiPremium: Decimal
    totalPayable: Decimal       // L43500
    refundOrOwing: Decimal      // L48400/48500
  }
  warnings: string[]
}

type TaxLine = {
  code: string                  // 'L10100', 'L12700', ...
  label: string
  amount: Decimal
  inputs: { source: string, amount: Decimal }[]
  formula?: string
}
```

`TaxLine.inputs` powers the UI's "click line → source items" without re-querying.

---

## Data flow (read path)

```
GET /api/tax/personal/2026/return
  → requireAuth → resolveEntity(householdId, kind=personal)
  → check TaxReturn snapshot: cached && factsHash matches?
      ├─ yes → return cached
      └─ no  → buildPersonalFacts(entityId, year)
                  - Transactions where entityId AND date in year
                  - InvestmentActivity via Account.entityId join
                  - TaxSlip rows for (entityId, year)
                  - Carryforward rows for (entityId, asOfYear: year-1)
                  - FxRate lookups → all amounts CAD
                  → TaxYearFacts
              → engine.buildT1(facts, ratesFor(year))
              → persist TaxReturn snapshot
              → return
```

**Snapshot invalidation:** `factsHash` is sha256 of the canonicalized `TaxYearFacts`. Computed on every request; mismatch with snapshot triggers recompute. Cheaper than per-row triggers and correct under any mutation path.

---

## Error handling

- Engine throws `TaxComputationError` with `{line, reason, facts}` only on impossible state (e.g. negative income on L12700 after applying losses, indicating bad ACB). Route catches → 500 with safe message + full context to logs.
- Missing rate table for the requested year → `RateTableMissingError` at engine init. UI banner: "Rate table for 2027 not yet encoded. Add `backend/src/tax/data/rates-2027.ts`."
- Missing carryforward seed → engine treats as 0, emits warning. UI shows "No prior-year carryforward seeded — losses may be undercounted."
- Slip vs computed divergence > $50 → warning in `TaxReturn.warnings`, badge in UI.
- No silent fallbacks. No try/catch swallowing.

---

## Testing strategy

Three tiers.

### 1. Engine unit tests (`backend/src/tax/engine/__tests__/`)
- `brackets.test.ts`: every federal + ON bracket boundary at $0.01 above/below threshold for 2024/2025/2026.
- `dividends.test.ts`: eligible gross-up 38% + DTC 15.0198%; non-eligible 15% + DTC 9.0301%; assert published CRA examples.
- `capital-gains.test.ts`: 50% inclusion, ACB with partial dispositions, superficial loss (30-day rule).
- `cpp-ei.test.ts`: 2026 YMPE/YAMPE split, enhanced CPP additional contribution.
- `credits.test.ts`: BPA phase-out for high earners, spousal reduction by spouse net income.
- `t1.test.ts`: ≥5 CRA-published full-return scenarios + ≥3 prior filed returns supplied as fixtures.

### 2. Builder integration tests (`backend/src/tax/builders/__tests__/`)
- Seeded DB with known txns/slips/activity → `buildPersonalFacts` produces expected `TaxYearFacts`.
- FX: USD interest at Bank of Canada rate → CAD amount within Decimal precision of expected value.
- Slip override path: T4 box 14 = $80k, computed wage txns = $78k → facts include both, T1 uses slip (filing-grade rule: slip wins).

### 3. API/route tests (`backend/src/routes/__tests__/tax.test.ts`)
- GET return for entity-less household → 404 with seed instruction.
- Snapshot cache hit/miss correctness (mutate txn → next GET recomputes).
- Auth: cross-household access denied.

### Frontend tests
- `TaxPage.test.tsx`: tab routing, empty-state (no entity), error banner rendering.
- `PersonalT1Tab.test.tsx`: line expansion shows source items, warnings render.

**Phase 1 test budget:** ≥60 engine, ≥10 builder, ≥6 route, ≥4 UI.

### Verification before merge
- All tests green.
- Engine run against your last 2 filed personal returns: total tax payable within $1.
- Manual: launch dev server, navigate to /tax, confirm Overview renders against real data.
- Manual: T4 entry → return recomputes → snapshot updates.

---

## Phase plan

Each phase is its own spec + plan + PR.

### Phase 1 — Personal T1 (federal + ON), current year
**Scope IN**
- All schema migrations listed above.
- Engine modules: t1, brackets, cpp-ei, capital-gains, dividends, credits, integration (stub), instalments. Rate files 2024/2025/2026.
- `buildPersonalFacts`.
- Routes: `GET /api/tax/entities`, `GET /api/tax/personal/:year/return`, `POST /api/tax/slips`, `GET /api/tax/carryforwards`, `POST /api/tax/carryforwards` (manual seed).
- UI: `/tax` sidebar entry. `TaxPage.tsx` with tabs Overview, Personal T1, Slips.
- Reconciliation indicator: each income line shows computed vs slip-declared with diff badge.

**Personal credits covered:** BPA, spousal, age, CPP/EI contributions, employment amount, dividend tax credit, basic medical, donations.

**Deferred to Phase 2:** DTC, caregiver, tuition, pension income, FHSA, OAS clawback edge cases.

**Self-employment treatment:** Phase 1 treats `Transaction.business=true` where `entityId=personal` as T2125 self-employment. Explicit T2125 model deferred to Phase 3.

### Phase 2 — T-slip ingestion polish
- Manual entry UI for every slip type.
- PDF parse for T4, T5, T3 (own sub-project; may slip into separate spec).
- Reconciliation queue: divergence > $50 surfaced for user review.
- Add deferred personal credits (DTC, caregiver, tuition, pension income, FHSA contribution deduction, OAS clawback).

### Phase 3 — Corporate T2
- Engine modules: t2, SBD calc, AAII grind, integration math (eligible vs non-eligible dividend designation, GRIP, CDA).
- Builder: `buildCorpFacts`.
- Schema: `T2125` model (explicit self-emp), `ShareholderLoan` ledger UI.
- UI: Corp T2 tab. Owner-comp planner (salary vs dividend mix).

### Phase 4 — Carryforwards + multi-year
- Auto-compute carryforward roll-forward (cap loss applied, GRIP additions, CDA additions, AAII running total, RRSP room earned, non-cap loss).
- Multi-year compare view.
- Instalment payment tracker.

### Phase 5 — Scenarios + instalment optimizer
- "If I draw $X dividend, total household tax = $Y."
- Optimal salary/div split for current corp+personal joint liability.
- Instalment safety margin calculator.

---

## Risks and open questions

1. **Account tax-status mismatch.** Existing `accountType='investment'` is ambiguous. The migration adds `taxStatus` defaulting to `n_a`; user must classify each investment account before T1 numbers are correct. Phase 1 UI must surface this gap on first run.
2. **Slip-vs-computed divergence rules.** "Slip wins for income line, but computed remains visible" is the chosen rule. May need to revisit if a slip is materially wrong and user wants to override the slip — Phase 2 should add a per-slip override flag.
3. **Engine vs CRA tax-form upgrades.** Annual rate-table file freezes once filed, but new credits / line renumbering each year still need code. Acceptable maintenance cost; document yearly update checklist in Phase 1.
4. **Decimal precision contagion.** Every engine path must use `Decimal`. ESLint rule or runtime guard recommended to forbid `number` in engine module imports. Add as Phase 1 lint config item.
5. **Multi-currency household.** FX rate is daily; intra-day txn timing not modelled. Acceptable for filing-grade per CRA practice (use Bank of Canada daily noon/close).
6. **Backfill correctness.** Phase 1 migration creates a default Personal entity and assigns all existing accounts to it. If user has corp data already in the same household (e.g. corp txns flagged `business=true` but no entity dim today), they will be miscategorized as personal until Phase 3 + manual reassignment. Phase 1 UI must call this out.

---

## Files Phase 1 touches/creates

**New migrations** (`backend/src/migrations/`):
- `add-entity-table.js`
- `add-entity-id-to-accounts-and-txns.js`
- `add-tax-status-to-accounts.js`
- `add-tax-category-table.js`
- `add-tax-category-id-to-categories.js`
- `add-tax-slip-table.js`
- `add-carryforward-table.js`
- `add-tax-return-snapshot-table.js`

**New models** (`backend/src/models/`):
- `Entity.ts`
- `TaxCategory.ts`
- `TaxSlip.ts`
- `Carryforward.ts`
- `TaxReturn.ts`

**New engine** (`backend/src/tax/`): full tree above.

**New route**: `backend/src/routes/tax.ts`.

**Edits**:
- `backend/src/models/Account.ts` (+entityId, +taxStatus)
- `backend/src/models/Transaction.ts` (+entityId)
- `backend/src/models/Category.ts` (+taxCategoryId) — if Category model exists; if categories are free-text VARCHAR on Transaction, add `TaxCategoryMap` join instead.

**New frontend**:
- `frontend/src/pages/TaxPage.tsx`
- `frontend/src/pages/tax/OverviewTab.tsx`
- `frontend/src/pages/tax/PersonalT1Tab.tsx`
- `frontend/src/pages/tax/SlipsTab.tsx`
- `frontend/src/hooks/useTaxReturn.ts`
- `frontend/src/hooks/useTaxSlips.ts`

**Edits**:
- `frontend/src/App.tsx` (+route)
- `frontend/src/components/Sidebar.tsx` (+nav item "Tax")

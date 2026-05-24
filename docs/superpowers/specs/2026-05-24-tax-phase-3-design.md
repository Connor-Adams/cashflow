# Tax Phase 3 — Corporate T2 — Design

**Date:** 2026-05-24
**Status:** Active
**Context:** Builds on Phase 1 (PR #118) + followups (#125) + Phase 2 PR 1 (#127). Adds CCPC corporate T2 federal + Ontario, integration math, owner-draw planner.

---

## Goals

1. Compute T2 federal + ON tax for a CCPC corporation entity:
   - Active business income (ABI) with Small Business Deduction (SBD) on first $500k
   - General rate income above $500k
   - Investment income (passive): high refundable rate + RDTOH tracking
   - Capital gains (50% inclusion, CDA tracking)
   - Aggregate Adjusted Investment Income (AAII) — grinds SBD if >$50k
2. Integration math: shareholder dividend designation (eligible vs non-eligible), GRIP balance, CDA capital dividend balance
3. Shareholder loan ledger surface in UI
4. Owner-comp planner: salary vs dividend mix optimization (Phase 3 ships read-only; Phase 5 optimizes)
5. Corp T2 tab in UI

## PR plan

### PR 1: T2 engine + rate-table additions
1. **New engine modules**:
   - `backend/src/tax/engine/t2.ts` — T2 assembly (analogous to t1.ts)
   - `backend/src/tax/engine/sbd.ts` — Small Business Deduction calc with AAII grind
   - `backend/src/tax/engine/aaii.ts` — Adjusted Aggregate Investment Income compute
   - `backend/src/tax/engine/integration.ts` — fill the Phase 1 stub: corp→personal dividend designation (eligible vs non, by GRIP balance), GRIP roll-forward, CDA roll-forward, RDTOH (ERDTOH + NERDTOH)
2. **Types** (`backend/src/tax/engine/types.ts`):
   - `CorpTaxYearFacts` — fiscal year, ABI, AII, capital gains events, dividends paid (eligible/non), shareholder loans, prior-year GRIP/CDA/ERDTOH/NERDTOH, salary paid
   - `CorpTaxReturn` analog of TaxReturn
3. **Rate-table additions**:
   - `corpAbiSbdRateFederal: D('0.09')`, `corpAbiSbdRateOntario: D('0.032')`  (combined ~12.2% ON)
   - `corpGeneralRateFederal: D('0.15')`, `corpGeneralRateOntario: D('0.115')` (combined 26.5% ON)
   - `corpInvestmentRateFederal: D('0.387')`, `corpInvestmentRateOntario: D('0.115')` (refundable portion)
   - `corpRefundableTaxOnAII: D('0.1067')` — Part IV/passive
   - `corpSbdAnnualLimit: D('500000')`
   - `corpAaiiGrindThreshold: D('50000')`, `corpAaiiGrindRate: D('5')` ($5 SBD lost per $1 AAII above $50k)
   - `corpDividendRefundRate: D('0.3833')` (RDTOH formula: refund = lesser-of(RDTOH, divs × 0.3833))
   - `corpEligibleDividendRefundRate: D('0.3833')`
4. **Tests**: per-module unit tests + 3+ CRA-published or accountant-verified T2 scenarios.

### PR 2: Builder + Routes
1. `backend/src/tax/builders/buildCorpFacts.ts` — reads Corp Entity, accounts, transactions tagged as corp income/expense; classifies ABI vs investment income
2. New `ShareholderLoan` table reads (Phase 1 already created the table; this PR exposes routes)
3. Routes:
   - `GET /api/tax/corp/:fiscalYear/return`
   - `GET /api/tax/corp/shareholder-loans`
   - `POST /api/tax/corp/shareholder-loans` (add advance/repayment/dividend-credit/salary-credit)
4. Snapshot caching via factsHash (reuse Phase 1 pattern with `entityId` keyed on corp)

### PR 3: Frontend Corp T2 tab + owner-comp planner
1. New Tax tab "Corp T2"
2. Year-end selector for fiscal year (corp can be non-calendar)
3. Line-by-line T2 return view (like Personal T1)
4. ShareholderLoanTab: list + add transactions
5. Owner-comp planner stub: enter intended draw amount, show resulting personal + corp combined tax. (Phase 5 will optimize)

## Out of scope (Phase 3)
- T2125 explicit self-emp model (defer; sole-prop continues via Transaction.business)
- Carryforward auto-roll (Phase 4)
- Owner-comp OPTIMIZATION (Phase 5; Phase 3 ships manual entry only)
- Foreign income (FAPI, T1134)
- Non-CCPC corp types

## Risks
- Integration math is the hardest part. GRIP additions, CDA non-taxable portions of cap gains, ERDTOH/NERDTOH split (post-2019) are easy to get wrong. Test against CRA-published T2 examples.
- Fiscal year ≠ calendar year — engine must accept arbitrary start/end dates.
- Corp transactions may not be tagged as "corp" today since Phase 1 backfill assigned everything to Personal. User will need to reassign accounts to Corp entity before Phase 3 UI works.

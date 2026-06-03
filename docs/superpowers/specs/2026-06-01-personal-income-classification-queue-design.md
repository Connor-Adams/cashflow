# Personal Income Classification Queue — Design

- **Date:** 2026-06-01
- **Status:** Approved design; pending implementation plan
- **Author:** Connor (with Claude)
- **Topic:** Make the baseline Personal T1 reflect *real* personal income (payroll + corp→personal distributions) by classifying bank-statement transactions, per-transfer, into tax treatments.

## Problem

The Personal T1 baseline (the "actuals" the user sees on the Personal T1 tab) reports income far below reality. Investigation (prod, entity #1, 2025) confirmed the **tax engine math is correct** — the inputs are incomplete:

- Captured taxable investment income ≈ **$193** (38 Alpha-Vantage-synthetic ETF dividends $191.91 + $1.40 interest) + ~$481 realized gains → total income ~$507.
- **Employment income L10100 = $0** despite the user receiving payroll.
- **Corp→personal distributions** (owner draws, the large `Transfer`/`Payment` flows ~$44–48k) are not represented as dividends, salary, or shareholder-loan movements.

The engine faithfully computes whatever income facts it is given; the gap is that payroll and corp distributions never become income facts. Source-of-truth investigation: `backend/src/tax/engine/t1.ts`, `backend/src/tax/builders/buildPersonalFacts.ts`.

## Goal

A single, phased feature: an **income classification queue** that surfaces unclassified income-bearing bank transactions and lets the user assign each a tax treatment, which then flows into the **baseline** (actuals) Personal T1 — and, for corp distributions, the corp T2 and shareholder-loan balance.

Covers two income streams in one spec:
1. **External payroll** → employment income (L10100).
2. **Corp→personal distributions** → eligible/non-eligible dividend, salary, or shareholder-loan advance/repayment.

Classification model: **per-transfer** (each corp→personal transfer tagged individually; no year-end lump declaration).

## Non-goals

- The OwnerComp planning sliders + `integrationRouter` (projection/scenario path) are **unchanged**. This feature feeds *actuals*, not projections.
- No auto-generation of T4/T5 slips in P1–P2 (P3 optional).
- Capital dividends, s.15(2) shareholder-loan-inclusion rules: out of scope for P1–P2.
- The capital-gains ACB/cost-basis accuracy issue (gains ≈ proceeds because ACB ≈ $0) is a **separate** problem, tracked independently.

## Background — existing infrastructure (this is mostly wiring)

Three overlapping mechanisms exist today:

1. **Real Transactions.** Transfer pairs auto-link bidirectionally on import (`linkedTransactionId`/`transferLinkedAt`, commit 9fa14e37). `Transaction` fields: `txnType` (incl. `'income'`,`'transfer'`,`'dividend'`), `transferPurpose` (`owner_draw` corp→personal, `owner_contribution` personal→corp, …), `entityId` (from `account.entityId`; **currently unused in transfer logic**), `finalCategory`, `reviewFlag`/`reviewedAt`. Payroll **is already auto-detected**: `backend/src/import/enrichment/detectTypeStage.ts` sets `txnType='income'` on payroll/salary/paycheque + "direct deposit from" narratives.
2. **`ShareholderLoan` ledger** (`backend/src/models/ShareholderLoan.ts`, table `shareholder_loans`). Kinds `advance|repayment|dividend_credit|salary_credit`. Append-only, **no balance column**, **not linked to Transaction**. Feeds corp T2 (`buildCorpFacts.ts` 142–165: `dividend_credit`→`CorpDividendPaid`, `salary_credit`→`salaryPaid`). Entered by hand (`ShareholderLoanTab.tsx`).
3. **OwnerComp planning levers.** `Scenario.overrides.ownerComp.<id>.{salary,bonus,eligibleDividend,nonEligibleDividend,capitalDividend}` → `OwnerCompLeverSurface.tsx` sliders → `integrationRouter.ts` routes to personal facts. **Projections only.**

**Key gaps:**
- (a) Detected payroll (`txnType='income'`) is **not** mapped to `finalCategory='employment_income'`, so it never reaches L10100 (`buildPersonalFacts` reads only `finalCategory==='employment_income'` or a T4 box14).
- (b) `IncomeEntry` primitive (issue #434, merged: gross/taxWithheld/net cents, `source` enum, optional `linkedTransactionId`) is **not** read by the tax builders.
- (c) `transferPurpose='owner_draw'` does **not** flow to T1.
- (d) `ShareholderLoan` rows are hand-typed, disconnected from the real auto-linked corp→personal transactions.

## Spine check (per CLAUDE.md)

- **Which primitive does this extend?** `Transaction`. A tax treatment is new *behavior/variant* of a transfer → a field on the owning primitive.
- **Persistent or derived?** The treatment is persistent (one field). The queue and the shareholder-loan balance are **derived** (queries) — no new table.
- **Mirror an existing machine?** No new status machine. Reuses the transfer-link + `reviewFlag` lifecycle.

**Conclusion: no new primitive.** Extends `Transaction` + adds derivations into existing engines. Not a spine change.

## Architecture (Approach 1 — treatment on the transfer pair)

Chosen over (2) auto-creating `ShareholderLoan` rows and (3) `IncomeEntry`-centric. Approach 1 keeps a single source of truth on the transaction, reuses transfer-linking and *both* tax engines, and cleanly separates actuals from planning.

### Data model

Add nullable `taxTreatment: string | null` to `Transaction`, set on the corp↔personal transfer leg(s).

| `taxTreatment` | personal T1 effect | corp T2 effect | loan balance |
|---|---|---|---|
| `eligible_dividend` | L12000 (×(1+grossUpEligible) + DTC) | dividend paid (kind=eligible), GRIP draw | — |
| `non_eligible_dividend` | L12010 (×(1+grossUpNonEligible) + DTC) | dividend paid (kind=non_eligible) | — |
| `salary` | L10100 employment income | deductible remuneration (`salaryPaid`) | — |
| `loan_advance` (corp→personal) | not income | — | **+** balance |
| `loan_repayment` (personal→corp) | not income | — | **−** balance |
| `employment_income` (external payroll) | L10100 | — | — |
| `not_income` (internal/reimbursement) | excluded | excluded | — |
| `null` | — | — | **appears in queue** |

- Stored on **both legs** of a linked pair (same convention as `transferPurpose` today); single value, each engine derives its own view. Single (unpaired) legs carry the value alone.
- **Eligible vs non-eligible:** per-transfer pick; default `non_eligible_dividend` (CCPC norm). Warn if Σ eligible dividends > corp GRIP (reuse `integrationRouter` warning logic).
- A new field is used (not an overload of `transferPurpose`, which encodes transfer-link direction semantics). `transferPurpose='owner_draw'` may later seed a *suggested* treatment (P3).

### Queue derivation (a view, no table)

Items appearing in the queue:
1. Linked transfer pairs where one leg's `account.entityId` is a **corp** entity and the other a **personal** entity in the same household, with `taxTreatment = null`.
2. Personal-account deposits with `txnType='income'` (detected payroll) and no treatment.

Reuses `reviewFlag` / the unmatched-transfers queue patterns. Scoped to the caller's household.

### Derivations into the engines (actuals/baseline)

**`buildPersonalFacts(personalEntity, year)`** — new treatment-read pass alongside existing InvestmentActivity/slip logic:
- `eligible_dividend` → `eligibleDividends[]`; `non_eligible_dividend` → `nonEligibleDividends[]`; `salary` → `employmentIncome[]`. `loan_*`/`not_income` ignored for income.
- Corp dividends are not in `InvestmentActivity`, so there is **no overlap** with brokerage dividends.

**Double-count guards (the sharp edges):**
1. External payroll continues to use the **existing** `finalCategory==='employment_income'` sum (the queue sets that on confirm). Corp `salary` uses the new `taxTreatment` path. A corp→personal salary deposit may *also* be auto-tagged `txnType='income'`; to prevent counting it twice, the `finalCategory==='employment_income'` sum **excludes any row that has a non-null `taxTreatment`**. Both still feed L10100 via distinct rows.
2. The T4-box14 preference and the >$50 reconciliation warning in `t1.ts` (39–54) remain; computed employment = external payroll + corp salary.

**`buildCorpFacts(corp, fiscalYear)`** — extend today's `ShareholderLoan` reads:
- classified `eligible/non_eligible_dividend` legs → `CorpDividendPaid` with the **correct kind** (fixes today's hardcoded non-eligible default).
- classified `salary` legs → `salaryPaid` (deductible).
- **Coexistence guard:** cash distributions come from classified transactions; manual `ShareholderLoan` rows remain only for **non-transaction** entries (opening balance, non-cash bookings). The same money is never counted from both sources.

**Shareholder-loan balance (derived; shown on `ShareholderLoanTab`):**

```
balance = Σ manual(advance + dividend_credit + salary_credit − repayment)
        + Σ classified transfers(loan_advance − loan_repayment)
```

Semantic note: a **per-transfer dividend/salary is a cash distribution** and does *not* move the loan balance — only `loan_advance`/`loan_repayment` do. (The manual ledger's `dividend_credit`/`salary_credit` "draw down the loan" meaning is a different, non-cash booking; both coexist.)

### API

- `GET /api/tax/classification-queue?entityId=&year=` → unclassified corp↔personal pairs + detected payroll deposits for the entity/year.
- `PATCH /api/transactions/:id/tax-treatment` → set `taxTreatment` on the pair (both legs), stamp `reviewedAt`. Payroll confirm additionally sets `finalCategory='employment_income'`. Recompute follows the existing facts-hash invalidation.

### UI

- New view, likely folded into the existing tax **Reconciliation** tab. One row per unclassified item: pair (date, amount, `corp acct → personal acct`, narrative) or payroll deposit. Per-row treatment dropdown; dividend rows expose an eligible/non-eligible toggle (default non-eligible). Confirm sets the treatment, drops the row, recomputes T1.
- Mirrors `PATCH /api/transfers/:id/purpose` (already writes both legs) and `reviewFlag` queue conventions.
- `ShareholderLoanTab` gains the computed balance widget.

## Phasing

- **P1 — backend wiring.** `taxTreatment` field + migration; `buildPersonalFacts` + `buildCorpFacts` derivations + the two double-count guards; balance derivation; treatment-set API. Baseline T1 becomes correct as soon as treatments are set (even via API/script). Unit + integration tests.
- **P2 — queue UI.** The classification surface + per-row assignment + `ShareholderLoanTab` balance display; reuse transfer-queue components.
- **P3 — assists (optional).** Auto-suggest treatment (recurring round-number corp→personal = salary; ad-hoc = loan; …), bulk apply, per-counterparty/account default policy, `capital_dividend`, auto-generate T4/T5 from classified rows, `IncomeEntry` gross/withheld capture for source-deduction-aware payroll.

## Edge cases

- **Unpaired leg** (only the personal side imported): still classifiable on the single leg; corp side absent → corp T2 won't see it → surface a warning.
- **Eligible > GRIP:** reuse the existing `integrationRouter` warning.
- **Reclassification:** changing a treatment triggers an idempotent recompute.
- **Mixed currency / FX transfers:** `toCad` already handles magnitude; treatment unaffected.
- **Household scoping:** queue and treatment writes restricted to the caller's household.

## Testing

- **Unit:** each treatment → correct T1 line (gross-up factor, DTC), corp `CorpDividendPaid` kind, `salaryPaid`, balance arithmetic. Both double-count guards (a corp-salary deposit tagged both `txnType='income'` and `taxTreatment='salary'` counts once; a classified corp dividend does not overlap `InvestmentActivity`).
- **Integration:** classify a corp→personal pair via API → baseline T1 L12010 rises by the grossed amount and corp dividend-paid rises; `loan_advance` moves the balance, not income; payroll confirm raises L10100.
- **Regression:** OwnerComp/`integrationRouter` projection outputs unchanged.

## Open questions / future

- Should the manual `ShareholderLoan` entry UI eventually be demoted to "non-transaction adjustments only" once the queue covers cash flows? (Deferred; both coexist for now.)
- P3 auto-suggest heuristics and per-counterparty default policies need their own small design when reached.

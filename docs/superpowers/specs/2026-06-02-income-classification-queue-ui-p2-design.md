# Income Classification Queue — UI (P2) Design

- **Date:** 2026-06-02
- **Status:** Approved design; pending implementation plan
- **Author:** Connor (with Claude)
- **Topic:** The frontend that lets the user classify corp→personal transfers + payroll into tax treatments, feeding the baseline Personal T1. Backend wiring (P1) merged in [PR #504](https://github.com/Connor-Adams/cashflow/pull/504).

## Problem

P1 wired `taxTreatmentOverride` into the baseline Personal T1 / corp T2 / shareholder-loan balance and shipped the endpoints (`GET /api/tax/classification-queue`, `PATCH /api/transfers/:id/tax-treatment`). But there is **no UI** to do the classifying — so the T1 still shows no payroll and unclassified owner draws. P2 builds that UI.

## Goal

A dedicated **Classify** tab in the Tax page that surfaces unclassified corp→personal transfer pairs + detected payroll deposits for a personal entity + year, and lets the user assign each a tax treatment with **instant per-row save**. Plus a shareholder-loan balance readout on the existing Shareholder Loans tab.

## Decisions (settled during brainstorming)

- **Home:** a new `Classify` tax tab — chosen over extending the Review Inbox (which is import-triage-oriented, bulk, and not pair-aware).
- **Save:** instant per-row (pick treatment → one PATCH → row checks off and collapses into a Classified section, with Undo). Not batch.
- **Picker:** a treatment dropdown **scoped by row kind**.
- Reuses the P1 endpoints; no change to the actuals/engine logic.

## Spine check

No new primitive. P2 is frontend over existing endpoints + a thin backend enrichment (display fields + exposing an already-computed balance). The treatment lives on the existing `Transaction.taxTreatmentOverride` (main's field).

## Architecture

### Frontend

**Tab registration** — add `{ value: 'classify', label: 'Classify' }` to `TaxPage.tsx` TABS (after `reconciliation`) + a conditional render of `<ClassifyTab year={year} />`. Resolve the household's personal entity the same way `PersonalT1Tab` does.

**Hook** — `useClassificationQueue(entityId, year)` (mirrors `useReconciliation`): `GET /api/tax/classification-queue?entityId=&year=` → `{ corpDistributions: [{personal, corp}], payroll: [] }`; returns `{ data, loading, error, reload }`.

**Components (small, single-responsibility):**
- `frontend/src/components/TaxTreatmentSelect.tsx` — reusable scoped dropdown. Props: `value: TaxTreatment | null`, `onChange(next)`, `options: TaxTreatment[]`, `placeholder?`. Renders options via `TREATMENT_LABELS`. (The new tab uses it; the 3 existing hand-rolled selects are left as-is — DRY-ing them is a P3 follow-up.)
- `frontend/src/pages/tax/ClassifyTab.tsx` — fetches the queue; renders **Corp → personal** and **Payroll** sections, a collapsed **Classified** section, and an empty state ("No unclassified income for {year}.").
- `frontend/src/pages/tax/ClassifyRow.tsx` — one row, param'd by kind. Shows date, amount, `corp acct → personal acct` (payroll: source), narrative, and a scoped `TaxTreatmentSelect`. On select → PATCH; on success optimistically move to Classified with an **Undo** (re-PATCH `null`); on failure keep the row + inline error.

**Scoped options:**
- corp→personal pair: `eligible_dividend`, `non_eligible_dividend`, `salary`, `loan_advance`, `loan_repayment`, `not_income`.
- payroll: `employment_income`, `not_income`.

**Save target:** for a pair, PATCH the **personal leg's** id (the endpoint sets both legs); for payroll, PATCH the txn id.

### Backend (thin additions)

- **Enrich the queue response** (`backend/src/routes/tax.ts`, the `/classification-queue` handler): include each leg's `accountName` (join/lookup `Account.name`) alongside the txn, so rows can render `Corp Chq → Personal Chq`. Keep `merchantClean`/counterparty already present on the txn.
- **Expose the loan balance**: add a `balance` field to the `GET /api/tax/corp/shareholder-loans` response, computed via the existing `computeShareholderLoanBalance(corpEntityId)`. `ShareholderLoanTab` renders it.

## Data flow (one classification)

1. User picks a treatment in a row's `TaxTreatmentSelect`.
2. `ClassifyRow` calls `PATCH /api/transfers/:personalLegId/tax-treatment { taxTreatmentOverride }`.
3. On 200: row moves to the Classified section (Undo available); `reload()` refreshes counts. The next baseline T1 compute reflects it (facts hash changes → recompute).
4. On error: row stays, inline error shown.

## Edge cases

- **Empty queue** → empty state, no sections.
- **PATCH failure** → no optimistic move; inline error on the row; treatment select reverts to unset.
- **Classified elsewhere** (e.g. TransactionsPage sets `taxTreatmentOverride`) → simply absent from the queue (the GET filters `taxTreatmentOverride = null`). Consistent.
- **Year with no corp entity** → empty corp→personal section; payroll can still list.
- **Undo** → `PATCH … { taxTreatmentOverride: null }`, row returns to its section.

## Testing

- **Frontend** (vitest + testing-library, matching existing frontend tests):
  - `TaxTreatmentSelect`: renders exactly the scoped options + placeholder; fires `onChange` with the selected value.
  - `ClassifyTab`: renders corp + payroll sections from a mocked `useClassificationQueue`; selecting a treatment calls the PATCH fn and moves the row to Classified; Undo reverts; empty state when the queue is empty.
- **Backend** (node:test, isolated per file):
  - `/classification-queue` response includes `accountName` on each leg.
  - `GET /api/tax/corp/shareholder-loans` response includes a correct `balance`.

## Out of scope (→ P3)

Auto-suggest treatments, bulk apply, per-counterparty/account default policy, `capital_dividend`, auto-generate T4/T5 from classified rows, DRY-ing the 3 existing hand-rolled treatment selects, manual-ledger dedup, per-member queue visibility (stays household-scoped).

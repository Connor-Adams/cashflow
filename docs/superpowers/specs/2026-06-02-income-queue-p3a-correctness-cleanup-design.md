# Income Queue P3a — Correctness + Cleanup Design

- **Date:** 2026-06-02
- **Status:** Approved design; pending implementation plan
- **Branch:** `claude/income-queue-p3a` (off `main`)
- **Topic:** Four deferred correctness/cleanup items for the income-classification feature (P1 #504, P2 #512 merged). One real bug fix + privacy scoping + two invisible cleanups.

## Context

Classification is now live end-to-end. This slice closes the correctness/cleanup follow-ups flagged during P1/P2 review. No user-visible feature change except the privacy scope.

## Spine check

No new primitive. All four are fixes/refactors over existing code.

## Items

### 1. Dedup — classified transactions are the sole source of corp-T2 distributions

**Problem:** `backend/src/tax/builders/buildCorpFacts.ts` reads BOTH manual `ShareholderLoan` rows (`dividend_credit`→`dividendsPaid`, `salary_credit`→`salaryPaid`) AND classified transactions (`taxTreatmentOverride`), additively. If the same owner payment is recorded both ways, corp T2 double-counts it.

**Decision (classified-authoritative):** Remove the manual `dividend_credit`/`salary_credit` reads from `buildCorpFacts` (and the now-unused `loanRows` fetch *within that function*). Classified transactions become the sole source for `dividendsPaid`/`salaryPaid`.

**Rationale:** Classification on real transactions is the canonical path; the manual ledger is for non-transaction adjustments. **Prod `shareholder_loans` is empty (0 rows)** — verified 2026-06-02 — so this drops nothing today and is purely forward-correctness. Alternatives (amount+date overlap-skip; reconciliation warning) add complexity for data that doesn't exist.

**Out of scope:** `computeShareholderLoanBalance` still reads manual `advance`/`repayment` + classified `loan_advance`/`loan_repayment`; its own manual-vs-classified overlap is a separate latent item, **not** fixed here (noted in Non-goals).

### 2. Per-member queue visibility scoping

**Problem:** `GET /api/tax/classification-queue` (`backend/src/routes/tax.ts`) filters by `entityId` + household but not transaction visibility, so it can surface another household member's `private` transactions. (The `PATCH /api/transfers/:id/tax-treatment` already scopes via `visibleTransactionWhere` and 404s on them.)

**Fix:** Apply the same visibility predicate (`visibility = 'shared' OR createdByUserId = currentUser`) — the one `transfers.ts` uses as `visibleTransactionWhere(req)` — to both the `personalLegs` query and the `payroll` query in the queue handler. Reuse the existing helper (export/share it from where it lives) rather than duplicating the predicate.

### 3. DRY the treatment selects onto `TaxTreatmentSelect`

**Problem:** three hand-rolled treatment `<select>`s exist: `frontend/src/pages/ReviewInboxPage.tsx`, `frontend/src/pages/TransactionsPage.tsx`, `frontend/src/pages/settings/tabs/CategoriesTab.tsx`.

**Snag (discovered during planning):** the P2 `TaxTreatmentSelect` has a *disabled* placeholder and fires `onChange` only for non-empty values (correct for the Classify queue). But the 3 existing selects need a *selectable* empty option that fires onChange: ReviewInbox "Keep current", TransactionsPage "Use category default", CategoriesTab a full list (incl `none`). So a clean swap isn't possible.

**Fix (generalize, per Connor):** Extend `TaxTreatmentSelect`:
- `onChange: (next: TaxTreatment | null) => void` (now allows `null`).
- new optional `emptyLabel?: string`: when provided, the empty `<option value="">` is **selectable** (not disabled) with that label, and selecting it fires `onChange(null)`. When absent, keep today's disabled `placeholder` behavior. Unified handler: `onChange(value === '' ? null : value as TaxTreatment)`.

Update the one existing consumer `ClassifyRow` so its handler accepts `TaxTreatment | null` (ignores `null`; it runs in placeholder mode so `null` never fires). Then refactor the 3 sites:
- **CategoriesTab:** `options={[...TAX_TREATMENTS]}`, `value={cat.taxTreatment}`, no `emptyLabel`; onChange guards non-null → `setTreatment`.
- **ReviewInboxPage:** `options={TAX_TREATMENTS.filter(t=>t!=='none')}`, `value={taxTreatment || null}`, `emptyLabel="Keep current"`, `onChange={(t)=>setTaxTreatment(t ?? '')}`.
- **TransactionsPage:** same as ReviewInbox but `emptyLabel="Use category default"`, writing `taxOverride`.

Update `TaxTreatmentSelect.test.tsx` (add an `emptyLabel`-selectable → `onChange(null)` case) and any site tests that assert on the old `NativeSelect` markup.

### 4. Queue N+1 → batched lookup

**Problem:** the `/classification-queue` handler does one `Transaction.findByPk(leg.linkedTransactionId)` per personal leg.

**Fix:** Collect all `linkedTransactionId`s, fetch once via `Transaction.findAll({ where: { id: { [Op.in]: ids } } })`, build an id→txn map, and resolve corp legs from the map. Behavior identical; one query instead of N.

## Testing

- **Dedup:** extend `backend/test/tax/taxTreatment-corp.test.ts` — assert that a manual `ShareholderLoan` `dividend_credit` row no longer contributes to `dividendsPaid` (only classified txns do), and classified txns still produce the correct `dividendsPaid`/`salaryPaid`.
- **Visibility:** extend `backend/test/tax/routes-classification-queue.test.ts` — a `private` transaction owned by another household member is excluded from the queue; the caller's own/shared rows still appear.
- **DRY:** each refactored call site keeps its existing tests green; add/adjust a minimal assertion that the treatment select renders its expected options at one site.
- **N+1:** existing `routes-classification-queue` tests already assert the pair shape; confirm they still pass (behavior unchanged). Optionally assert two pairs resolve correctly (exercises the batch map).

## Non-goals (later P3)

`computeShareholderLoanBalance` manual-vs-classified loan dedup; P3b ergonomics (auto-suggest, bulk, per-counterparty defaults); P3c (capital_dividend, T4/T5 generation).

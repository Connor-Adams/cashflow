# Tax reclassification affordance — "Classified" tab

**Date:** 2026-06-02
**Primitive:** Transaction. New *view + behavior* on the existing
classification-queue derivation — not a new primitive, no new table, no new
status machine.

## Problem

`GET /api/tax/classification-queue` (`backend/src/routes/tax.ts:27`) only
surfaces transactions where `tax_treatment_override IS NULL`. Once a
corp→personal distribution or payroll deposit is classified (treatment set on
the relevant legs), it leaves the queue and there is **no in-product way to
change its treatment afterward** — e.g. to reclassify a `non_eligible_dividend`
draw as a `loan_advance`, or fix a mistake.

The frontend `ClassifyTab` has a "Classified · N" section, but it is
**in-session optimistic state only** (`frontend/src/pages/tax/ClassifyTab.tsx:19,21`
— `setClassified([])` on year change). On reload the classified items vanish
from view with no way to see or edit them. Reclassification today requires a raw
`PATCH` or direct SQL on both legs.

## Key finding: the both-legs mutation already exists

A corp→personal distribution is a linked transfer **pair**. The fact builders
read each leg independently and do **not** follow `linkedTransactionId`:

- `buildPersonalFacts.ts:86` reads the **personal** leg's
  `taxTreatmentOverride` → T1 (salary/employment_income→employment income,
  eligible/non_eligible_dividend→dividends, loan_advance/loan_repayment/
  not_income→skipped).
- `buildCorpFacts.ts:170` reads the **corp** leg's override → T2
  (eligible/non_eligible_dividend→dividendsPaid, salary→salaryPaid).
- `shareholderLoanBalance.ts:22` reads the **corp** leg's override
  (`loan_advance`/`loan_repayment`) → shareholder loan balance.

So a treatment change must update **both** legs to stay consistent. This is
**already handled** by `PATCH /api/transfers/:id/tax-treatment`
(`backend/src/routes/transfers.ts:592`): inside a `sequelize.transaction` it sets
leg `a`'s `taxTreatmentOverride` + `reviewedAt`, and if `a.linkedTransactionId`
is non-null loads leg `b` and sets the **same** value atomically. A
`null`/`''`/`undefined` body clears the treatment. Returns `{ a, b }`. The
existing `ClassifyRow` and its Undo already call this endpoint.

`PATCH /api/transactions/:id` (`transactions.ts:1093`, validates `isTaxTreatment`
at `:1110`) also accepts `taxTreatmentOverride`, but it touches **only the single
row** — using it for a corp pair would desync the legs. Reclassification
therefore **reuses `/api/transfers/:id/tax-treatment`**, not
`/api/transactions/:id`.

The only real gap is **read-side**: there is no query to list already-classified
items, and no UI to edit them.

## Decision: a "Classified" tab backed by an inverse-filter query

### Backend — extend the queue (no new table)

`GET /api/tax/classification-queue` gains an optional query param
`status=unclassified|classified`, default `unclassified` (current behavior,
byte-for-byte unchanged when the param is absent):

- `unclassified` — `taxTreatmentOverride: null` (today's filter).
- `classified` — `taxTreatmentOverride: { [Op.ne]: null }`.
- any other value → `400 { error: 'invalid status' }`.

Everything else (corp-entity gating, `linkedTransactionId` pairing, visibility
scoping via `visibleTransactionWhere`, account-name batch fetch) is identical
across both modes. The filter flips on both the `personalLegs` query and the
`payroll` query.

The pivot stays on the **personal** leg, mirroring the unclassified path. Because
the transfers endpoint keeps both legs in sync, the paired corp leg carries the
same value; the corp leg is still joined by `linkedTransactionId` (not filtered
by override), so pairing is unaffected.

The `slim()` serializer gains a `taxTreatmentOverride` field
(`TaxTreatment | null`). This is additive: it is `null` in unclassified mode
(harmless to existing callers) and carries the current value in classified mode,
so the UI can pre-fill the editor.

### Frontend — new "Classified" tab mirroring Classify

- **`TaxPage.tsx`** — add `{ value: 'classified', label: 'Classified' }` to
  `TABS` (after `classify`); render `<ClassifiedTab year={year} />` when active.
- **`useClassificationQueue`** — add a 3rd param
  `status: 'unclassified' | 'classified'` (default `'unclassified'`); append it
  to the query string and the effect deps. Add `taxTreatmentOverride:
  TaxTreatment | null` to the `QueueLeg` interface. `ClassifyTab` is unchanged
  (defaults to `unclassified`).
- **`ClassifiedTab.tsx`** (new, mirrors `ClassifyTab`) — fetches with
  `status='classified'`; renders "Corp → personal" and "Payroll" sections of
  `ClassifiedRow`. No optimistic in-session list — after each mutation it calls
  `reload()` so a cleared item leaves the list and a changed item shows its new
  value. Empty state: "No classified income for {year}."
- **`ClassifiedRow.tsx`** (new, mirrors `ClassifyRow`) — `TaxTreatmentSelect`
  with `value={primary.taxTreatmentOverride}` (pre-filled) and
  `emptyLabel="Clear (unclassify)"` so the empty option is selectable. Choosing
  a different treatment → `PATCH /api/transfers/:id/tax-treatment`
  `{ taxTreatmentOverride: <new> }` → `reload()`. Choosing Clear →
  `{ taxTreatmentOverride: null }` → both legs cleared → row returns to the
  unclassified queue. Busy/error states identical to `ClassifyRow`. `targetId`
  is the **personal** leg id for corp pairs, the income txn id for payroll
  (same convention as `ClassifyRow`).
- **DRY** — extract `CORP_OPTIONS` / `PAYROLL_OPTIONS` from `ClassifyRow.tsx`
  into `frontend/src/lib/taxTreatment.ts`; both `ClassifyRow` and
  `ClassifiedRow` import them.

`TaxTreatmentSelect` already supports `value` and `emptyLabel` — no change.

## Tests

**Backend** (`node:test`, mirroring existing tax-route tests):
- `status=classified` returns only items with a non-null override; a corp pair
  appears with **both** legs and each leg's `taxTreatmentOverride` populated;
  classified payroll included.
- No param / `status=unclassified` is unchanged (regression: classified items
  excluded, unclassified included).
- Visibility scoping still applies in classified mode (another member's private
  leg excluded).
- Invalid `status` → 400.
- (Reuse/confirm existing coverage of `/api/transfers/:id/tax-treatment` setting
  both legs and clearing both legs — the mutation reused by this feature.)

**Frontend** (`vitest` + `@testing-library/react`, mirroring
`ClassifyTab.test.tsx`):
- `ClassifiedTab` renders corp + payroll rows with the current treatment
  pre-selected in the `TaxTreatmentSelect`.
- Changing the select calls `patchJson('/api/transfers/:id/tax-treatment',
  { taxTreatmentOverride: <new> })` and triggers `reload()`.
- Selecting "Clear (unclassify)" calls it with `{ taxTreatmentOverride: null }`.
- `useClassificationQueue(..., 'classified')` requests
  `...&status=classified`.

## Out of scope (flag, do not build)

`ReviewInboxPage` and `TransactionsPage` set `taxTreatmentOverride` through the
single-leg `/api/transactions` path. For a corp transfer leg edited there, the
linked leg would not sync. This is pre-existing and unverified; it is a separate
concern from this feature and will be flagged as a follow-up, not fixed here.

## Edge cases

- **One-legged classified data** (legacy/manual SQL set only one leg): the
  classified view pivots on the personal leg, matching how the unclassified view
  pivots. A pair with only the corp leg set would not appear in either view's
  corp-distribution list under the personal-leg pivot; going forward the
  transfers endpoint keeps both legs in sync, so new classifications are always
  symmetric. Not addressed by this feature.
- **Clearing is reversible** (re-classify from the queue), so no confirmation
  dialog — the `reload()` makes the effect visible.

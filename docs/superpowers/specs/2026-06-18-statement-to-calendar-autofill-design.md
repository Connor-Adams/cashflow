# Statement → Calendar Auto-Fill (Credit Cards)

**Date:** 2026-06-18
**Status:** Design approved, pending spec review
**Primitive impact:** Extends **Document** (parse), **Account** (LiabilityAccount sidecar),
and **Expectation** (PlannedEvent). **No new primitive.**

## Problem

When a credit-card statement PDF is imported, the app extracts the transaction
rows and the statement period — but **not** the bill summary (payment due date,
statement balance, minimum payment), even though the statement prints all three.

Separately, the #243 credit-card payment planner already stores those fields on
`LiabilityAccount` and can materialize a `debt_payment` PlannedEvent that the
calendar renders — but every field is hand-typed and the calendar event requires
a manual "materialize payment" click.

**Goal:** close the loop. Importing a credit-card statement should auto-extract
the due date + statement balance, write them onto the card, and auto-place the
payment on the calendar — no manual entry, no click.

## Decisions (settled during brainstorming)

1. **Auto-place, no click.** Import immediately materializes the calendar payment.
   Safety lives in extraction confidence (a hard guard), not a confirm step.
2. **Amount = statement balance.** Pay-in-full assumption. The calendar payment
   carries the full statement balance on the parsed due date.
3. **Import is the source of truth.** Parsed `statementBalance` / due date /
   `minimumPayment` **overwrite** the corresponding `LiabilityAccount` fields
   (previously documented as user overrides). Eliminating hand-typing is the point.
4. **Exact parsed date drives the event.** The statement prints a concrete due
   date; it becomes the PlannedEvent's `expectedDate` directly. We **also** set
   `LiabilityAccount.dueDay` = that date's day-of-month so the planner can still
   project *future* cycles via `nextDueDate()`.
5. **Hard guard replaces the confirm click.** Auto-place only when **both** the
   payment due date and the statement balance extract cleanly (present + no
   parse error on those fields). If either is missing/ambiguous: still upsert
   whatever fields *did* parse onto the card, but **do not** materialize a
   calendar event, and log the reason. "No click" ≠ "trust a bad parse."
6. **Pay-from account left unset.** The auto-placed event carries no
   `paymentAccountId`. It shows on the calendar as a marker; the user wires
   pay-from manually if they want a safe-to-spend deduction. (`PlannedEvent` and
   the materialize path already tolerate `null` pay-from.)
7. **Scope: Wealthsimple first, via a generic seam.** The extraction fields are
   added to the shared parser contract so any `credit_card` parser can populate
   them, but only the **Wealthsimple** parser gets extraction logic in this spec.
   `cibcCostcoMastercard` and `rbcVisa` (also `credit_card`) are explicit
   follow-ups — each needs its own label regexes + fixture. RBC Royal Credit Line
   is `accountType: 'loan'` and is **out of scope**.

## Architecture — three links

### Link 1 — Extract (parser)

Extend the parser contract with three optional, statement-summary fields:

- `PdfStatementHeader` (and the parse-result surface) gains:
  - `statementBalance?: number | null` — the "new balance" owed for the cycle (positive = owed)
  - `paymentDueDate?: string | null` — ISO `YYYY-MM-DD`
  - `minimumPayment?: number | null`
- Absent fields are `null`, never an error — they must not break existing parsers
  or the transaction path.
- The **Wealthsimple** parser (`wealthsimpleCreditCard.ts`) gets regexes against
  the bill-summary block. Confirmed label wording from the existing fixture:
  `Statement date` and `Minimum payment` appear on one physical line
  (`Statement date   May 15, 2026          Minimum payment   $10.00`). The new
  regexes target the printed labels for the new balance and the payment due date.
  **Open item:** exact WS wording for those two labels ("New balance" /
  "Payment due date" assumed) — to be confirmed against a real statement; the
  guard makes a wrong assumption fail safe (no event) rather than wrong.
- A field that is present but unparseable (e.g. a malformed amount) records a
  `parseError` scoped to that field, which the guard reads.

### Link 2 — Persist (import commit path)

In `runImport.ts` (the header→account resolution block, ~L1080–1220), after the
account is resolved/created and `header.accountType === 'credit_card'`:

- Upsert the parsed summary fields onto the card's `LiabilityAccount` sidecar:
  `statementBalance`, `minimumPayment`, `statementDate` (the printed "Statement
  date" when the parser captured it, else `header.periodEnd`), and `dueDay`
  (= day-of-month of `paymentDueDate`).
- Only overwrite a field when the parsed value is non-null (a parser that didn't
  extract minimum payment must not wipe an existing value).
- **Staleness guard (newer-wins).** Skip the upsert + auto-place entirely when the
  imported statement is **strictly older** than what's stored: if
  `LiabilityAccount.statementDate` is set and the incoming statement date (its
  `periodEnd`) `<` the stored value, do nothing (a back-fill of an old statement
  must not clobber the current bill). Equal date → proceed (re-import of the same
  statement, idempotent replace). This makes re-importing an older statement safe.
- This is gated to `credit_card` accounts so non-card imports are untouched.

### Link 3 — Auto-place (shared materialize service)

The materialize logic currently lives inline in
`POST /api/credit-cards/:accountId/payment` (`creditCards.ts`), and it computes
`expectedDate` from `dueDay` via `nextDueDate()`.

- **Refactor:** extract a service function, e.g.
  `materializeCreditCardPayment({ accountId, amount, expectedDate, currency, source })`,
  that owns the per-card idempotency (destroy prior unposted `source=credit_card`
  events for the card) and the `PlannedEvent.create(...)`.
- The **HTTP route** keeps its current behavior (computes `expectedDate` from
  `dueDay`) by calling the service — no behavior change for existing callers.
- The **import path** calls the same service with the **exact parsed due date**
  as `expectedDate` and `amount = statementBalance`, `paymentAccountId = null`.
- Idempotency means re-importing the same statement replaces, not duplicates, the
  card's pending credit-card payment.

## Data flow

```
WS credit-card PDF
  → wealthsimpleCreditCardParser.parse()
      → header { ...period, statementBalance, paymentDueDate, minimumPayment }
  → runImport.ts: resolve/create credit_card Account
      → upsert LiabilityAccount { statementBalance, minimumPayment, statementDate, dueDay }
      → guard: due date AND statement balance both clean?
          ── yes → materializeCreditCardPayment({ amount: statementBalance,
          │                                       expectedDate: paymentDueDate })
          │          → debt_payment / source=credit_card PlannedEvent → calendar
          └── no  → fields persisted, NO event, reason logged
```

## Error handling

- Missing/ambiguous due date or statement balance → no calendar event (guard).
  Partial fields still persist to the card.
- Unparseable amount/date for a present field → field-scoped `parseError`; the
  guard treats it as "not clean".
- Non-`credit_card` imports → untouched (existing behavior).
- Re-import of the same statement → idempotent replace of the pending event.
- Import of an *older* statement than the stored `statementDate` → no-op (staleness guard).

## Testing

- **Parser unit tests** (extend `pdfWealthsimpleCreditCard.test.ts`, building on
  the existing synthetic `mk()` fixture):
  - extracts `statementBalance`, `paymentDueDate`, `minimumPayment` from a
    summary block.
  - summary fields absent → all three `null`, transactions + period still parse.
- **Guard test** (import-path level): due date present but statement balance
  missing → card fields upserted, **no** PlannedEvent created.
- **Idempotency test:** import the same statement twice → exactly one pending
  `source=credit_card` payment.
- **Staleness test:** import statement B (newer), then statement A (older) →
  card fields + event reflect B, the A import is a no-op.
- **Service-refactor regression:** the existing
  `POST /api/credit-cards/:id/payment` integration test still passes unchanged
  (proves the extracted service preserves route behavior).

## Out of scope / follow-ups

- Extraction for `cibcCostcoMastercard` and `rbcVisa` (own regexes + fixtures).
- RBC Royal Credit Line (it's a `loan`, not a card).
- Auto-attaching a pay-from account / safe-to-spend deduction on import.
- Surfacing import-time "statement balance updated" notifications.
```

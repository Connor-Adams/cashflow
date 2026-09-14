# People ledger: loan accounting

**Date:** 2026-09-14
**Status:** design, approved
**Supersedes the balance half of:** `2026-06-18-per-person-loan-ledger-design.md`

## Problem

The People page reports money that is not owed. Every figure on it is wrong, and
the errors are structural rather than incidental.

The page's headline is `computeTransferNet` — the raw sum of every transaction
carrying a `counterparty_contact_id`, labelled "owed to you". A production audit
on 2026-09-13 found that of 322 linked transactions, **310 have a null
`final_category` and 12 are `Transfer`. Zero are `rent` or `household`** — the
only two values `NON_LOAN_LEDGER_CATEGORIES` knows how to exclude. The escape
hatch has never fired in production. Every transfer to a person, whatever it
actually was, counts as a debt.

What the audit found inside those flows:

| flow | amount | what it actually is |
|---|---|---|
| `E-TRANSFER SENT EVAN PHONE NUMBER YAMRKV` | −4,550.00 | a purchase settled between friends |
| `CHEXY*ARVIND MALLYA HAMILTON` | −3,648.00 | rent fronted on a credit card for the points; repaid |
| `Sent money to Evan Adcock` (Wise Corporate) | −2,081.31 | a **corporate payout split** — see below |
| `E-TRANSFER SENT WEALTHSIMPLE CASH H9UDAD` | −5,032.09 | a self-transfer, matched because the code ends in `DAD` |
| five `EVAN LEROSE` rows | −40.00 net | a different person, collapsed by first-name matching |

The Wise row is the sharpest case. `Wise Corporate CAD` sweeps to zero every
month — a USD conversion lands and goes straight out. On 2025-09-16 the
conversion was `+7,140.68` and the same-day outflows were
`5,058.37 (CDG Labs Inc.) + 2,081.31 (Evan) + 1.00 (Evan) = 7,140.68`, exact to
the cent. That is a business disbursement riding the same "transfer to a person"
shape as a loan, and nothing in the model can tell them apart.

Meanwhile the relationships that *are* lending are also wrong. Stephen Masseur
reads 43,634.85 owed across 196 transactions; the real figure is "at least 6,700
plus line-of-credit interest". Caelan Iten-McGrath reads 24,438.58 across 98.
The landing metric sums every positive net and reports roughly **79,406 owed**.

Two further defects compound it:

- The ledger renders `merchantClean ?? merchantRaw`, and `merchant_clean` strips
  the counterparty name off RBC transfers. 157 Stephen rows, 55 Caelan rows and
  5 Evan rows all display as the identical string `ONLINE TRANSFER SENT -`, while
  `merchant_raw` holds `ONLINE TRANSFER SENT - 8807 CAELAN ITEN-MCGRATH`. The
  links are correct; the UI discards the evidence, so a mis-tag is invisible.
- The landing bar reads only CAD, silently dropping Stephen's USD −3,570.51.

The `Reimbursement` table — the half of the original design meant to carry the
honest number — is **empty**. `trackedOutstandingByCurrency` has always been 0,
so raw net is the only number the page has ever shown.

## Spine placement

A loan owed to you is an **Expectation**: expected money movement, with
`expected → received → waived` mirroring `planned → posted → cancelled`.
`Reimbursement` is its physical table. Interest owed is also expected movement,
so it lands in the same primitive with a discriminator.

`counterpartyRole` and `loanDefault` are discriminator fields on **Transaction**
and **Counterparty** respectively. No new tables beyond one child table for
allocation detail in Phase 3.

**No new primitive.** Note that `Reimbursement` is absent from the primitives
spec's fold table entirely — this design adds it under Expectation, and the
implementation should patch `2026-05-30-cashflow-primitives-design.md` to say so.

## Data model

| change | table | notes |
|---|---|---|
| `counterparty_role` STRING(16) NULL | `transactions` | `loan` · `repayment` · `purchase` · `business` · `rent` · `gift` · `self` · `loc_interest`. Null means untagged. |
| `loan_default` BOOLEAN NOT NULL DEFAULT false | `contacts` | "Treat untagged transfers with this person as loans." |
| `kind` STRING(16) NOT NULL DEFAULT `'principal'` | `reimbursements` | `principal` \| `interest`. |
| `source_transaction_id` INTEGER NULL FK → transactions | `reimbursements` | The `loc_interest` charge an interest row was derived from. Unique on `(source_transaction_id, contact_id)`. |

`counterparty_role` is deliberately one column doing two jobs: on a transfer it
says what the transfer was; on a line-of-credit interest charge (`loc_interest`)
it marks the charge as allocatable. Interest charges have no counterparty, so
they need no contact and no second mechanism.

**It is a new column, not the existing `transactions.transfer_purpose`.** That
column (issue #222, 2026-06-03) carries `owner_draw · owner_contribution ·
reimbursement · investment · internal · income` and answers a different question:
what role a transfer plays between the user's *own* accounts. It is read by
`reciprocity.ts`, `routes/transfers.ts`, `routes/reports.ts`,
`routes/statements.ts` and `sync/tables.ts`. It is null on all 5,361 production
rows, which makes it look reusable — but 11 rows are both contact-linked and
pair-linked, so loan-vocabulary values would surface in
`GET /api/transfers/stats`'s `byPurpose` breakdown. Two questions, two columns.

`NON_LOAN_LEDGER_CATEGORIES` and `isNonLoanCategory` are **deleted**. Category
answers "what kind of spend"; role answers "does this create a debt".
Conflating the two axes is why the exclusion never worked.

## Behaviour

### Role resolution

Explicit `counterparty_role` wins. Otherwise the contact's `loan_default`.
Otherwise not a loan.

This is what makes the volume tractable. Caelan is `loan_default = true`, so his
98 rows count with no tagging. Stephen is `false`, so his 196 don't — and the
handful that *are* loans get tagged individually. Evan is `true`, with the
purchase and the corporate payout tagged as exceptions.

### Balance

```
balance(contact, currency) = Σ |loan| + Σ interest − Σ |repayment|
```

Signed, computed directly from tagged transactions. Positive means they owe you;
negative means you owe them.

Sign convention, since transaction amounts are directional and purposes are not:
a `loan` is an outflow (`amount < 0`) and a `repayment` is an inflow
(`amount > 0`), and both contribute their absolute value to their own side of
the equation. A row whose direction contradicts its purpose — a `loan` tagged on
an inflow — is a tagging error; treat it as its direction implies and surface it,
rather than letting a sign flip silently invert the balance.

Only `loan`, `repayment`, and generated `interest` rows affect the balance.
`purchase`, `business`, `rent`, `gift`, `self` and untagged-with-`loan_default`-
false are excluded from it entirely, while remaining visible in the transfer list
and counted in net flow.

There is deliberately **no "unapplied" or "overpaid" state.** A repayment larger
than what is outstanding simply carries the balance through zero. Evan's
3,904.17 against a 3,648.00 loan produces −256.17 and the page reads *"you owe
Evan 256.17"*. Inventing a holding pen for the residual would add a state
machine to model something a sign already expresses.

The cost, stated plainly: a mis-tagged repayment silently produces a debt in
your direction rather than parking somewhere conspicuous. The tagged rows are
listed directly beneath the balance, so the error is visible where it is made.

Raw net flow survives as a secondary descriptive statistic with the owed/owe
language removed. It is the only place Stephen's 117k of two-way movement is
visible at all, and it should not disappear just because it is not a debt.

### Interest allocation

For each transaction tagged `loc_interest`:

1. Compute every contact's outstanding principal **as of that transaction's date**.
2. Split the charge across them weighted by balance.
3. Write `reimbursements` rows with `kind='interest'`, `source_transaction_id`
   set, amount equal to that contact's share.

Integer-cents arithmetic; the rounding remainder goes to the largest balance so
the parts sum to the charge exactly. Unique `(source_transaction_id, contact_id)`
makes the pass idempotent — retag a transfer, re-run, and it recomputes rather
than double-charging.

Months with no outstanding balance allocate nothing. That interest is yours.

Production currently holds 15 `LOAN INTEREST` charges on RBC Day to Day Banking
6985, totalling **662.58** since 2023-12-05 and accelerating: 168.86 across 2025,
488.13 across 2026 to date.

### Cancel pairing

`E-TRANSFER CANCEL <code>` joins to the earlier `E-TRANSFER SENT <code>` on the
confirmation code. Both rows are excluded from the balance. Today the cancel
counts as money received, which reads as a repayment that never happened.

### Currency

The landing bar renders per-currency rather than picking CAD and discarding the
rest. No FX conversion — balances stay per-currency, as `computeTransferNet`
already does.

## UI

- The ledger's transfer list shows `merchant_raw`, not `merchant_clean`. This is
  the single highest-value change for auditability: it is what makes 157
  identical-looking Stephen rows distinguishable.
- Each transfer row carries a purpose dropdown.
- Contact detail gains a `loan_default` toggle and shows the balance split into
  principal and interest.
- The landing headline is total outstanding across contacts. Contacts with no
  outstanding balance still appear, showing net flow with neutral language.

## Phasing

Each phase ships independently.

**Phase 1 — the numbers become correct.** `counterparty_role`, `loan_default`,
signed balance, `merchant_raw` in the ledger, cancel pairing, per-currency
display, deletion of `NON_LOAN_LEDGER_CATEGORIES`. On its own this takes Evan to
−371.82, removes Stephen's false 43,634.85, and leaves Caelan honest.

**Phase 2 — interest.** The allocator and the `loc_interest` tagging. Depends
only on Phase 1, because pro-rata weighting needs balances and balances no longer
need allocation detail.

**Phase 3 — per-loan allocation detail.** A `reimbursement_repayments` child
table `(reimbursement_id, transaction_id, amount)` with FIFO assignment,
interest before principal, manually overridable. This answers "which specific
loan is 60% repaid". It is genuinely optional: the balance is already correct
without it.

## Testing

TDD throughout, colocated `*.test.ts` beside each unit.

- **Role resolution** — explicit beats contact default beats not-a-loan.
- **Balance** — signs, multi-currency isolation, repayment exceeding principal
  crossing zero, zero-amount rows skipped.
- **Interest allocation** — shares sum to the charge exactly under awkward
  rounding; idempotent across re-runs; zero outstanding allocates nothing;
  balance measured as of the charge date, not today.
- **Cancel pairing** — cancel plus original both excluded; a cancel with no
  matching send is left alone.
- **Migrations** — each asserts on re-read rows, never on the in-memory instance.
  A hook that derives a column is not proven by the instance it just mutated;
  that exact false-green hid the `normalized_name` persistence bug for months.

## Out of scope

- FX conversion between currencies. Balances stay per-currency.
- Any automatic classification of the existing 322 linked transactions. Purpose
  starts null everywhere; `loan_default` does the bulk work.
- Reconstructing which of Stephen's 196 transactions make up his "at least 6,700".
  That is data entry, not code, and Phase 1 gives the tools for it.

## Open question

The −4,550.00 of 2025-05-05 (`E-TRANSFER SENT EVAN PHONE NUMBER YAMRKV`) is
unresolved. It was described as the chair purchase, but it is dated May and the
chair was after June 2025, so by that timeline it is something else. RBC redacts
the recipient name when the contact is saved by phone number, so nothing in the
data identifies it. Tagged `purchase` the Evan balance is −371.82; left as a loan
it is +4,178.18. This is a data question for Connor, not a design question, and
it does not block implementation.

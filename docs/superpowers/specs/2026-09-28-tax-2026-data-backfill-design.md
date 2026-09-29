# 2026 Tax Data Backfill — make Connor's actual 2026 return true

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Operational data work against production
**Part:** 4 of 4 — depends on part 1 (importer fix) and part 3 (exit condition)

## Problem

Connor believed he had drawn ~$120,000 out of CDG Labs in 2026. Reconciliation
against prod on 2026-09-28 puts proven draws at **$83,000**, with a point estimate
of **$91,000–$93,000** and an absolute ceiling of ~$113,750.

The difference matters: at $83,000 he owes roughly $7,570; at his full-year run
rate he owes roughly $15,360. He cannot currently see either number, because the
ledger holds only $68,000 of it.

This spec is the operational work to close that. It is mostly data, not code.

### Where the $120k intuition came from

Two real numbers sit next to it, and both are worth naming so the confusion does
not return:

- **$132,200.78** — total CAD entering the corp perimeter in 2026 (14 Wise
  USD→CAD conversions). That is revenue, not draws.
- **$135,848.18** — draws ($83,000) plus **$52,848.18 moved into CDG's own
  Wealthsimple Corporate Investing account**. Money under Connor's control, but
  corporate property, not a distribution, and not taxable to him.

The revenue side also caps the answer: $132,200.78 of 2026 CAD revenue against
$135,848 of uses leaves no room for another $37,000 of draws. Trailing-twelve-month
linked draws are $76,000.

### The reconciliation

| Line | Amount | Basis |
|---|---|---|
| Linked and classified | **$68,000.00** | 13 × `non_eligible_dividend` = $67,000 + 1 × `expense_reimbursement` = $1,000 |
| In the ledger but unlinked | **$0.00** | Both unlinked corp outflows resolve to corp-internal (below) |
| Proven elsewhere in the DB, not in `transactions` | **$15,000.00** | `investment_activities` 1634 ⇄ personal txn 12139 |
| Inferred from the coverage gap | **$8,000 – $14,000** | Account 24 uncovered 2026-08-14 → 2026-09-28; ~$20,300 drawable; Feb–Aug run rate $9,714/mo |
| Corp-internal and third-party, excluded | **$319,790.81** | |

**Two rows that are NOT draws**, recorded here because an earlier reading got one
of them wrong:

- **Corp txn 12183** (2026-07-06, −10,000.00, WS Corporate Chequing, "Tax-free
  money transfer out of the account"). Its counterpart is `investment_activities`
  1712 — `transfer_in` +10,000.00 into account 13 the same day, immediately
  reinvested into XEQT (1714) and VFV (1715). **Corp-internal.** The 2026-09-16
  reading called this a missing personal draw; that was wrong. When a corp
  transfer appears to have no counterpart in `transactions`, check
  `investment_activities` before concluding money left the corp.
- **Corp txn 12256** (2026-09-01, −14,500.00, RBC Digital Choice Business,
  "Investment WS Investments"). Exact mirror of 12259 (2026-08-03 → WS Corporate
  Chequing txn 12244). Its counterpart is missing only because account 24's
  coverage ends 2026-08-13.

### The expense-reimbursement theory does not survive contact

Total 2026 `final_business = true` spend on Connor's personal cards: **$2,872.00**
across 39 rows, almost all on Amex Reserve — recurring Bell, QuickBooks ($22.60/mo),
Railway, Anthropic, Cloudflare. Largest single item $381.99. $1,000 is already
tagged `expense_reimbursement`.

Even if every dollar were reimbursed, that is **3.5% of the $83,000**. The other
96.5% is dividend distribution. Business-expense repayment cannot explain any
material part of the gap.

That $2,872 also explains `L13500 = −2,872.00` on the return. Per
`backend/src/tax/engine/t1.ts:157-165`, `seNet = seRev − seExp`. Those 39
business-flagged personal rows are collected as self-employment **expenses** while
the personal entity has **zero** self-employment revenue — all revenue sits inside
CDG Labs, and what reaches Connor is tagged `non_eligible_dividend`, not business
income. So `seNet = 0 − 2,872`. It is an artefact of booking corporate operating
costs on a personal card, not a proprietorship loss. (It is also overstated by
$20.73 — the duplicated RAILWAY row 11748/11559.)

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Ordering | Import **after** spec 1 lands | Importing the brokerage statements through the broken path recreates the $15k hole. |
| The $2,872 | **Reimburse from the corp, tag both legs `expense_reimbursement`** | Removes the phantom L13500 loss, puts the deduction in the entity that actually bears the cost, and is what the transactions describe. Booking them to entity 2 also works but rewrites history the bank statements contradict. |
| $15,000 backfill | Through the fixed importer, re-running the source statement | Hand-inserting a row reproduces by hand exactly what the importer should do, and leaves no provenance. |
| Duplicates | Auto-merge the certain ones (spec 1's rule), review the rest | Connor's call. |
| Exit condition | **Spec 3's gate reports `complete` for 2026** | An objective finish line rather than "looks done". |
| Prod writes | Each step reviewed before execution; read-only by default | Per the `cashflow-prod-db` guardrails. This is Connor's real financial history. |

## Work

**1 — Import the missing statements.** In priority order:

| Source | Window | Why |
|---|---|---|
| WS Corporate Chequing (WK79NVW07CAD) | 2026-08-14 → 2026-09-28 | Settles the $8–14k estimate. The CSV export can be pulled today; the monthly statement lands ~2026-10-01. |
| WS Corporate Investing (HQ8H0GZ07CAD) | 2026-08, 2026-09 | Needs spec 1's brokerage bridge first, or draws vanish again. |
| Personal WS Chequing (WK3DD9X35CAD) | 2026-09 | Ledger stops 2026-08-27; September draws need a personal leg to link to. |
| RBC Digital Choice Business | 2026-09-05 → 2026-10-05 | Completes the corp year. |

**2 — Backfill the 2026-01-10 −$15,000 corp leg**, link it to personal txn 12139,
tag both legs `non_eligible_dividend`.

**3 — Resolve the ~25 duplicate pairs.** Auto-merge the certain ones; review the
rest. Priority: account 13's four pairs ($28,848 phantom inflow) distort every
corp balance.

**4 — Classify whatever the September imports surface**, using the bulk
classification from spec 3.

**5 — Settle the $2,872.** Reimburse from the corp, tag both legs, and confirm
L13500 goes to zero rather than −2,872.

**6 — Roll 2026 carryforwards** for the personal entity. It stops at
`as_of_year 2025` (RRSP room 4,122.9612; FHSA room 8,000) while the corp is rolled
to 2026.

**7 — Fix the phantom opening balance** on corp account 24: `opening_balance`
899.10 with a null `opening_balance_date`, though the ledger starts at the
account's first transaction (2026-04-09 direct deposit). It inflates every derived
balance by 899.10.

**8 — Recompute and record the 2026 return**, and set up 2027 instalments.

## Expected outcome

Computed with the corrected 2026 rates from spec 2 (non-eligible dividends, single
Ontario resident, ~$50 interest, ~$3 capital gains, L13500 resolved to zero):

| Draws | Federal | Ontario + OHP | Total payable |
|---|---|---|---|
| $83,000 proven | $4,131 | $3,439 | **~$7,570** |
| ~$92,000 point estimate | $5,318 | $4,204 | **~$9,520** |
| ~$112,000 full-year at run rate | $8,383 | $6,978 | **~$15,360** |

Note the shape: the Ontario surtax engages around $92,000 of draws and climbs
quickly.

**2027 instalments become mandatory.** Net tax owing crosses $3,000 well before
year end, and `instalment_payments` is empty. `shareholder_loans` is also empty
despite $68,000+ of corp→personal flow.

These figures are hand calculations for sizing. The app's own number, once specs
1–3 land and this data is in, is the one to file against — and if it disagrees
with these, that disagreement is itself a finding.

## Out of scope

Corp T2 accuracy. Note while here that the corp ledger records **$54.00** of
third-party spend for all of 2026 — nine $6.00 RBC monthly fees. No payroll, no
accounting, no corporate tax instalments, no software. Either CDG genuinely pays
nothing and every cost rides Connor's Amex, or corp expenses are being imported
nowhere. That question belongs to a T2 pass, not this one, but it should not be
lost. `tax_entities.fiscal_year_end` is also NULL on the corp, which T2 work needs.

## Relationship to the other specs

1. **Reconciliation foundation** — must land before step 1 and step 2.
2. **Engine correctness** — independent; needed before the final numbers are
   trusted.
3. **T1 completeness gate** — supplies step 4's tooling and this spec's exit
   condition.
4. **2026 data backfill** — this spec. Last, and mostly operational.

Build order: 1, 2, 3, 4.

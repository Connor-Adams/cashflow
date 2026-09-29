# 2026 Tax Data Backfill — make Connor's actual 2026 return true

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Operational data work against production
**Part:** 4 of 7 — depends on part 1a (brokerage cash legs); steps 1, 2 and 7 are in the minimum path

## Problem

Connor believed he had drawn ~$120,000 out of CDG Labs in 2026. Reconciliation
against prod on 2026-09-28 puts proven draws at **$83,000**. Adding the estimated
$8,000–$14,000 drawn during the coverage gap gives **$91,000–$97,000** year-to-date.
The absolute ceiling, if corporate chequing had been drained to zero, is ~$113,750
— contradicted by the 2026-09-16 holdings showing $10,000.03 of idle corp cash.

The difference matters: at $83,000 he owes roughly $7,570; at his full-year run
rate he owes roughly $15,360 — and roughly $850–$1,250 more than each once the
L13500 artefact is corrected (see "Expected outcome"). He cannot currently see any
of those numbers, because the ledger holds only $68,000 of it.

This spec is the operational work to close that. It is mostly data, not code.

### Where the $120k intuition came from

Two real numbers sit next to it, and both are worth naming so the confusion does
not return:

- **$132,200.78** — total CAD entering the corp perimeter in 2026 (14 Wise
  USD→CAD conversions). That is revenue, not draws.
- **$135,848.18** — draws ($83,000) plus **$52,848.18 moved into CDG's own
  Wealthsimple Corporate Investing account**. Money under Connor's control, but
  corporate property, not a distribution, and not taxable to him.

The revenue side constrains but does not cap the answer, and the earlier draft
overstated it: $135,848 of uses already **exceeds** $132,200.78 of 2026 CAD revenue
by $3,647, which means opening cash is funding part of the year. So "no room for
another $37,000" does not follow from revenue alone — the binding constraint is the
account-24 ledger and its interest-implied balances (below), not the revenue total.
Trailing-twelve-month linked draws are $76,000.

### The reconciliation

| Line | Amount | Basis |
|---|---|---|
| Linked and classified | **$68,000.00** | 13 × `non_eligible_dividend` = $67,000 + 1 × `expense_reimbursement` = $1,000 |
| In the ledger but unlinked | **$0.00** | Both unlinked corp outflows resolve to corp-internal (below) |
| Proven elsewhere in the DB, not in `transactions` | **$15,000.00** | `investment_activities` 1634 ⇄ personal txn 12139 |
| Inferred from the coverage gap | **$8,000 – $14,000** | Account 24 (**WS Corporate Chequing**) uncovered 2026-08-14 → 2026-09-28; ~$20,300 drawable; Feb–Aug run rate $9,714/mo |
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
| Ordering | Import **after** part 1a lands | Importing the brokerage statements through the broken path recreates the $15k hole. |
| The $2,872 | **Reimburse from the corp, tag both legs `expense_reimbursement`** | Removes the phantom L13500 loss and puts the deduction in the entity that bears the cost. **This raises Connor's personal tax by ~$850–$1,250** — the −$2,872 was suppressing taxable income. Doing it anyway: the loss is fictitious and claiming it is wrong. Booking the costs to entity 2 instead also works but rewrites history the bank statements contradict. |
| $15,000 backfill | **Through part 1a's converter**, not by re-importing | Re-running the source statement inserts nothing: `commitStatementImport.ts:419-426` short-circuits on `contentHash` when a prior import of the same bytes succeeded with `rowCount > 0`, and there is no force path. That is how activity 1634 exists at all. The converter is the right instrument — 1634 is an orphan on an opt-in account — and hand-inserting would reproduce by hand what the converter does, with no provenance. |
| Duplicates | **Clear them by hand**, using part 1b's certain/for-review classification as the worklist | 1b is detect-and-report only; nothing merges automatically. |
| Exit condition | **Part 3's gate reports no remaining *blockers* for 2026** | An objective finish line rather than "looks done", and now reachable: part 3 was amended so every blocker is clearable by work this set schedules. The missing-T5 item is a **gap**, permanently — part 3's blocker rule has no exemptions, and that item fails two of its three conjuncts: the dividends are already counted so there is no missing money to size, and nothing in this set issues a slip. It becomes *loud* from 2027-03-01, the day after the slip deadline, not blocking — CDG must issue it, which is outside this part and outside the app. Import truncation is a **gap**, not a blocker — it is not boundable without inventing a run rate — so it does not hold this part open; step 1 closes it in practice by importing the four windows. Balance drift is gone with part 1c. |
| Prod writes | Each step reviewed before execution; read-only by default | Per the `cashflow-prod-db` guardrails. This is Connor's real financial history. |

## Work

**1 — Import the missing statements.** In priority order:

| Source | Window | Why |
|---|---|---|
| WS Corporate Chequing (WK79NVW07CAD) | 2026-08-14 → 2026-09-28 | Settles the $8–14k estimate. The CSV export can be pulled today; the monthly statement lands ~2026-10-01. |
| WS Corporate Investing (HQ8H0GZ07CAD) | 2026-08, 2026-09 | Needs part 1a's forward fix to `brokerageRouting` first — with it, rows this import creates arrive **with** their cash leg and need no conversion. Do **not** blanket re-run the converter afterwards: on account 13 each new activity now pairs with its own mirror at one `pairKey`, so the converter sees *shadows* — and under 1a's insert-only rule it reports them and removes nothing, so a re-run is merely noise. A re-run is for activities imported **before** the forward fix landed. |
| Personal WS Chequing (WK3DD9X35CAD) | 2026-09 | Ledger stops 2026-08-27; September draws need a personal leg to link to. |
| RBC Digital Choice Business (account 28) | **2026-09-02 → 2026-10-05** | Ledger stops 2026-09-01. An earlier draft started this window at 2026-09-05 and left 09-02 → 09-04 uncovered by the plan. |

**2 — Backfill the 2026-01-10 −$15,000 corp leg**, link it to personal txn 12139,
tag both legs `non_eligible_dividend`.

**3 — Resolve the ~25 duplicate pairs by hand.** Part 1b reports them classified
**certain** or **for review** and changes nothing; clearing them is manual. Priority: account 13's four pairs ($28,848 phantom inflow) distort every
corp balance.

**4 — Classify whatever the September imports surface**, using the bulk
classification from part 3.

**5 — Settle the $2,872.** Three parts, and the first two are often conflated:

- Reimburse from the corp and tag both legs `expense_reimbursement`. This zeroes
  the personal L13500 artefact, and `buildPersonalFacts.ts:156-164` short-circuits
  on the treatment before reaching the `finalBusiness` branch at `:183-185`, so
  the mechanism works.
- **Book the corresponding corp-side expenses.** Reimbursing creates the cash
  movement; it does not create CDG's deduction. Without this the costs are
  deducted nowhere, which is the opposite of the intent.
- Expect the reimbursement transfers to **land in the classification queue
  themselves**, alongside the draws. Tag them as they arrive rather than letting
  them re-muddy the draw reconciliation.

**6 — Roll 2026 carryforwards** for the personal entity. It stops at
`as_of_year 2025` (RRSP room 4,122.9612; FHSA room 8,000) while the corp is rolled
to 2026.

**7 — Fix the phantom opening balance** on corp account 24: `opening_balance`
899.10 with a null `opening_balance_date`, though the ledger starts at the
account's first transaction (2026-04-09 direct deposit). It inflates every derived
balance by 899.10.

**8 — Recompute and record the 2026 return.** Setting up 2027 instalments belongs
to part 5, which builds the threshold test and the schedule; this step only leaves
the 2026 number trustworthy enough for part 5 to read.

## Expected outcome

Computed with the corrected 2026 rates from part 2 (single Ontario resident,
~$50 interest, ~$3 capital gains). "Draws" is total corp→personal; the taxable
portion is that less the $1,000 already tagged `expense_reimbursement`.

Two columns, because **step 5 changes the answer**. Today L13500 carries the
−$2,872 artefact, which suppresses taxable income. Once those costs are reimbursed
from the corp and tagged, L13500 goes to zero and taxable income rises by $2,872:

| Draws | Total payable **today** (L13500 = −2,872) | **After step 5** (L13500 = 0) |
|---|---|---|
| $83,000 proven | ~$7,570 | **~$8,420** |
| ~$92,000 point estimate | ~$9,520 | **~$10,430** |
| ~$112,000 full-year at run rate | ~$15,360 | **~$16,610** |

The $112,000 row is *draws at the current pace through December*, and it is the
conservative end. $9,714/mo against $92,000 year-to-date projects closer to
**$121,000** by 31 December, which would put payable near $18,500 before the
L13500 correction. Treat $112,000–$121,000 as the planning band, not a point.

The right-hand column is the one to plan against — it is the post-fix state, and
the reimbursement itself is not taxable, so correcting the artefact costs roughly
$850–$1,250 of real tax. That is not a reason to leave it: the −$2,872 is a
fictitious self-employment loss, and claiming it is wrong.

Note the shape: the Ontario surtax first engages at **~$85,000** of non-eligible
dividend draws and climbs quickly after that.

**2027 instalments become mandatory.** Net tax owing crosses $3,000 well before
year end, and `instalment_payments` is empty. `shareholder_loans` is also empty
despite $68,000+ of corp→personal flow.

These figures are hand calculations for sizing. The app's own number, once parts 0–3 land and this data is in, is the one to file against — and if it disagrees
with these, that disagreement is itself a finding.

## Out of scope

Corp T2 accuracy. Note while here that the corp ledger records **$54.00** of
third-party spend for all of 2026 — nine $6.00 RBC monthly fees. No payroll, no
accounting, no corporate tax instalments, no software. Either CDG genuinely pays
nothing and every cost rides Connor's Amex, or corp expenses are being imported
nowhere. That question belongs to a T2 pass, not this one, but it should not be
lost. `tax_entities.fiscal_year_end` is also NULL on the corp, which T2 work needs.

## Relationship to the other parts

**0** Provenance (ships first) · **1a** Brokerage cash legs · **1b** Duplicate
detection, detect-and-report · **1c** Statement balances (**cut**) · **2** Engine
correctness · **3** Completeness gate · **4** 2026 backfill · **5** Instalments and
the forward view.

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.

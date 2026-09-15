# Attributing line-of-credit interest to the people who caused it

**Date:** 2026-09-15
**Status:** design, approved
**Supersedes the interest half of:** `2026-09-14-people-ledger-loan-accounting-design.md`

## What changed since the original design

The original spec apportioned each `LOAN INTEREST` charge **pro rata** across whoever
held an outstanding balance that month. That was the best available approach when
the only thing we had was the charge amount.

We now have the rate itself. The Royal Credit Line statement prints a **Rate History**
table per statement period, and the parser reads it into `account_rate_periods`:

```
Rate from and including   Rate to and including   Prime   Premium   Your Rate   Applicable Interest
August 4, 2026            September 3, 2026       4.450%  +4.490%   8.940%      172.36
```

Verified across fourteen real statements. The rate is not static — it stepped
**9.440% → 9.190% on 2025-09-18**, then **9.190% → 8.940% on 2025-10-30**, and has
held at 8.940% since. Some statement periods carry two windows because prime moved
mid-cycle.

Pro rata is now the wrong method, for a reason that matters: **it assumes the entire
line funded loans to people.** It doesn't. Connor borrows on it for himself too.
Splitting the whole charge across borrowers silently pushes his own carrying cost onto
Caelan and Stephen.

## Only LoC-funded loans bear interest

Tagged principal is **30,975.00** but the line balance is **22,700.00** — Connor has
lent more than he has drawn, so some of that lending came from his own cash and costs
him nothing to carry. Charging every tagged loan at the line's rate therefore
over-attributes: the computed interest exceeds what RBC actually billed in 7 of 8
active windows, the cap scales it back, and Connor's own carrying cost falls out at
0.00 — which is plainly wrong.

So interest attaches only to lending the line actually funded. Draws are traceable by
matching a draw to a same-day transfer of the same amount:

```
2026-04-16   6,700 -> Stephen   (advance landed in chequing as ONLINE BANKING TRANSFER - 0819)
2026-05-08   5,000 -> Caelan
2026-07-24   2,000 -> Caelan
```

13,700 of the 30,975 is LoC-funded. The remaining ~9,000 of the line is Connor's own
borrowing and carries its own cost, which is now non-zero and correct.

A loan records **which draw funded it** — `transactions.funded_by_transaction_id`, a
self-referencing provenance field — rather than a boolean, so the attribution stays
checkable against the statement.

## The method

Applied only to loans carrying a funding link. For each such person, for each rate
window:

```
their interest = their outstanding balance × effective_rate × days_in_window / 365
```

Summed across windows. Whatever is left of the statement's applicable interest is
Connor's own borrowing cost and is charged to nobody.

**Simple interest, not compound.** The statement is explicit:

> Fees/Interest/Insurance — These transactions are shown in your account activity but
> have been processed directly to your designated payment account and do not impact
> the outstanding balance of your Royal Credit Line account.

Interest is auto-debited from chequing each month rather than capitalised, so principal
never grows from interest and there is nothing to compound. The activity table confirms
it: the balance-owing column is unchanged across every `Interest Payment` row.
Independently corroborated — modelling simple interest on average daily balance
reproduced a flat 8.940% across ten consecutive months; had it compounded, the implied
rate would have crept upward.

This holds *because* the interest is paid monthly. Every statement shows
`Interest past due: N/A`. If a payment ever failed, RBC would presumably roll it into
principal and it would begin compounding — the allocator should not silently assume
otherwise forever.

## Two figures, never merged

Interest accrues daily; RBC bills monthly. So a single "interest owed" number is
either stale or partly invented. Show both, labelled:

| figure | basis | source |
|---|---|---|
| **charged** | ends at the last statement period end | each rate window's printed *Applicable Interest*, apportioned |
| **accrued** | last statement period end → today | balance × current rate × days, computed |

Use the rate table's **Applicable Interest** as the authoritative per-period cost, not
the `Interest Payment` row in the activity table. They differ — the statement says the
payment "reflects interest charged based on your specific payment date from month to
month", so it lags a cycle. Across the nine monthly statements the accrued figures run
38.63, 26.35, 18.81, 35.76, 79.19, 133.73, 146.71, 162.56, 172.36 while the payments
trail behind. The rate-window figure is dated to the period it belongs to; the payment
is cash timing.

The accrued figure is the only number on the People page not backed by a document. It
must be visibly labelled as an estimate wherever it appears.

## Where it shows

**Contact drill-in** — three tiles, principal and interest never summed into one
unlabelled figure:

```
 Principal              CAD 6,700.00    tagged loans, less repayments
 Interest charged       CAD   412.30    through the 2026-09-03 statement
 Interest accrued       CAD    XX.XX    estimated since, at 8.940%
 ─────────────────────────────────────
 Total owed             CAD 7,1XX.XX
```

The interest tiles carry provenance captions, and beneath them the rate windows used:
`9.440% to 2025-09-17 · 9.190% to 2025-10-29 · 8.940% since`. A reader should be able
to see a rate change without leaving the page.

**Landing list** — the total per person, with interest beside it rather than folded in:

```
 Caelan Iten-McGrath    CAD 24,275.00    + 1,204.18 interest
 STEPHEN MASSEUR        CAD  6,700.00    +   412.30 interest
```

**Headline metric** — principal and interest as separate tiles, for the same reason
`owedToYou` and `youOwe` are separate: summing them hides which half moved.

## Spine

Allocated interest is an **Expectation**, stored in `reimbursements` with
`kind='interest'` and `source_transaction_id` pointing at the charge it came from —
already shipped. `account_rate_periods` is reference data on the **Account** primitive,
the same shape as `FxRate`. No new primitive.

## Correctness properties

- **Idempotent.** Re-running recomputes rather than accumulating; the partial unique
  index on `(source_transaction_id, contact_id)` is the backstop, delete-then-write is
  the mechanism.
- **Dated.** A person's balance is measured as of each rate window, not as of today.
  A loan made in April earns nothing for March.
- **Bounded.** The sum apportioned for a window can never exceed that window's printed
  applicable interest. If it would, allocations scale down proportionally. Once the
  basis is restricted to LoC-funded loans the bound should rarely bind; a window where
  it does bind is a signal that a funding link is wrong, and the scaling factor must be
  surfaced rather than hidden.
- **Negative balances earn nothing.** You cannot charge interest to someone you owe.
- **Per-currency.** No FX. A CAD charge is not shared with a USD balance.

## Out of scope

- Interest on anything but the Royal Credit Line. Other accounts have rates but no
  lending relationship behind them.
- Charging interest for periods before a contact had any outstanding balance — five of
  the fifteen `LOAN INTEREST` charges predate every tagged loan and apportion nothing.
- Compounding. Revisit only if an interest payment is ever missed.

## Open

Stephen has **3,648.11** of 2026 flow outside his tagged 6,700 loan that Connor has
not classified. Until he does it contributes no principal and therefore earns no
interest. If it turns out to be lending, both his principal and his interest rise.

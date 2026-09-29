# T1 Engine Correctness — published 2026 rates, slip box mapping, AMT fractions

**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Correctness fix, backend only
**Part:** 2 of 4 — see "Relationship to the other specs" below

## Problem

Connor's personal T1 "seems low". Investigation on 2026-09-28 separated that into
data completeness (specs 1, 3, 4) and engine correctness (this spec). Three
engine defects are real, verified, and independent of any data question.

### 1. `rates-2026.ts` is a projection wearing a "VERIFIED" header

`backend/src/tax/data/rates-2026.ts:1-4` claims `VERIFIED 2026-05-24`. The body is
an indexation projection built before CRA published the real figures (federal
indexed amounts, November 2025; CPP/EI, November–December 2025). Every constant
in the file is wrong.

It also applies the **federal** indexation factor (2.0%) to **Ontario** amounts,
which indexed at 1.9% — and in several places simply copies 2025 Ontario values
verbatim (`:21`, `:34`, `:109`) while indexing the Ontario surtax bands (`:74-78`).
Inconsistent treatment inside one file.

Two arithmetic errors independent of the staleness: `177,882 × 1.027 = 182,684.81`
but the file carries `182,674` at `:17`, `:31` and `:122` (a digit transposition,
propagated to `rates-2027.ts:138`); and `253,414 × 1.027 = 260,256.18` against the
file's `260,257`.

**The structural error:** `capitalGainsInclusionHigh: 0.666667` (`:72`). That tier
does not exist. The Budget 2024 increase to 66⅔% above $250,000 was deferred to
2026-01-01 (announced 2025-01-31), then cancelled outright on 2025-03-21, and the
cancellation was legislated in Budget 2025 (2025-11-04). The file has a phantom
tax increase switching on precisely in 2026. `rates-2025.ts:6-7,59-65` already
records the cancellation and correctly sets `0.5` — so the repo contradicts itself
across two adjacent files.

### 2. Two T5/T3 slip boxes are mapped to the wrong CRA meaning

`backend/src/tax/engine/t1.ts:72,120-136` reads **T5 box 26** as the taxable amount
of non-eligible dividends. CRA T5 box 26 is the **dividend tax credit for eligible
dividends**. The taxable non-eligible amount is **box 11**, which `buildT1` never
reads — even though `frontend/src/pages/tax/slips/T5Form.tsx:5` already collects it.

`t1.ts:77,97-99` reads **T3 box 49** as the taxable amount of eligible dividends.
CRA T3 box 49 is the **actual** amount; taxable is **box 50**. Understates eligible
dividends by the full 38% gross-up.

Correct today and not to be touched: T5 box 13 → interest, T5 box 25 → taxable
eligible, T3 box 32 → taxable non-eligible. T3 box 26 ("Other income") → interest
is an acceptable approximation, since a T3 has no dedicated interest box.

Two distinct failure modes, both silent:

- **A pure non-eligible T5** — what CDG Labs will issue Connor (boxes 10/11/12,
  box 26 empty). `hasNonElSlips` at `t1.ts:121-123` tests `box26 > 0`, so it is
  **false**, the engine silently falls back to computed dividends, box 11 is
  ignored, and no reconciliation warning fires. The slip is decorative. The exact
  cross-check wanted at filing time does not happen.
- **Any T5 carrying eligible dividends** (boxes 24/25/26 — plausible, Connor holds
  a non-registered Wealthsimple Investing account). Box 26 holds the eligible DTC,
  `hasNonElSlips` flips **true**, and that credit figure *replaces* the entire
  computed non-eligible dividend total on L12010 via the slip preference at
  `t1.ts:124`. Tens of thousands of dollars of owner dividends are replaced by a
  ~15% credit figure, with no warning — because the warning is gated on the same
  wrong predicate.

### 3. AMT credit fractions are incomplete

`engine/amt.ts` is implemented and genuinely wired (`t1.ts:316-335`, feeding
`totalPayable` at `:376` and `totals.federalTax` at `:399`). Two defects inside it:

- `totalNonRefundableCredits` passed at `t1.ts:323` is only the
  BPA/spousal/age/employment/CPP-EI block. Donation, medical, tuition, pension and
  disability credits are excluded from the 50% AMT allowance, **overstating AMT**.
- No separate donation fraction. Post-2024 AMT allows **80%** of the donation
  credit, not 50%. The rate table has no field for it.
- `amtExemption` inherits the `182,674` transposition and should track the start of
  the 4th federal bracket (`181,440` for 2026), not be an independently-maintained
  constant that can drift from it.

### Explicitly NOT a bug — do not "fix" this

A 2026-09-28 audit pass claimed the Ontario surtax is computed in the wrong order,
and put ~$11.9k/yr of overstatement on it. **That claim is false.** Verified
against CRA Form ON428 (5006-C E (24)), Part C, read from the form itself:

```
51  Ontario tax on taxable income
52  Ontario non-refundable tax credits          −
53  = line 51 minus line 52
54  Ontario tax on split income                 +
55  = line 53 plus line 54
56  [minimum tax carryover block] amount from line 53
57    Ontario dividend tax credit               −
58    = line 56 minus line 57
...
62  Amount from line 61 of the previous page
    Ontario surtax:
63    Amount from line 62
64    Ontario tax on split income from line 54   −
65    = line 63 minus line 64
66-68 surtax thresholds applied to line 65
69  Line 62 plus line 68
70  Ontario dividend tax credit from line 57     −
71  = line 69 minus line 70
```

The ON DTC appears at line 57 **only inside the minimum-tax-carryover
sub-calculation**. The surtax base is line 62/65, which has **not** had the DTC
deducted. The DTC is subtracted at line 70, *after* the surtax is added at line 69.

`t1.ts:348-361` does exactly this, and its comment is accurate. The test at
`backend/src/tax/t1-scenarios.test.ts:225-248` ("Scenario H") is also correct, and
its comment calling DTC-before-surtax "the buggy ordering" is right.

The intuition that misleads here is the well-known near-zero effective Ontario rate
on eligible dividends for low earners. That arises from the DTC exceeding Ontario
tax at line 71, **not** from the DTC shrinking the surtax base.

This paragraph exists so the next audit does not re-raise it.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Source of 2026 constants | CRA / Service Canada / Ontario published figures, one citation per value | Ends the "LLM-generated, not cross-checked" provenance flagged in the 2026-06-08 audit. |
| Values with only secondary-source support | Ship them, annotate `@low-confidence` with the source | Better than a projection, honest about what is not primary-sourced. |
| `rates-2027.ts` | Leave as a projection, but make it **unusable for filing** | 2027 figures are not published. A projection is fine for scenario planning and wrong for a return. |
| Guard against recurrence | A test asserting every value in a table marked `VERIFIED` carries a source citation | The failure here was a header claiming more than the body delivered. |
| `capitalGainsInclusionHigh` | Remove the concept for 2026/2027; flat 50% | The tier does not exist. Keeping a disabled field invites re-enabling it. |
| Slip box fix | Read box 11 / box 50, and re-gate `hasXSlips` off those boxes | Fixing the box without fixing the predicate leaves failure mode A in place. |
| AMT donation fraction | New rate-table field, `amtDonationCreditFraction: 0.80` | Distinct statutory fraction; folding it into the 50% is simply wrong. |
| `amtExemption` | Derive from the 4th federal bracket, don't store independently | Removes a class of drift and the inherited transposition. |

## The 2026 constants

Researched 2026-09-28. Federal indexation 2.0%, Ontario 1.9%.

### Federal — current file value → published 2026

| Field | In file | Published 2026 |
|---|---|---|
| Bracket 1 (14%) | 58,924 | **58,523** |
| Bracket 2 (20.5%) | 117,848 | **117,045** |
| Bracket 3 (26%) | 182,674 | **181,440** |
| Bracket 4 (29%) | 260,257 | **258,482** |
| BPA maximum | 16,564 | **16,452** |
| BPA floor | 14,931 | **14,829** |
| BPA phaseout range | 182,674 → 260,257 | **181,440 → 258,482** |
| Age amount | 9,272 | **9,208** |
| Age amount threshold | 46,751 | **46,432** |
| Canada employment amount | 1,511 | **1,501** |
| Medical 3% cap | 2,914 | **2,890** |
| OAS recovery threshold | 95,977 | **95,323** |
| RRSP dollar limit | 33,367 | **33,810** |
| Disability amount | — | **10,341** |
| Caregiver (child/spouse/eligible dep) | — | **2,740** |
| Pension income amount | 2,000 | **2,000** (never indexed) |
| FHSA annual / lifetime | 8,000 / 40,000 | **unchanged** (never indexed) |
| Dividend gross-ups | 38% / 15% | **unchanged** |
| Federal DTC (of grossed-up) | 15.0198% / 9.0301% | **unchanged** |
| Donations, first $200 | 14% | **14%** — follows the lowest bracket rate |
| Capital gains inclusion | 50% / **0.666667 high tier** | **50% flat, no high tier** |

The lowest federal rate is **14%** for 2026 — the full-year effect of the mid-2025
cut that made 2025 a blended 14.5%. Every credit valued at the lowest rate follows
it down.

### Ontario — current file value → published 2026

| Field | In file | Published 2026 |
|---|---|---|
| Bracket 1 (5.05%) | 52,886 | **53,891** |
| Bracket 2 (9.15%) | 105,775 | **107,785** |
| Brackets 3/4 (11.16% / 12.16%) | 150,000 / 220,000 | **unchanged — statutorily NOT indexed** |
| Basic personal amount | 12,747 | **12,989** |
| Age amount | 6,078 | **6,342** |
| Age amount threshold | 44,323 | **47,210** |
| Pension amount | 1,686 | **1,796** |
| Surtax threshold 1 (20%) | 5,864 | **5,818** |
| Surtax threshold 2 (36%) | 7,504 | **7,446** |
| ON DTC (of grossed-up) | 10.0% / 2.9863% | **unchanged** |
| Donations | 5.05% / 11.16% | **unchanged** |
| Ontario Health Premium table | as-is | **correct — never indexed, frozen since 2005** |

`@low-confidence` (secondary sources only): Ontario age amount and threshold,
pension amount, both surtax thresholds, ON DTC rates, ON tax reduction (300),
ON caregiver (6,122). **NOT FOUND:** Ontario-specific medical expense dollar cap
for 2026; ON caregiver net-income threshold. Leave those two at their current
values with a `@not-found` annotation rather than inventing figures.

### CPP / EI 2026

| Field | In file | Published 2026 |
|---|---|---|
| YMPE | 73,200 | **74,600** |
| YAMPE | 83,400 | **85,000** |
| Basic exemption | 3,500 | **3,500** |
| Employee rate | 5.95% | **5.95%** (max contribution 4,230.45) |
| CPP2 rate | 4.00% | **4.00%** (max 416.00) |
| Self-employed rate | 11.90% | **11.90%** (max 8,460.90) |
| EI maximum insurable earnings | 67,500 | **68,900** |
| EI employee rate | 1.66% | **1.63%** (max premium 1,123.07) |

The EI rate **fell**. Indexation projects the wrong direction — the class of error
a projection cannot catch.

### AMT 2026

Rate 20.5%; exemption **181,440** (derived from the 4th federal bracket); capital
gains inclusion 100%; non-refundable credits allowed 50%; **donation credit allowed
80%**; dividends included at cash value with no gross-up and no DTC.

## Materiality

Direction is consistent and partly self-cancelling: every federal bracket in the
file sits too high (understates federal tax); every Ontario amount is frozen at
2025 (overstates Ontario tax).

For Connor's 2026 profile — non-eligible dividends, single Ontario resident,
negligible capital gains — the net effect of the rate corrections is a few hundred
dollars. The phantom 66.67% capital-gains tier is immaterial to him personally
(2026 realised gains are ~$3.25) and structurally severe for anyone with gains
above $250,000.

The slip box fix has no effect on today's numbers — `tax_slips` holds exactly one
row, a 2025 T4 — and is the difference between a correct and a corrupted return the
first time a real T5 is entered.

## Scope

**In:** `backend/src/tax/data/rates-2026.ts`, `rates-2027.ts` (guard only),
`backend/src/tax/engine/t1.ts` (slip boxes and predicates, AMT credit total),
`backend/src/tax/engine/amt.ts` (donation fraction), `backend/src/tax/engine/types.ts`
(new rate-table field), and their colocated tests.

**Out:** anything touching data completeness, imports, reconciliation, or the
frontend. `rates-2024.ts` and `rates-2025.ts` are not re-verified here — 2025 was
verified on 2026-06-08 and 2024 is out of scope.

**Known gaps left open deliberately**, recorded so they are not rediscovered as
novel: superficial-loss detection does not scan registered accounts for affiliated
repurchase (`buildPersonalFacts.ts:91-94`); no foreign tax credit anywhere; OAS
clawback is not deducted from net income (`t1.ts:229-242`); `jurisdiction` is
hardcoded `CA-ON` (`buildPersonalFacts.ts:471`) despite `Entity.jurisdiction`
existing; the age credit reads an arbitrary `HouseholdMember` rather than the
entity's own (`buildPersonalFacts.ts:453-467`); `spouse`, `cppBenefits`,
`oasBenefits`, `tuitionFees`, `disabilityCredit` and `caregiverDependents` are
consumed by `buildT1` but never populated from actuals; no TOSI, LCGE, ABIL or
principal-residence handling.

## Testing

Backend `node:test` via `tsx`, colocated per house convention.

- Per-bracket assertions on the 2026 table against the published figures in this
  spec — a table-driven test, one case per value, so a regression names the value.
- A test asserting a `VERIFIED`-marked rate table has a source citation for every
  value. This is the guard against the exact failure being fixed.
- `rates-2027.ts` must be rejected by whatever path produces a filing-grade return.
- Slip mapping: a T5 with boxes 10/11/12 populated and box 26 empty must reconcile
  against computed non-eligible dividends and warn on a >$50 divergence
  (failure mode A). A T5 with boxes 24/25/26 populated must **not** disturb the
  non-eligible line (failure mode B). A T3 with box 49 and box 50 must take box 50.
- AMT: donation credit allowed at 80%; the full non-refundable credit set reaching
  the 50% allowance; exemption equal to the 4th federal bracket threshold.
- **Do not modify `t1-scenarios.test.ts` Scenario H.** It locks the correct
  Ontario surtax ordering. Its passing is the regression guard for the
  not-a-bug documented above.

## Relationship to the other specs

Four specs, written 2026-09-28, addressing "the personal tax section needs to be
accurate".

1. **Reconciliation foundation** — brokerage importer writes `transactions`,
   statement-balance anchoring, duplicate detection. The base.
2. **Engine correctness** — this spec. Fully independent; can proceed in parallel
   with 1.
3. **T1 completeness gate** — depends on 1, which produces the signals.
4. **2026 data backfill** — depends on 1's importer fix.

Build order: 1, 2, 3, 4. This spec is the only one whose result is provable today
against published sources, independent of the state of the data.

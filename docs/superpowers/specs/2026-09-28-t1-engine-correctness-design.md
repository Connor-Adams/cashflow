# T1 Engine Correctness — published 2026 rates, slip box mapping, AMT fractions

> **STATUS: SHIPPED 2026-09-29.** Commits `e3c2cbae`..`f8234983` on
> `claude/personal-tax-accuracy`. Every item in *Testing* below is covered except
> the AMT work, which was **cut** — see the AMT row in the changes table for the
> arithmetic showing it cannot reach Connor at any plausible draw level.
>
> Two things shipped that the spec did not ask for, both because the spec's own
> items could not land without them:
>
> - **`engineVersion.ts`** — the cache key now carries an engine fingerprint. The
>   spec treated the facts-only cache key as a separate blocker; it is not
>   separate. Without it every correction in this part changes no number on
>   screen. Rate constants fold into the fingerprint automatically; engine logic
>   needs a hand bump (`ENGINE_VERSION`, now 2).
> - **`computeEntityReturn.ts`** — both return handlers carried the same 45-line
>   compute-and-cache block, reachable only through a seeded household over
>   supertest, and its one test asserted `status === 404 || status === 200`.
>   Extracting it is what made the versioned key testable.
>
> One spec instruction proved wrong in the writing: the provenance guard is
> enforced at the **request boundary**, not inside compute. Inside compute it
> cascaded — `projectPersonalFactsFromPrevYear` resolves a projection by computing
> its parent, so refusing the unverified 2024 table refused to serve 2026 as well.
>
> Live consequence: 2024 returns now answer **409**, because `rates-2024.ts` is
> "encoded from plan recall, never cross-checked". 2024 owed $0.00.


**Date:** 2026-09-28
**Status:** Design; not yet implemented
**Type:** Correctness fix, backend only
**Part:** 2 of 7 — see "Relationship to the other parts" below

## Problem

Connor's personal T1 "seems low". Investigation on 2026-09-28 separated that into
data completeness (parts 0, 1a, 3, 4) and engine correctness (this spec). Three
engine defects are real, verified, and independent of any data question.

### 1. `rates-2026.ts` is a projection wearing a "VERIFIED" header

`backend/src/tax/data/rates-2026.ts:1-4` claims `VERIFIED 2026-05-24`. The body is
an indexation projection built before CRA published the real figures (federal
indexed amounts, November 2025; CPP/EI, November–December 2025). Every *indexed*
constant in it is therefore wrong.

The file applied **2.7%** (`:2` — "2025 thresholds x 1.027"); the published
federal factor was 2.0% and Ontario's was 1.9%.

**The Ontario amounts are worse than the file's own comments admit.** Several carry
`// 2025 value reused` (`:37`, `:109`, `:115`) but hold neither the 2025 value nor
anything derived from it — they are **2024 values indexed by 1.027**:

| Field | 2024 | 2025 | in `rates-2026.ts` | 2024 × 1.027 |
|---|---|---|---|---|
| `spousalAmountOntario` | 10,527 | 10,823 | **10,818** | 10,811 |
| `ageAmountOntario` | 5,916 | 6,223 | **6,078** | 6,076 |
| `dtcBaseOntario` | 9,586 | 10,298 | **9,852** | 9,845 |
| `pensionIncomeAmountCapOntario` | 1,641 | 1,762 | **1,686** | 1,685 |

Only `basicPersonalAmountOntario` (12,747) and the Ontario brackets genuinely match
2025. So those four amounts are two years stale *and* indexed by the wrong factor,
and the comments claiming otherwise cannot be trusted as documentation. An earlier
draft of this spec repeated "Ontario is frozen at 2025"; that is true of the BPA and
the brackets only.

Not every constant is wrong. The gross-ups, the federal and Ontario DTC rates, the
CPP basic exemption and rates, the non-indexed Ontario brackets, the $2,000 pension
amount, the FHSA limits and the Ontario Health Premium table are all correct and
must be left alone — the tables below mark each.

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

**The T3 entry form is also wrong, so a backend-only fix produces a new wrong
answer.** `frontend/src/pages/tax/slips/T3Form.tsx:7-9` labels box32 "Eligible
dividends actual" (CRA: taxable **non**-eligible), box49 "Eligible dividends
taxable" (CRA: **actual** eligible) and box50 "Eligible div tax credit" (CRA:
**taxable** eligible — the DTC is box 51). Reading box 50 in the engine while the
form collects the DTC there wires a credit into the eligible-dividend line. The
form must be corrected in the same change. `T5Form.tsx` is correct; generalising
from it to T3 was the error.

Two distinct failure modes. **One is silent; the other is loud but wrong** —

- **A pure non-eligible T5** — what CDG Labs will issue Connor (boxes 10/11/12,
  box 26 empty). `hasNonElSlips` at `t1.ts:121-123` tests `box26 > 0`, so it is
  **false**, the engine silently falls back to computed dividends, box 11 is
  ignored, and no reconciliation warning fires. The slip is decorative. The exact
  cross-check wanted at filing time does not happen.
- **Any T5 carrying eligible dividends** (boxes 24/25/26 — plausible, Connor holds
  a non-registered Wealthsimple Investing account). Box 26 holds the eligible DTC,
  `hasNonElSlips` flips **true**, and that credit figure *replaces* the entire
  computed non-eligible dividend total on L12010 via the slip preference at
  `t1.ts:123`. Tens of thousands of dollars of owner dividends are replaced by a
  ~15% credit figure. This mode **does** warn — `t1.ts:124-131` runs precisely
  because the predicate is true, and the divergence is enormous — but the warning
  says the slip and the computation disagree, not that the engine read the wrong
  box, and the wrong value is what lands on the line.

### 3. Three more engine defects that do affect Connor

- **FHSA ignores carryforward room and the lifetime cap.** `t1.ts:215-219` is
  `Decimal.min(sum(fhsaContribs), r.fhsaAnnualLimit)` — the annual limit only. The
  RRSP line five lines up correctly consults `facts.carryforwards.rrspRoom`
  (`:210`). `rollPersonalCarryforwards.ts:56-71` computes and persists `fhsa_room`,
  and `buildPersonalFacts.ts:437-443` never loads it: **`fhsa_room` is written and
  never read.** Two errors in opposite directions — carried-forward participation
  room is lost, and a contribution past the $40,000 lifetime cap still deducts
  $8,000. Connor's prod carryforwards hold `fhsa_room 2025 = 8,000` with
  `fhsa_lifetime_contribs = 0`, so an $16,000 catch-up year would deduct $8,000 and
  overstate taxable income by $8,000 — roughly $2,300–$2,800 of tax.
- **Income can be counted twice.** `buildPersonalFacts.ts:152-155` routes rows by
  tax treatment; `:288-308` then re-scans the same `txns` by `txnType`, skipping
  only the four treatments in `NOT_INCOME_TREATMENTS` (`not_income`,
  `loan_advance`, `loan_repayment`, `expense_reimbursement`). A row already routed
  as `non_eligible_dividend`, `salary` or `pension_income` and *also* typed
  `interest`/`dividend` is added a second time — and a `dividend` txnType is added
  as **eligible**, with the 38% gross-up and the eligible DTC. Reachable via a
  Wealthsimple Chequing `INT` row classified as dividend income in the queue.
- **Superficial loss cannot see registered accounts.** The repurchase scan runs over
  `acbActivity` filtered to the `non_registered`/`n_a` allowlist
  (`buildPersonalFacts.ts:91-94,321-333`). A trust governed by the taxpayer's
  TFSA/RRSP/FHSA is an **affiliated person**, so a repurchase inside a plan within
  the 61-day window denies the loss — and s.53(1)(f) gives **no** ACB addback in
  that case, so the loss is permanently lost, whereas the engine's iterative
  re-walk (`:363-396`) assumes the addback always applies. Connor holds account 15
  (non-registered), 8 (TFSA) and 11 (FHSA) at the same broker — the exact setup
  where this bites. Understates tax.

### 4. AMT credit fractions are incomplete

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
| `rates-2027.ts` | **Re-derive the whole table from the corrected 2026 figures**, and update `rates-2027.test.ts`; then mark it `provenance: 'projected'` | It cannot be "provenance only". `rates-2027.test.ts` couples to 2026 three ways: it derives the federal brackets from `RATES_2026`, and it hardcodes `indexed('52886')`, `indexed('105775')` and `indexed('16564')`. Correcting 2026 fails all three. `:138` also carries the derived `amtExemption: D('186327')` (= 182,674 x 1.02) and `:62-67` asserts it equals `federalBrackets[2].upTo`. Note too that `:76,86` do `capitalGainsInclusionThreshold!` — a non-null assertion that throws if the 250,000 threshold is removed. **Both rate-table test files are in scope.** |
| T2 scope | The corporate inclusion-rate change is **in scope and intended**; corp tests must be updated to expect 50% for 2026/2027 | It is the same cancellation, and leaving corporations at a repealed 66⅔% to keep this spec "backend-personal-only" would be preserving a known error for tidiness. |
| **Cache invalidation** | Add a **version component** to both return hashes — `hashFacts` in `scenarios/computeScenarioReturn.ts:126-129` and `factsHash(serializeFacts(facts))` at `routes/tax.ts:380` | Without this, **nothing in this spec changes any number on screen.** Both caches are keyed on facts alone, so a rate or engine correction leaves every cached row intact; the only invalidator is `{ force: true }` (`tax-scenarios.ts:483`), which nothing calls automatically. Prod holds 45 `scenario_returns` rows, oldest 2026-06-02. A version cannot be forgotten; a one-off purge has to be remembered on every future engine change. |
| FHSA room | Fix **both sides**: make `rollPersonalCarryforwards.ts` accumulate unused room, then load `fhsa_room` into `PersonalCarryforwards` and cap L20805 by it | An earlier draft said "the value is already computed and persisted; only the read is missing". Wrong. `rollPersonalCarryforwards.ts:56-64` computes `fhsaRoom = Decimal.min(fhsaAnnualLimit, lifetimeRemaining)` and never adds prior unused room — contrast the RRSP line three above it, which does `carryforwards.rrspRoom.plus(newRoom).minus(contribsUsed)`. So the stored value is capped at 8,000 forever and a read-only fix cannot produce a $16,000 catch-up year. `rollPersonalCarryforwards.ts` is therefore in scope. |
| ~~Unknown dividend eligibility~~ | **WITHDRAWN during implementation** | `buildPersonalFacts.ts:205-209` is `security?.dividendEligibility ?? 'eligible'`, and the txnType pass at `:307` pushes to `eligibleDividends` unconditionally. So an XEQT or VFV distribution in non-registered account 15 collects the 15.0198% federal and 10% Ontario **eligible** DTC it is not entitled to — silently understating tax. There is no unknown state to default: `Security.dividendEligibility` is `allowNull: false` with `defaultValue: 'eligible'` (`models/Security.ts:165-170`), so every security carries a concrete value and the `?? 'eligible'` in the builder was dead defensive code. And flipping the default would be **wrong** — dividends from a publicly traded Canadian corporation genuinely are eligible, so non-eligible would misclassify most securities to fix none. The real exposure is an ETF distribution, which is a mix of eligible dividends, foreign income, other income, return of capital and capital gains; the eligibility flag cannot express that at all. Reassigned to part 3 as an unverified-eligibility **gap**. |
| Double-count guard | Exclude from the `txnType` pass any row the treatment pass already routed | Inverting the guard — skip rows already classified as income, rather than listing the four non-income treatments — is the fix that does not need maintaining as treatments are added. |
| Guard against recurrence | A `provenance: 'published' \| 'projected'` field, enforced at **the return route** | The header at `rates-2026.ts:1-4` already discloses "encoded from indexation projection… engineer MUST update once CRA publishes". It told the truth and was served anyway, so a citation test would not have caught it. |
| Where the guard lives | **Both** return paths — `routes/tax.ts` and `routes/tax-scenarios.ts` / `computeScenarioReturn` — and **not** `ratesFor` | `ratesFor` (`brackets.ts:27-31`) takes only a year and has no caller identity, so "filing-grade caller" is not expressible there — and `scenarios/computeScenario.ts:26`, `computeHouseholdPlan.ts:244` and `projectPersonalFactsFromPrevYear.ts:46` all legitimately want the 2027 projection. |
| The "surface it as a gap" half | **Part 3 owns it** | It is part 3's `completeness.gaps` field. Keeping it here made this part depend on part 3 while claiming independence — and since 2026 does not close until 2026-12-31, the gap surface is the only live behaviour for the whole window Connor cares about. |
| `capitalGainsInclusionHigh` | **Set it to 0.5**, and accept that this changes T2 — because the change is correct | Two earlier drafts got this wrong in opposite directions. The field is read as the *corporate* inclusion rate at `engine/t2.ts:65`, `integration.ts:106` and `aaii.ts:16`, always as `r.capitalGainsInclusionHigh ?? r.capitalGainsInclusion` — and `capitalGainsInclusion` is `0.5`. So **setting the field to 0.5 and deleting it are behaviourally identical**; a draft that argued "retain it so T2 does not change" was self-defeating. More importantly, T2 *should* change: the cancelled 2024 measure put corporations at 66⅔% on **all** capital gains with no threshold, and its cancellation returns them to 50% for 2026 exactly as it does individuals. `t2.ts:63`'s comment ("corps use the high rate (66.67%) on ALL gains") describes a regime that no longer exists. Retain the field for `rates-2024.ts`, where 0.666667 is legitimate. |
| Slip box fix | Read box 11 / box 50, and re-gate `hasXSlips` off those boxes | Fixing the box without fixing the predicate leaves failure mode A in place. |
| ~~AMT donation fraction and credit set~~ | **CUT during implementation** | Both are real defects — post-2024 AMT allows 80% of the donation credit rather than 50%, and `t1.ts` passes only the BPA/spousal/age/employment/CPP-EI block into the 50% allowance, overstating AMT. Neither can reach Connor. `amt.ts:31-46` backs the dividend gross-up out of the AMT base, so at $83k–$121k of cash dividends his adjusted taxable income is roughly $80k–$118k against a $181,440 exemption: `amtBase` is zero and `amtAdditional` is zero at every plausible draw level, donations or not. Building it would contradict the prioritisation this part argues for — the rate corrections are worth $12–$30/yr and the data work a thousand times that. Reinstate if AMT ever becomes reachable, i.e. if taxable income approaches the 4th federal bracket or large capital gains appear. |
| `amtExemption` | Derive from the 4th federal bracket, don't store independently | Removes a class of drift and the inherited transposition. **Kept** while the rest of the AMT work is cut, because it costs one line and closes a drift class for free. |

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
| Disability amount (`dtcBaseFederal`) | 10,412 | **10,341** |
| `dtcSupplementFederal` | 6,075 | verify — not researched |
| `dtcSupplementThreshold` | 3,558 | verify — not researched |
| Caregiver (child/spouse/eligible dep) | — | **2,740** (new field) |
| `caregiverAmountFederalInfirmAdult` | 8,437 | **8,773** `@low-confidence` |
| `caregiverThresholdFederal` | 19,811 | **20,601** `@low-confidence` |
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
| `spousalAmountOntario` | 10,818 | **11,029** `@low-confidence` |
| `dtcBaseOntario` | 9,852 | verify — not researched |
| Surtax threshold 1 (20%) | 5,864 | **5,818** |
| Surtax threshold 2 (36%) | 7,504 | **7,446** |
| ON DTC (of grossed-up) | 10.0% / 2.9863% | **unchanged** |
| Donations | 5.05% / 11.16% | **unchanged** |
| Ontario Health Premium table | as-is | **correct — never indexed, frozen since 2005** |

`@low-confidence` (secondary sources only): Ontario age amount and threshold,
pension amount, both surtax thresholds, ON DTC rates, spousal amount.

**Fields that do not exist and are not being added here:** there is no ON tax
reduction field, no Ontario caregiver field, and no Ontario-specific medical cap —
`medicalCreditOntario` reuses the federal `r.medicalThresholdCap`
(`engine/credits.ts:128-139`). An earlier draft said to "leave those at their
current values", which is impossible; they have none. Adding them is out of scope.

**Not stored, so not in the table:** the self-employed CPP rate, computed as
`employeePortion x 2` (`engine/cpp-ei.ts:20-30`).

Every value the table marks as changing must be verified against the file before
the implementation plan is written — the "In file" column was transcribed by hand.

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

Direction is **not** uniform. Every federal bracket sits too high (understates
federal tax). The Ontario BPA and brackets are frozen at 2025, and four Ontario credit
amounts are 2024 values mis-indexed (both overstate Ontario tax). But the surtax thresholds were indexed *up* — 5,864/7,504 against a
published 5,818/7,446 — which **understates** surtax.

**Measured, not estimated.** `buildT1` was run against Connor's 2026 fact shape
(non-eligible dividends only, $49.84 interest, the $2,872 self-employment-expense
artefact, age 33, CA-ON) under `ratesFor(2026)`, and an independent model
reproducing the file's constants matched the engine **to the cent** at every point.
Swapping only the constants to the published figures gives:

| Non-eligible dividend draws | File rates | Published rates | Correction worth |
|---|---|---|---|
| $67,000 | $4,538.85 | $4,527.17 | **−$11.68** |
| $82,000 | $7,580.64 | $7,568.96 | **−$11.68** |
| $91,000 | $9,533.96 | $9,520.80 | **−$13.17** |
| $111,000 | $15,389.95 | $15,359.57 | **−$30.38** |

So for this taxpayer the entire rate correction is worth **$12–$30 a year**. The
errors very nearly cancel. An earlier draft of this spec said "a few hundred
dollars"; that was a guess, and it was wrong by an order of magnitude.

This does not make the work optional — the constants are wrong, the phantom
66.67% capital-gains tier is severe for anyone realising gains above $250,000, and
a wrong rate table poisons every scenario and projection built on it. But it must
not be sold as moving Connor's bottom line. **The data work is worth roughly a
thousand times more to him**: the single unimported $15,000 draw is $3,042, and the
coverage gap is worth importing rather than estimating.

The slip box fix has no effect on today's numbers — `tax_slips` holds exactly one
row, a 2025 T4 — and is the difference between a correct and a corrupted return the
first time a real T5 is entered.

### Why the existing tests did not catch any of this

`backend/src/tax/t1-scenarios.test.ts:39-56` ("Scenario A") asserts only that
`totalPayable` falls between $14,000 and $17,000 — a $3,000-wide band — while its
own comment states the correct value is `15,067.70`. Line `:41` still carries a
literal `$XX,XXX (engineer: fill in from CRA publication or accountant)`
placeholder. A rate-table error of roughly 10% passes that test in silence.

Tightening the reference scenarios to exact expected values is therefore part of
this spec, not a nicety: without it, the corrected constants have no regression
guard either.

## Scope

**In:** `backend/src/tax/data/rates-2026.ts`, `rates-2027.ts` (**re-derived**),
`rates-2026.test.ts` and `rates-2027.test.ts` (the hardcoded 2026 bases),
`backend/src/tax/engine/t1.ts` (slip boxes and predicates, AMT credit total and
the AMT call site), `backend/src/tax/engine/amt.ts` (donation fraction, plus an
`AmtInput` field for the donation credit — `amt.ts:4-14` has none today, so the
rate-table field is inert without it), `backend/src/tax/engine/types.ts` (two new
rate-table fields: the AMT donation fraction and `provenance`),
`backend/src/tax/engine/brackets.ts` (the `provenance` field), **both** return paths
for the guard — `routes/tax.ts` and `routes/tax-scenarios.ts` /
`tax/scenarios/computeScenarioReturn.ts`, since `routes/tax.ts` feeds only the
Overview tab (part 0) —
`backend/src/tax/services/rollPersonalCarryforwards.ts` (FHSA room accumulation),
`backend/src/tax/builders/buildPersonalFacts.ts` (dividend-eligibility default, the
double-count guard),
**`frontend/src/pages/tax/slips/T3Form.tsx`** (box labels — the one frontend file
this spec must touch), and their colocated tests.

**Out:** anything touching data completeness, imports or reconciliation, and any
frontend file other than `T3Form.tsx`. `rates-2024.ts` and `rates-2025.ts` are not
re-verified here — 2025 was verified on 2026-06-08 and 2024 is out of scope. T2
behaviour must not change: see the `capitalGainsInclusionHigh` decision.

**Known gaps left open deliberately**, recorded so they are not rediscovered as
novel: a dividend credited to a shareholder loan reaches the corp's `dividendsPaid`
(`buildCorpFacts.ts:257-280`) but contributes $0 to the T1, because
`buildPersonalFacts` never reads `ShareholderLoan` — and nothing reconciles corp
`dividendsPaid` against personal `nonEligibleDividends` at all
(`tax/reconciliation/buildReport.ts:10-14` has only three T4-only detectors). That
is nil while `shareholder_loans` is empty and high the moment a year-end dividend
clears a loan, which is the standard sole-shareholder move. Also: superficial-loss detection does not scan registered accounts for affiliated
repurchase (the taxable-account allowlist at `buildPersonalFacts.ts:91-94` bounds
the scan at `:317,363,402`); no foreign tax credit anywhere; OAS
clawback is not deducted from net income (`t1.ts:229-242`); `jurisdiction` is
hardcoded `CA-ON` (`buildPersonalFacts.ts:471`) despite `Entity.jurisdiction`
existing; the age credit reads an arbitrary `HouseholdMember` rather than the
entity's own (`buildPersonalFacts.ts:453-467`), and the birthday adjustment inside
it is dead code — `dobMonth > 12 || (dobMonth === 12 && dobDay > 31)` at `:462` is
unsatisfiable, so age is never decremented, though the result happens to be correct
for an at-Dec-31 age; T5 boxes 10/12/18 and T3 box 23 are collected by the forms
and never read by `buildT1`; `spouse`, `cppBenefits`,
`oasBenefits`, `tuitionFees`, `disabilityCredit` and `caregiverDependents` are
consumed by `buildT1` but never populated from actuals; no TOSI, LCGE, ABIL or
principal-residence handling.

## Testing

Backend `node:test` via `tsx`, colocated per house convention.

- **Tighten `t1-scenarios.test.ts` Scenario A to an exact expected value** and
  remove the `$XX,XXX` placeholder at `:41`. Its current $14k–$17k band is why the
  wrong constants survived. Do the same for any other scenario asserting a range
  where an exact figure is known.
- Per-bracket assertions on the 2026 table against the published figures in this
  spec — a table-driven test, one case per value, so a regression names the value.
  Values this spec marks "verify — not researched" must be researched before the
  plan is written; the test cannot be written against a blank.
- A table marked `provenance: 'projected'` is refused for a **closed** year, on
  **both** return paths, using an injected table. This is the guard against the exact
  failure being fixed — not a citation test, which the honest header at
  `rates-2026.ts:1-4` would already have passed.

  Note what this test can and cannot cover when it ships. 2026 does not close until
  2026-12-31, so the refusal branch is **dormant** for the whole window Connor works
  in, and the only live behaviour — surfacing a projected table as a completeness gap
  — belongs to part 3 and is tested there. That is a real limitation of shipping this
  part before part 3, stated rather than papered over: at part 2's ship time the guard
  is exercised only against a synthetic closed year.
- `capitalGainsInclusionHigh` stays present at 0.5: assert `t2.ts`, `integration.ts`
  and `aaii.ts` still compute corporate capital gains unchanged.
- The corrected T3 form and the corrected engine boxes agree: a T3 entered through
  the form produces the taxable eligible amount on L12000, not the DTC.
- Slip mapping: a T5 with boxes 10/11/12 populated and box 26 empty must reconcile
  against computed non-eligible dividends and warn on a >$50 divergence
  (failure mode A). A T5 with boxes 24/25/26 populated must **not** disturb the
  non-eligible line (failure mode B). A T3 with box 49 and box 50 must take box 50.
- AMT: donation credit allowed at 80%; the full non-refundable credit set reaching
  the 50% allowance; exemption equal to the 4th federal bracket threshold.
- FHSA, two tests: the **roll** accumulates $8,000 of unused room into the next
  year's `fhsa_room`; and given $16,000 of stored room a $16,000 contribution
  deducts $16,000 (the cap is the stored room, **not** stored room plus the annual
  limit, which would double-count the current year); a contribution breaching the $40,000 lifetime cap is
  capped at the remaining room, not at the annual limit.
- Double-count: a transaction typed `interest` and classified `non_eligible_dividend`
  appears on exactly one line, as a non-eligible dividend.
- A dividend on a security with no recorded eligibility lands on L12010 as
  non-eligible and raises a warning; one explicitly marked eligible still lands on
  L12000.
- **Cache invalidation: changing a rate constant changes the served number.** Assert
  it end-to-end through the route, not just through `buildT1` — this is the test
  that proves the spec has any visible effect at all.
- **Do not modify `t1-scenarios.test.ts` Scenario H.** It locks the correct
  Ontario surtax ordering. Its passing is the regression guard for the
  not-a-bug documented above.

## Relationship to the other parts

**0** Provenance (ships first) · **1a** Brokerage cash legs · **1b** Duplicate
detection, detect-and-report · **1c** Statement balances (**cut**) · **2** Engine
correctness, this part · **3** Completeness gate · **4** 2026 backfill ·
**5** Instalments and the forward view.

This part shares no file, migration or test with 1a, so the two could run in
parallel — but it is scheduled after part 4's first steps because its measured value
to Connor is $12–$30/yr against part 4's thousands. Note also the cache-invalidation
decision above: without a version component in both return hashes, nothing in this
part changes a number on screen.

Build order: **0 → 1a → 4 (steps 1, 2, 7) → 2 → 1b → 3 → 4 (rest) → 5**. Part 1c is **cut**.

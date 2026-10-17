# Embedding-match threshold calibration — production measurement

**Date:** 2026-09-28
**Decides:** whether the stage-5.5 embedding-match enrichment stage (#792, PR #1143)
ships, at what cosine threshold, or is deleted.
**Verdict:** **do not ship as-is.** Fix `merchant_clean` normalization first; the
stage is a 267 MB dependency that resolves **12 of 1452** cold rows, and **10 of
those 12** are string variants a normalizer would collapse for free.

---

## Why the previous evidence was not decision-grade

The stage shipped a `0.85` threshold justified by three hand-picked pairs:
`SHOPPERS DRUG MART`~`SHOPPERS` at 0.687 (the motivating case, "19 uncategorised
rows"), `BLUE BOTTLE`~`BLUE BOTTLE COFFEE` at 0.763, and `UBER EATS`~`UBER TRIP`
at 0.680 (a must-not-match). A 0.007 margin on n=3.

This document replaces that with a sweep over the real corpus. Two of the three
spot checks turn out to be misleading, and the motivating one is impossible.

**The pipeline used here is verified faithful to the stage.** Re-embedding the
three quoted pairs with the same model, dtype and pooling reproduces all three to
four decimals — 0.6867, 0.7629, 0.6797. Every number below comes from that same
pipeline.

---

## Method

Mirrors the shipped logic rather than inventing a comparable one. Read from
`backend/src/ai/merchantEmbeddings.ts`, `embeddingMatchStage.ts` and
`embeddingMatchOverColdRows.ts`:

| Stage behaviour | What this analysis does |
|---|---|
| Embeds `merchant_clean` (not raw, not canonical) | same |
| `Xenova/all-MiniLM-L6-v2`, `dtype: 'q8'`, mean pooling, normalized | same |
| Priors = `loadHouseholdMerchants`: `reviewed_at IS NOT NULL AND final_category IS NOT NULL`, modal category per merchant, household-scoped | same |
| Candidate set excludes priors with an identical `merchant_clean` (merchant-memory already catches those) | same — leave-one-out |
| `bestEmbeddingMatch`: argmax similarity, tie-break higher `supportCount` | same |
| **No minimum support gate** — `supportCount` is only a tie-break | same (confirmed: the stage has no support floor) |
| Inclusive `>=` threshold | same |

Two metrics, because they answer different questions:

- **All-pairs** (as briefed): over every distinct merchant pair, TP = `sim>=t` and
  same `final_category`, FP = `sim>=t` and different, FN = `sim<t` and same.
  Gives the raw false-positive count.
- **Best-match (leave-one-out 1-NN)**: for each labelled merchant, take its single
  best *other* prior at/above threshold and predict that prior's category.
  **This is what the stage actually does** — it never scores a pair in isolation,
  it always takes an argmax. This is the number that maps onto the payoff.

Deduplicated to distinct `merchant_clean` keys first, so frequent merchants do
not dominate pair counts.

### Corpus

| Set | Distinct merchants | Pairs |
|---|---|---|
| **Stage-faithful priors** (`reviewed_at NOT NULL` + `final_category`) | **149** (from 255 rows) | 11,026 |
| **Broader labelled** (`final_category`, any reviewed state) — proxy for a larger reviewed corpus | **965** | 465,130 |
| **Cold** (`review_flag = true AND final_category IS NULL`) | **862** (2,744 rows; **1,452** of them `txn_type='purchase'`) | — |

Two things worth noting before any curve:

1. The stage's real prior corpus is **149 merchants**, not 965, because
   `loadHouseholdMerchants` requires `reviewed_at IS NOT NULL` and only 255 rows
   in production have ever been reviewed.
2. `merchant_embeddings` has **0 rows** — the stage has never run in production.

Random-pair baseline (two merchants share a category by chance): **16.3%**. Any
precision above that is signal. The largest categories are `Eating Out` (260),
`Investments` (220), `Transfer` (138), `Amazon` (110) — not `Household` (9), so
the "one bucket swamps everything" concern does not apply in the way expected;
per-category precision is reported below regardless.

---

## Part 1 — the curve

Precision/recall on the 965-merchant labelled corpus (the 149-merchant set is too
small for a stable curve — only 77 of its 11,026 pairs clear 0.55 at all), plus
the cold-row payoff against the **real** 149-merchant priors on the right.

| t | P (all-pairs) | R (all-pairs) | FP pairs | P (best-match) | coverage | wrong | cold merch | cold purch rows |
|---|---|---|---|---|---|---|---|---|
| 0.55 | 83.3% | 34.0% | 5157 | 96.6% | 91.7% | 30 | 95 | 130 |
| 0.56 | 83.5% | 33.3% | 5006 | 97.0% | 91.3% | 26 | 87 | 115 |
| 0.57 | 83.5% | 32.5% | 4868 | 97.3% | 90.8% | 24 | 79 | 104 |
| 0.58 | 83.6% | 31.8% | 4733 | 97.5% | 90.3% | 22 | 71 | 87 |
| 0.59 | 83.8% | 31.1% | 4563 | 97.7% | 89.8% | 20 | 65 | 77 |
| 0.60 | 84.2% | 30.3% | 4303 | 97.9% | 89.4% | 18 | 60 | 72 |
| 0.61 | 85.0% | 29.6% | 3976 | 98.1% | 88.8% | 16 | 55 | 67 |
| 0.62 | 85.6% | 29.0% | 3690 | 98.1% | 88.6% | 16 | 50 | 61 |
| 0.63 | 86.3% | 28.5% | 3425 | 98.1% | 87.8% | 16 | 41 | 46 |
| 0.64 | 87.1% | 28.1% | 3148 | 98.1% | 87.6% | 16 | 38 | 43 |
| 0.65 | 87.9% | 27.6% | 2872 | 98.2% | 86.9% | 15 | 32 | 37 |
| 0.66 | 88.8% | 27.2% | 2607 | 98.7% | 86.1% | 11 | 30 | 35 |
| 0.67 | 89.3% | 26.7% | 2421 | 98.7% | 85.9% | 11 | 27 | 33 |
| 0.68 | 89.7% | 26.1% | 2272 | 98.9% | 85.7% | 9 | 26 | 32 |
| 0.69 | 90.1% | 25.6% | 2126 | 98.9% | 85.7% | 9 | 25 | 30 |
| 0.70 | 90.7% | 25.1% | 1948 | 99.2% | 85.3% | 7 | 23 | 28 |
| 0.71 | 91.2% | 24.6% | 1804 | 99.3% | 84.8% | 6 | 22 | 27 |
| 0.72 | 91.4% | 24.1% | 1709 | 99.3% | 84.4% | 6 | 20 | 25 |
| 0.73 | 92.0% | 23.6% | 1560 | 99.3% | 84.4% | 6 | 20 | 25 |
| 0.74 | 92.6% | 23.2% | 1397 | 99.3% | 84.0% | 6 | 18 | 22 |
| 0.75 | 93.3% | 22.7% | 1233 | 99.3% | 83.5% | 6 | 17 | 22 |
| 0.76 | 93.7% | 22.1% | 1131 | 99.3% | 83.1% | 6 | 16 | 21 |
| 0.77 | 93.9% | 21.5% | 1052 | 99.3% | 82.7% | 6 | 16 | 21 |
| 0.78 | 94.1% | 20.6% | 975 | 99.2% | 82.0% | 6 | 16 | 21 |
| 0.79 | 94.2% | 19.1% | 897 | 99.2% | 81.3% | 6 | 15 | 20 |
| 0.80 | 93.9% | 17.2% | 838 | 99.2% | 80.6% | 6 | 14 | 15 |
| 0.81 | 93.7% | 15.3% | 781 | 99.2% | 80.1% | 6 | 13 | 13 |
| 0.82 | 93.9% | 14.4% | 710 | 99.2% | 79.9% | 6 | 13 | 13 |
| 0.83 | 94.3% | 14.0% | 636 | 99.3% | 79.1% | 5 | 12 | 13 |
| 0.84 | 95.0% | 13.6% | 540 | 99.3% | 78.0% | 5 | 11 | 12 |
| 0.85 | 95.1% | 13.0% | 512 | 99.5% | 77.5% | 4 | 11 | 12 |
| 0.86 | 95.0% | 12.4% | 490 | 99.5% | 76.6% | 4 | 11 | 12 |
| 0.87 | 95.3% | 11.8% | 435 | 99.5% | 75.8% | 4 | 11 | 12 |
| 0.88 | 95.8% | 11.2% | 369 | 99.4% | 74.3% | 4 | 11 | 12 |
| 0.89 | 96.7% | 10.6% | 271 | 99.4% | 72.8% | 4 | 11 | 12 |
| 0.90 | 98.0% | 10.1% | 154 | 99.4% | 71.1% | 4 | 11 | 12 |
| 0.91 | 99.0% | 9.7% | 75 | 99.4% | 69.1% | 4 | 10 | 11 |
| 0.92 | 99.5% | 9.3% | 39 | 99.4% | 66.7% | 4 | 10 | 11 |
| 0.93 | 99.6% | 8.9% | 27 | 99.3% | 63.1% | 4 | 10 | 11 |
| 0.94 | 99.6% | 8.2% | 23 | 99.3% | 60.0% | 4 | 10 | 11 |
| 0.95 | 99.6% | 7.3% | 21 | 99.3% | 57.3% | 4 | 10 | 11 |


`P (all-pairs)` / `R (all-pairs)` / `FP pairs` are the briefed metric.
`P (best-match)` / `coverage` / `wrong` are the leave-one-out metric the stage
actually decides with (`wrong` = merchants assigned the wrong category).
`cold merch` / `cold purch rows` are Part 2's payoff against the real 149 priors.

### Reading the curve

At face value this looks like a *good* classifier. Best-match precision is
**99.3-99.5% flat from 0.70 to 0.95**, and all-pairs precision reaches 99.5% at
0.92 with only 39 false-positive pairs. If you stopped here you would ship at
0.85 and feel good.

**That precision is an artifact, and the false positives say so.** The 25
highest-similarity different-category pairs are *all* Wealthsimple transfer
sentences differing only by an embedded date:

```
0.9952  "Tax-free money transfer out of the account (executed at 2026-06-04)" [Transfer]
      ~ "Tax-free money transfer out of the account (executed at 2026-07-06)" [Investments]
0.9950  "Money transfer out of the account (executed at 2026-03-08)" [Transfer]
      ~ "Money transfer out of the account (executed at 2026-07-01)" [Investments]
```

These are not merchants. `merchant_clean` for Wealthsimple rows is a full
sentence containing a date. They inflate the true-positive count enormously
(7,051 TP pairs at 0.92 from a 965-merchant corpus means large near-duplicate
clusters), and the "false positives" among them are mostly **ground-truth label
noise** — the same sentence categorised `Transfer` some months and `Investments`
others — not model error.

So the all-pairs curve measures the corpus's duplicate structure, not the
stage's usefulness. **The per-threshold FP count is therefore not a usable safety
signal here**, which is why Part 2 enumerates every real decision instead.

### Per-category precision (best-match, t=0.85, labelled corpus)

| true category | matched | precision |
|---|---|---|
| Investments | 216 | 99.1% |
| Eating Out | 202 | 100% |
| Transfer | 123 | 98.4% |
| Amazon | 106 | 100% |
| Investment income | 51 | 100% |
| Groceries | 17 | 100% |
| Racing | 13 | 100% |
| Hosting | 8 | 100% |
| Alcohol / Gas | 3 each | 100% |
| tire air / Golf / cc fees | 2 each | 100% |

Precision is **not** an artifact of guessing the biggest bucket — it is at or near
100% in every category, including small ones. But look at *where the coverage is*:
`Investments` (216), `Transfer` (123) and `Amazon` (106) are **445 of the 748
matches, and all three are machine-generated strings** (Wealthsimple transfer
sentences, Amazon order descriptors). The only two categories with sub-100%
precision are the two Wealthsimple ones, which is the label-noise problem above.
Strip the machine-generated strings and the corpus that remains is small and
overwhelmingly handled by casefolding. Same artifact, different angle.

### The real false positive

The must-not-match case is **much worse than the spot check claimed**. The brief
scored `UBER EATS`~`UBER TRIP` at 0.680 using truncated names. The actual
production strings score:

```
0.7962  "UBER TRIP HTTPS://HELP.UB"  ->  "UBER EATS HTTPS://HELP.UB" [Eating Out]   5 rows
0.7148  "UBER TRIP HTTPS://HELP.UB [UNITED STATES DOLLAR 42.87 @ 1.41381]" -> "UBER EATS ..." 1 row
0.6747  "UBER TRIP HTTPS://HELP.UB [UNITED STATES DOLLAR 22.90 @ 1.38908]" -> "UBER EATS ..." 1 row
0.6692  "Uber" -> "UBER EATS HTTPS://HELP.UB" [Eating Out]                          1 row
```

At **0.796**, not 0.680. The shipped 0.85 threshold clears it — but the safety
margin is 0.054, not the 0.007 believed, and it runs the *wrong way*: any attempt
to lower the threshold to buy more payoff immediately miscategorises 5 Uber ride
rows as `Eating Out`. A second genuine semantic failure appears at 0.70:
`WINGSTOPCANADA.OLO.COM TORONTO` -> `SHEIN.COM TORONTO` [Clothing] — a restaurant
matched to a clothing retailer because both strings end in `.COM TORONTO`.

---

## Part 2 — the payoff

Cold rows that would get a match at all, against the stage's **real** 149-merchant
prior corpus. Each match classified as a **trivial string variant** (token-set
Jaccard >= 0.6 after stripping digits and punctuation — i.e. the same merchant
under different boilerplate, which a normalizer would collapse with no model) or a
**genuine semantic generalization**.

| t | merchants | purchase rows | % of 1452 | trivial | genuine | tier `high` (>=0.92) |
|---|---|---|---|---|---|---|
| 0.95 | 10 | 11 | 0.8% | 9 merch / 10 rows | 1 merch / 1 row | 10 merch / 11 rows |
| 0.92 | 10 | 11 | 0.8% | 9 / 10 | 1 / 1 | 10 / 11 |
| **0.85 (shipped)** | **11** | **12** | **0.8%** | **9 / 10** | **2 / 2** | **10 / 11** |
| 0.80 | 14 | 15 | 1.0% | 11 / 11 | 3 / 4 | 10 / 11 |
| 0.75 | 17 | 22 | 1.5% | 13 / 17 | 4 / 5 | 10 / 11 |
| 0.70 | 23 | 28 | 1.9% | 13 / 17 | 10 / 11 | 10 / 11 |
| 0.65 | 32 | 37 | 2.5% | 15 / 19 | 17 / 18 | 10 / 11 |

**Every match at the shipped 0.85 threshold, in full:**

```
1.0000 HIGH    1r GENUINE  "A & W" -> "A&W" [Eating Out]
0.9943 HIGH    1r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.43933]" -> "... @ 1.4349]" [Discord Nitro]
0.9876 HIGH    1r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.4101]"  -> "... @ 1.4349]" [Discord Nitro]
0.9858 HIGH    1r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.44641]" -> "... @ 1.4349]" [Discord Nitro]
0.9849 HIGH    1r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.41807]" -> "... @ 1.4349]" [Discord Nitro]
0.9843 HIGH    2r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.40478]" -> "... @ 1.4349]" [Discord Nitro]
0.9830 HIGH    1r trivial  "DISCORD* NITROMONTHLY ... [USD 11.29 @ 1.42073]" -> "... @ 1.4349]" [Discord Nitro]
0.9765 HIGH    1r trivial  "CLOUDFLARE SAN FRANCISCO [USD 11.82 @ 1.44755]"  -> "CLOUDFLARE ... [USD 4.72 @ 1.41314]" [Domains]
0.9759 HIGH    1r trivial  "CLOUDFLARE SAN FRANCISCO [USD 11.80 @ 1.43729]"  -> "CLOUDFLARE ... [USD 4.72 @ 1.41314]" [Domains]
0.9678 HIGH    1r trivial  "CLOUDFLARE SAN FRANCISCO [USD 11.04 @ 1.36232]"  -> "CLOUDFLARE ... [USD 4.72 @ 1.41314]" [Domains]
0.9030 medium  1r GENUINE  "Starbucks Coffee" -> "STARBUCKS" [Eating Out]
```

That is the entire output of the stage on production data: **12 rows of 1,452
(0.8%)**, of which the genuine semantic contribution is **2 rows** — `A & W`
(punctuation) and `Starbucks Coffee` (case). The other 10 are one Discord
subscription and one Cloudflare bill whose `merchant_clean` embeds a different FX
rate each month.

### The motivating case does not exist

The stage's stated justification was `SHOPPERS DRUG MART`~`SHOPPERS` resolving 19
uncategorised rows. In production:

```sql
SELECT COUNT(*) FROM transactions
WHERE final_category IS NOT NULL AND merchant_clean ILIKE '%shopper%';
-- 0
```

**Zero.** There are 84 cold `SHOPPERS` rows and 8 unflagged ones, and not one of
them is categorised. There is no `SHOPPERS` prior with a category to generalize
*from*, so the stage cannot resolve this case at any threshold. Against the real
149 priors, `SHOPPERS DRUG MART` (71 purchase rows — the largest single cold
merchant) best-matches **`THE BEER STORE` [Alcohol] at 0.5322**: wrong, and far
below any threshold. The 12 `CONTACTLESS INTERAC PURCHASE - #### SHOPPERS DRUG M`
variants score **0.31-0.41** against their best prior.

The 0.687 pair was constructed by hand between two strings, one of which is not in
the corpus. It was never evidence about this system.

### Would a larger reviewed corpus save it?

The obvious rescue is "the prior corpus is only 149 merchants because little has
been reviewed; it will improve." Testing that with the 965-merchant labelled
corpus as a proxy for a **6.5x larger** reviewed set:

| t | merchants | rows (all) | rows (**purchase**) |
|---|---|---|---|
| 0.75 | 182 | 758 | 138 |
| 0.85 | 110 | 492 | **32** |
| 0.92 | 78 | 419 | **17** |

At 0.85, 6.5x the priors buys **32 of 1452 purchase rows — 2.2%**. The `rows (all)`
column is much larger only because the extra matches are Wealthsimple
transfer/investment sentences, which are not what the review queue is for. Corpus
growth does not rescue this; it is sublinear and lands in the wrong bucket.

---

## The confidence tier — two corrections

The brief stated that matches come back `medium`, that `computeReviewFlag`
requires a non-`ai` **high** signal to clear `review_flag`, and therefore that the
row "proceeds to the paid AI batch anyway" — so the stage could never reduce AI
spend. **Both halves of that are wrong**, and a `high` tier is already reachable.

1. **`high` is reachable and already fires.** `similarityToConfidence`
   (`embeddingMatchStage.ts:49`) returns `'high'` at `sim >= 0.92`. And
   `computeReviewFlag`'s gate is:

   ```ts
   const hasNonAiHighConfidence = signals.some(
     (s) => s.confidence === 'high' && s.source !== 'ai' && s.fields.autoCategory != null,
   );
   ```

   An embedding signal at `>=0.92` satisfies it — `source` is `'embedding'`, not
   `'ai'`. So it **does** clear `review_flag`. On production, **10 of the 11**
   matching merchants at t=0.85 land `>=0.92` and come back `high`.

2. **A `medium` match still avoids the AI batch.** In
   `embeddingMatchOverColdRows.ts` the orchestrator pushes to `remainingColdRows`
   *only* when `signals.length === 0`. Any match — medium or high — removes the row
   from the AI-batch candidate set. What a medium match leaves behind is
   `review_flag = true`, i.e. the row stays in the *human* review queue while
   still saving the AI call.

So the answer to "does a threshold exist at which matches could justifiably be
`high`?" is **yes — 0.92, and the code already does it.** This removes the
"cannot reduce AI spend, decisive on its own" argument. It is replaced by a worse
one: the stage *can* reduce AI spend, by **12 calls out of 1,452 (0.8%)**, and 10
of those 12 are duplicates a regex would catch.

### `embedding` is missing from `PRECEDENCE` — confirmed

Confirmed as briefed. `embedding` is a legal `SignalSource`
(`types.ts:15`) but appears nowhere in the `PRECEDENCE` table
(`computeReviewFlag.ts:3-20`), so `signalRank()` falls through to `return 0` and
an embedding signal sorts below even `type-detect` at low confidence.

What it implies: in `mergeSignals` the signals are sorted by rank, and each field
is claimed by the first signal that offers a non-null value. At rank 0 an
embedding signal is sorted **last**, so it can only ever win a field no other
signal claims — it can never correct a wrong category another stage already set.
For genuinely cold rows that is inert (nothing else claims `autoCategory`, so
embedding wins it), which is why the stage still functions. But it means the
stage's ceiling is exactly the cold set and nothing more: it has no ability to
improve a row any other stage has touched. It also makes `categoryWinner` — and
therefore `auto_confidence` — silently depend on no other stage emitting a
non-null `autoCategory`, which is fragile rather than designed. If the stage were
kept, `embedding` belongs in `PRECEDENCE` explicitly (somewhere around
`memory/medium`) so the ordering is intentional rather than an accident of
falling through to 0.

---

## Cost

`@huggingface/transformers` pulls `onnxruntime-node` (**287 MB** on disk), plus
36 MB of library and 18 MB of `@img/sharp-*` platform packages; the Dockerfile
prunes and bakes ~23 MB of q8 weights. The briefed **+267 MB** image delta is
consistent with what is installed. Per resolved row at the shipped threshold that
is ~22 MB of image for each of 12 rows, or ~134 MB for each of the 2 genuine ones.

---

## Recommendation

**Do not ship the stage. Fix `merchant_clean` normalization instead, and
re-evaluate the embedder only if a measurable gap survives that fix.**

The diagnosis is not "the threshold is wrong" and not "the model is bad". It is
that **`merchant_clean` is not clean**, so the embedder is being asked to do
semantic matching on strings whose dominant content is bank boilerplate. That
single defect produces both failure directions measured above:

- **Same merchant scores low.** `CONTACTLESS INTERAC PURCHASE - 0892 SHOPPERS
  DRUG M` scores 0.31-0.41 against every prior, because the card-network prefix is
  most of the string.
- **Different merchants score high.** `UBER TRIP ...HELP.UB` ~ `UBER EATS
  ...HELP.UB` at 0.796 and `WINGSTOPCANADA.OLO.COM TORONTO` ~ `SHEIN.COM TORONTO`
  at 0.704, because shared boilerplate dominates the vector.

And every one of the 10 trivial matches at t=0.85 is a `[CURRENCY amount @ rate]`
suffix. Strip that suffix, the `CONTACTLESS INTERAC PURCHASE - ####` prefix, and
trailing store numbers, and those rows become **exact** `merchant_clean` matches
that stage-5 merchant-memory already resolves — at `high` confidence, for free,
with no model, no 267 MB, and no `merchant_embeddings` table. Normalization also
strictly dominates on the cases the embedder gets *right*: `A & W`->`A&W`,
`Starbucks Coffee`->`STARBUCKS`, `LULULEMON`->`LULULEMON ATHLETICA B2C` are all
casefold/punctuation/prefix problems.

Concretely:

1. **Do not merge PR #1143** as a categorisation improvement. If
   `@huggingface/transformers` is wanted for another reason, that is a separate
   argument.
2. **Extend `merchant_clean` normalization** — strip trailing
   `[<CURRENCY> <amount> @ <rate>]`, leading `CONTACTLESS INTERAC PURCHASE - ####`
   / `POS PURCHASE` style prefixes, trailing 4-6 digit store numbers; casefold and
   collapse punctuation for the memory lookup key. Measure the cold-row reduction
   directly — it should exceed 12 rows by a wide margin at zero image cost.
3. **Separately, fix the Wealthsimple `merchant_clean`.** Storing
   `"Money transfer out of the account (executed at 2026-07-01)"` as a merchant is
   a data-modelling bug. It creates ~250 junk "merchants", and the inconsistent
   `Transfer`/`Investments` labels on identical strings are real label noise that
   will poison any future classifier, embedding or AI.
4. **If the stage is kept anyway** (e.g. behind a flag, off by default): set the
   threshold to **0.92**, not 0.85. It costs 1 row of payoff (12 -> 11), keeps
   every match in the `high` tier so they clear `review_flag` and genuinely skip
   the AI batch, and holds the `UBER TRIP` error at a 0.124 margin instead of
   0.054. Never below 0.85 — 0.80 and below buys the Uber miscategorisation for 3
   extra rows. And add `embedding` to `PRECEDENCE` so its ordering is deliberate.

Threshold 0.85 is not *unsafe* — the measured error rate is genuinely low. It is
simply not worth 267 MB to resolve 12 rows, 10 of which a regex resolves better.

## What would change my mind

- **Normalization lands and a real gap survives.** If, after stripping the
  boilerplate, there is still a meaningful population of cold rows that are
  semantically-but-not-lexically close to a categorised prior (my estimate from
  the 0.65-0.85 band is ~15-20 merchants, but that band also contains the Uber and
  Wingstop errors), the embedder earns a second look. This is the most likely
  route to reversal and the one worth actually testing.
- **A much larger reviewed corpus behaves better than the proxy.** My 965-merchant
  proxy includes the Wealthsimple junk, which may understate a clean 965. If
  `reviewed_at` coverage reaches a few thousand rows of *real* merchants and the
  purchase-row payoff at 0.92 exceeds ~150 rows, the calculus changes.
- **The image cost is wrong.** If `onnxruntime-node` can be pruned to tens of MB
  rather than 287 (WASM-only backend, no native binary), a 12-row payoff at 0.92
  with near-perfect precision is cheap enough to keep as a free pre-AI filter.
- **Multi-household deployment.** Every number here is one household (the only one
  in production, 5,409 rows). A household with messier merchants and a large
  reviewed history could invert the trivial/genuine ratio.
- **AI batch cost is materially higher than assumed.** If a cold row's AI call is
  expensive enough that eliminating 0.8% of them pays for the image, that is an
  economic argument this document does not price.

What would *not* change my mind: a better threshold. The curve is flat at
99.3-99.5% best-match precision from 0.70 to 0.95 — there is no threshold hiding a
better trade-off. The constraint is payoff, and payoff is capped by input quality.

---

## Reproduction

All scripts and raw data are in the session scratchpad:

```
<scratchpad>/embed.mjs           # embeds all 1,805 distinct merchant strings (q8 MiniLM)
<scratchpad>/validate.mjs        # reproduces the 3 briefed spot-check similarities
<scratchpad>/analyze.mjs         # all-pairs + best-match curves, per-category, FP lists
<scratchpad>/payoff_detail.mjs   # Part 2: every cold match, trivial/genuine classified
<scratchpad>/mktable.mjs         # emits the markdown curve table above
<scratchpad>/data/priors_reviewed.psv   # 149 stage-faithful priors  (support|category|merchant)
<scratchpad>/data/priors_labelled.psv   # 965 labelled merchants
<scratchpad>/data/cold_merchants.psv    # 862 cold merchants (rows_all|rows_purchase|merchant)
<scratchpad>/data/vectors.json          # 1,805 x 384 embeddings
<scratchpad>/data/results.txt           # full sweep output
<scratchpad>/data/payoff_detail.txt     # full Part 2 output
```

Scratchpad root for this session:
`/private/tmp/claude-501/-Users-connoradams-Developer-cashflow--claude-worktrees-vigilant-curran-ea56cf/6f4a481f-6cdd-4953-b167-334c32b48782/scratchpad`

The three `.psv` inputs come from read-only `SELECT`s against production
(household 1) via the `cashflow-prod-db` SSH path; the SQL is embedded in the
session transcript and reproduced by the queries quoted above. Nothing was
written to production. Embedding requires
`@huggingface/transformers@4.3.0`, present on branch `claude/install-embedder`
(PR #1143) — the scripts import it by absolute path from that worktree's
`node_modules`.

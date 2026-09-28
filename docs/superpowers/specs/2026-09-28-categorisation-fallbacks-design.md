# Turning the categorisation fallbacks on

**Date:** 2026-09-28
**Status:** design, approved

## The problem

47% of 2026 spend is uncategorised — 236 transactions, $64,221 — and the
largest band on the new Sankey is a label meaning "we don't know".

Cashflow has four categorisation mechanisms. Production `auto_source` counts
show which ever fire:

```
(none)          298   $107,496     nothing fired
rule            274    $47,447
memory          182     $15,179
composite       139      $6,753
transfer-link    97    $481,872
ws-investment    30     $23,144
item-link         4      $1,584
```

No `ai`. No `embedding`. **Neither intelligent fallback has categorised a
single transaction, ever.** What is left is 59 literal rules plus exact-name
memory, which is why `SHOPPERS DRUG MART` is uncategorised nineteen separate
times.

Each fallback is off along a different axis, and each was a defensible local
decision:

1. **The nightly backfill deliberately omits AI.** `runAi = flags.ai === true`
   and `enrichmentBackfillScheduler` never passes it, commented *"nightly cron
   stays deterministic (no recurring OpenAI cost); AI runs only on manual
   backfill."* So the job that processes 3,128 rows a night reports
   `aiEnhanced: 0` because it is not permitted to try.
2. **The embedding matcher has no model.** `@xenova/transformers` is an
   optional operator-installed peer and is `NOT_INSTALLED` in the backend
   container, so `getDefaultEmbedder` returns null and the stage emits nothing
   — silently, because *"an embedding failure must never fail an import."*
   `merchant_embeddings` has zero rows.
3. **The statement import path never calls the cold-row stages.**
   `commitStatementImport` calls `enrichTransaction` (normalize, rules, memory,
   type, relationships) but neither `maybeRunAiBatchOverColdRows` nor
   `maybeRunEmbeddingMatchOverColdRows`. Those run only from `runImport.ts`
   (folder CSV) and the backfill. Statements are the path actually used.
4. **AI runs only on a manual backfill**, which nothing in the UI triggers.

It is not a capability problem. `OPENAI_API_KEY` is set, `OPENAI_BASE_URL`
points at a local litellm proxy, and that proxy serves `gpt-4o-mini` — tested
end to end, HTTP 200. The model is sitting there working.

## What changes

**Let the nightly backfill use AI.** Pass `ai: true` from
`enrichmentBackfillScheduler`. The original reasoning — recurring OpenAI cost —
predates the self-hosted litellm proxy the calls now go through. Cost is capped
by `enrichmentAiMaxMerchants` (80 per run) and by merchant-dedupe, so the first
run is the expensive one and it tails off as memory fills.

**Install the embedder.** Add `@xenova/transformers` to the backend image so
`getDefaultEmbedder` returns a working model. This is the *free* tier and the
pipeline already runs it first, removing whatever it matches before the paid
batch sees the remainder — so it reduces AI spend rather than duplicating it.

Real cost, stated: the ONNX runtime is heavy and will add materially to image
size and build time. If that proves unacceptable, the fallback position is to
keep it out and accept that embedding-match never runs — but then delete the
stage rather than leave dead code that looks alive.

**Wire the cold-row stages into the statement import path.** Same two calls
`runImport.ts` already makes, using the same shared modules so behaviour cannot
fork between import routes. This is what makes categorisation happen at import
rather than overnight.

**Make silent unavailability visible.** The embedder returning null and the AI
stage being skipped are both currently invisible. Each should surface on the
import result the way other warnings do — an import that categorised nothing
because a fallback was unavailable must say so, not look like an import with
nothing to categorise.

## Ordering

Embedding runs before AI, and both run after rules and memory. That is already
the pipeline's design and must not change: free and deterministic first, paid
and probabilistic last, and each stage only sees what the previous could not
resolve.

## Known gap, not addressed

**82 uncategorised rows have `review_flag = false`.** Cold-row accumulation is
gated on `reviewFlag === true`, so those rows are invisible to every fallback,
permanently, no matter which of the above is fixed. Worth its own decision:
either they are genuinely settled and should not be uncategorised, or the gate
is wrong. Not resolved here.

## Also true, and larger than this

Roughly $40,000 of the "uncategorised spend" is not spend — line-of-credit
draws and loans to Stephen and Caelan, many already carrying a
`counterparty_role`, counted as uncategorised *spending* because the spend
query ignores that column. No categoriser can fix that; the query has to stop
asking.

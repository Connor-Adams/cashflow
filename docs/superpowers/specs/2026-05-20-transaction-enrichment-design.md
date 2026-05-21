# Transaction Enrichment Pipeline — Design

**Date:** 2026-05-20
**Status:** Approved (pending spec review)
**Driver:** Manual review burden — Review Inbox volume is too high because every imported row lands with `review_flag=true` regardless of how confidently it was auto-categorised.

## Goal

Replace the current ad-hoc rule + memory branching in `runImport.ts` with an explicit enrichment pipeline. Maximise the share of imported rows that arrive with confident, correct auto-fields, so only genuinely ambiguous rows reach Review Inbox.

## Non-goals (deferred to later specs)

- Merchant Category Codes (MCC) / industry codes (needs external data).
- Location / geo extraction from raw memo (low ROI for the review-burden goal).
- FX details — original currency, FX rate, foreign-transaction fees.
- Tax category mapping (Schedule C and similar).
- Freeform tags / labels.
- Receipt line-item extraction (`receiptVision` prompt expansion is its own spec).

## Current state (what already exists)

- `backend/src/import/normalizeMerchant.ts` — `String#trim` + whitespace collapse only. No real cleaning.
- `backend/src/import/applyRules.ts` — substring/regex match against `merchantClean`; ambiguity returns no match.
- `backend/src/ai/merchantMemory.ts` — exact-lowercase merchant-clean lookup for prior reviewed decisions; queried at import as fallback to rules.
- `backend/src/import/runImport.ts:251-298` — calls rule → memory → defaults; **always** sets `reviewFlag = true` (line 267) regardless of whether auto-fields were produced.
- `backend/src/ai/suggestTransaction.ts` — `suggestTransactionFieldsTracked` produces `{ category, business, splitType, pctMe, pctPartner, notes, confidence, evidence, needsReview }` from rich context (rules, memory, similar transactions, receipts). Not wired into the import path.
- `backend/src/import/mapRow.ts:37-77` — already detects refund / return / reversal / transfer / payment / deposit patterns in narratives, but only uses the result for amount sign.
- Amazon items: `ExternalOrder` + `ExternalOrderItem` (with `inferredCategory`, `businessUsePercent`, `confidence`) + `TransactionOrderLink`; `amazon/matcher.ts:runAmazonMatching` runs out-of-band, not at import time.
- `backend/src/ai/auditTransactions.ts`, `insights.ts`, `ruleProposals.ts` exist but operate on historical data, not import time.

The infrastructure for confident auto-fill exists — what's missing is the orchestration and a review-flag rule that actually trusts the signals.

## Architecture: enrichment pipeline

Single module `backend/src/import/enrich.ts` exposing one public function:

```ts
export async function enrichTransaction(
  raw: MappedRowValue,
  ctx: EnrichmentContext,
): Promise<EnrichmentResult>;
```

`runImport.ts` builds a per-import `EnrichmentContext` once, then calls `enrichTransaction` per row. The current 50-line rule/memory branching in `runImport.ts:250-298` collapses to a single call followed by `Transaction.build({...result.fields})`.

### Stages (ordered)

| # | Stage | Inputs | Outputs (Signal fields) | Notes |
|---|---|---|---|---|
| 1 | `normalize-merchant` | `merchantRaw` | `merchantClean`, `merchantCanonical` | Real normalisation: strips processor prefixes (`SQ *`, `TST*`, `PAYPAL *`, `AMZN MKTP US*`, `STRIPE*`, `GOOGLE *`), trailing store/transit numbers (`#1234`, `STORE 5678`), city/state/phone tails, case-normalised, whitespace-collapsed. `merchantCanonical` populated only when a known brand dictionary matches. |
| 2 | `detect-type` | `merchantRaw`, narrative, sign | `txnType` | Reuses the credit/debit narrative patterns already in `mapRow.ts` plus sign of amount. Output: `purchase` \| `refund` \| `transfer` \| `payment` \| `fee` \| `interest` \| `reward` \| `unknown`. |
| 3 | `detect-recurring` | `merchantClean`, amount, history | `is_recurring`, `auto_category` (if confident) | If history shows ≥3 prior transactions with same `merchantClean` + amount within ±5% + monthly cadence (±5 days), mark recurring and propose the modal prior category at high confidence. |
| 4 | `apply-rule` | `merchantClean`, rules cache | auto-fields, `appliedRuleId` | Existing `findBestRule` against the improved `merchantClean`. High confidence on unambiguous match. |
| 5 | `merchant-memory` | `merchantClean`, household | auto-fields, support count | Existing `findMerchantMemory`. High confidence when `supportCount ≥ 2`; medium otherwise. |
| 6 | `link-items` | `merchantClean`, in-flight batch + DB | `linkedExternalOrderId`, item-derived category | If `isAmazonLikeMerchant`, run `scoreAmazonOrderMatch` against pending Amazon orders. If match confidence ≥70, attach the link. Derive category signal from `ExternalOrderItem.inferredCategory`: if all items share a single category, propose at high confidence; otherwise propose the category of the item with the highest `totalPrice` at medium confidence. If any item has `businessUsePercent > 0`, propose `autoBusiness=true`. Item titles (up to 5) appended to `notes`, truncated to 200 chars. Extensible later to receipt items via the same signal shape. |
| 7 | `detect-relationships` | `txnType`, amount, sign, window | `linked_transaction_id`, inherited category | **Refund-link:** if `txnType=refund` (or opposite sign + same merchant within 60 days), link to original and inherit its `final_category` / `final_business` at high confidence. **Transfer-link:** for `txnType=transfer` or opposite-sign-matching-amount across owned accounts within ±2 days, link siblings and set `auto_category="Transfer"` at high confidence. Considers both in-flight batch (date-ordered) and DB. |
| 8 | `ai-batch` | cold rows (no high-confidence signal yet) | per-merchant category/business/split | Collects all cold rows in the import, groups by `merchantCanonical \|\| merchantClean`. Single OpenAI call sends `[{key, sampleAmount, sampleDate, similarTxns, memory}]`; response maps key → suggestion with confidence. High-confidence results auto-applied. Cap: `ENRICHMENT_AI_MAX_MERCHANTS_PER_IMPORT` (default 80) — excess merchants stay in review. |
| 9 | `compute-review-flag` | all signals | `auto_source`, `auto_confidence`, `review_flag` | `review_flag = false` iff merged result includes `auto_category` AND merged `auto_confidence === 'high'`. Otherwise `true`. |

### Signal type

```ts
export type Confidence = 'high' | 'medium' | 'low';

export type SignalSource =
  | 'normalize' | 'type-detect' | 'recurring'
  | 'rule' | 'memory' | 'amazon-items'
  | 'refund-link' | 'transfer-link' | 'ai';

export interface Signal {
  source: SignalSource;
  confidence: Confidence;
  fields: Partial<{
    merchantClean: string;
    merchantCanonical: string | null;
    txnType: TxnType;
    autoCategory: string | null;
    autoBusiness: boolean | null;
    autoSplitType: string | null;
    autoPctMe: string | null;
    autoPctPartner: string | null;
    appliedRuleId: number | null;
    linkedTransactionId: number | null;
    linkedExternalOrderId: number | null;
    isRecurring: boolean;
    notes: string | null;
  }>;
  rationale?: string;
}
```

Stages may emit 0 or more signals. `enrichTransaction` returns the merged result plus the raw `signals[]` for transparency.

### Conflict resolution (explicit precedence)

When multiple stages produce values for the same field, the winner is chosen by source precedence (higher wins):

```
rule  >  recurring(high)  >  memory(supportCount≥2)
      >  refund-link / transfer-link
      >  amazon-items(high)  >  ai(high)
      >  memory(supportCount=1)  >  amazon-items(medium)  >  ai(medium)
      >  ai(low)
```

Ties broken in source-list order above (deterministic > AI). All signals retained in `enrichment_signals` for Review Inbox display. `auto_source` records the winning source; if multiple sources contributed to different winning fields, `auto_source='composite'`.

### Failure isolation

- **AI batch failure** (network, rate-limit, JSON parse): caught at pipeline boundary. Pipeline falls back to per-row AI calls with a small concurrency limit (default 4). If per-row also fails for a given row, that row simply has no AI signal — earlier-stage signals stand. Logged via `observability` with batch/row IDs.
- **Amazon matcher failure**: caught, row continues without `link-items` signal.
- **Any other stage failure**: caught, logged, row continues. Pipeline failure must never block an import.

### Per-import context

```ts
export interface EnrichmentContext {
  account: Account;
  householdId: number | null;
  rulesCache: RuleRow[];                   // pre-loaded once
  amazonOrdersCache: ExternalOrder[];      // pre-loaded once per import
  inFlightBatch: PendingTxn[];             // rows queued earlier in this import
  aiEnabled: boolean;                      // env flag
  aiMaxMerchants: number;                  // cap for ai-batch
}
```

Caches eliminate per-row queries. `inFlightBatch` lets refund-link / transfer-link / amazon-items match against not-yet-saved siblings in the same import.

## Data model changes

Single migration: `20260520000002-transaction-enrichment.js`.

Added columns on `transactions`:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `merchant_canonical` | `TEXT NULL` | — | Brand identity ("Amazon", "Netflix") when normaliser recognises it. |
| `txn_type` | `TEXT NOT NULL` | `'purchase'` | `purchase` / `refund` / `transfer` / `payment` / `fee` / `interest` / `reward` / `unknown`. |
| `auto_source` | `TEXT NULL` | — | Winning signal source. |
| `auto_confidence` | `TEXT NULL` | — | `high` / `medium` / `low`. |
| `linked_transaction_id` | `INTEGER NULL` | — | FK self; refund→original, transfer→sibling. Indexed. |
| `is_recurring` | `BOOLEAN NOT NULL` | `false` | From `detect-recurring`. |
| `enrichment_signals` | `JSON NULL` | — | Full `Signal[]` for transparency / debugging / Review Inbox display. |

`Transaction` model in `backend/src/models/Transaction.ts` extended with the seven new declared fields and init definitions. Migrations runtime-tested both forward and rollback.

## Call site changes

`backend/src/import/runImport.ts`:

- Load `rulesCache` and `amazonOrdersCache` once (currently rules already loaded once; orders cache is new).
- Replace lines 250-298 with a single `await enrichTransaction(v, ctx)` plus a spread of `result.fields` into `Transaction.build`.
- `inFlightBatch` accumulated as rows are saved (or even pre-save for relationship linking).
- After the loop: ai-batch runs once over the deferred cold rows, then their pre-built `Transaction` instances are updated and saved.

This means import is now a two-phase loop:

1. **Phase 1 (per-row, no AI):** rows processed in **ascending date order** (so refund-link / transfer-link in stage 7 sees originals before refunds). Stages 1–7 run per row. Rows with high-confidence signals after stage 9 are saved immediately. Cold rows accumulate in a deferred list with their partial `EnrichmentResult` and a built-but-unsaved `Transaction`. Both already-saved siblings and deferred cold siblings live in `inFlightBatch` so later-row stage 7 can link to either.
2. **Phase 2 (batch):** stage 8 fires one OpenAI call over all deferred merchants. Results merged into each deferred result, then stage 9 (review-flag) re-runs for those rows, then the deferred rows save.

If the import has zero cold rows, phase 2 is skipped entirely. If AI is disabled (`OPENAI_API_KEY` missing or `ENRICHMENT_AI_ENABLED=false`), phase 2 is skipped and cold rows save with `review_flag=true`.

Note: `enrichment_signals` is stored per row as JSON. For typical imports this is a handful of small objects; no perf concern at expected scale. If a future use case wants to query across signals, migrating to a normalised `transaction_signals` table is straightforward.

## New endpoint

`POST /api/transactions/:id/enrich` — runs the full pipeline against an existing row.

- Re-derives `merchant_clean`, `merchant_canonical`, `txn_type`, `is_recurring`, `linked_transaction_id`, `auto_*`, `enrichment_signals`.
- **Never touches** `*_override` columns or `final_*` fields directly — those are owned by user edits and `recomputeTransactionAmounts`.
- Re-computes `review_flag` from new confidence.
- Rate-limited under the same middleware as other AI endpoints.

## Backfill script

`backend/scripts/backfillEnrichment.ts`:

- Iterates every transaction (filterable by `--account-id`, `--household-id`, `--review-only`).
- For each: build a `MappedRowValue`-equivalent from existing columns, run `enrichTransaction`, write back the enrichment fields.
- **Override safety:** if any `*_override` is non-null, the corresponding `auto_*` is still updated, but `final_*` recompute respects the override (existing behaviour of `recomputeTransactionAmounts`).
- **AI safety:** backfill defaults to `--no-ai` to avoid surprise spend; `--with-ai` opts in.
- Idempotent — re-running yields the same result for the same DB state.
- Progress logged every 100 rows.

## Configuration

New env vars (all optional, sensible defaults):

| Var | Default | Purpose |
|---|---|---|
| `ENRICHMENT_AI_ENABLED` | `true` if `OPENAI_API_KEY` set | Master switch for stage 8. |
| `ENRICHMENT_AI_MAX_MERCHANTS_PER_IMPORT` | `80` | Cold-merchant cap for batched AI call. |
| `ENRICHMENT_AI_PER_ROW_CONCURRENCY` | `4` | Used for per-row fallback when batch fails. |
| `ENRICHMENT_AMAZON_LINK_THRESHOLD` | `70` | Min `scoreAmazonOrderMatch` confidence for stage 6 to attach. |
| `ENRICHMENT_RECURRING_MIN_SUPPORT` | `3` | Min prior occurrences for `detect-recurring`. |
| `ENRICHMENT_REFUND_WINDOW_DAYS` | `60` | Refund-link search window. |
| `ENRICHMENT_TRANSFER_WINDOW_DAYS` | `2` | Transfer-link search window. |

## UI surfacing (Review Inbox)

Review Inbox row component reads `enrichment_signals` and displays a compact "Why" tooltip: source + confidence + rationale per signal. No new endpoints needed — the data ships with the existing transaction GET.

Add a small "Recently auto-applied" view (filter `review_flag=false AND reviewed_at IS NULL AND auto_source IS NOT NULL`) so spot-checking high-confidence auto-applies is one click away. Future improvement; not required for first ship.

## Testing strategy

Unit tests per stage:

- `normalize-merchant`: golden fixtures from real bank/card statements covering Amex, Chase, Capital One, Square, Stripe, PayPal, Amazon variants. Each fixture maps a raw memo to expected `merchantClean` + `merchantCanonical`.
- `detect-type`: table-driven from `mapRow.ts` patterns plus sign combinations.
- `detect-recurring`: synthetic histories asserting cadence + amount tolerance behaviour.
- `apply-rule`: existing tests stand; add cases that fail today but pass after improved `merchantClean`.
- `merchant-memory`: existing tests stand; add support-count→confidence cases.
- `link-items`: fixture orders + transactions; assert link + item-derived signal.
- `detect-relationships`: in-flight batch cases (refund and original in same import); cross-account transfer pairs.
- `ai-batch`: mock OpenAI; assert batch payload shape, response parsing, cap enforcement, per-row fallback on batch failure.
- `compute-review-flag`: precedence ladder table-driven.

Integration tests:

- Full pipeline against a small CSV with mixed deterministic and cold rows.
- Backfill script: idempotency + override safety.
- New `POST /api/transactions/:id/enrich` route: auth, rate-limit, override safety.

Existing tests in `backend/test/` that assert `review_flag=true` after import will need updates to match the new confidence-driven behaviour.

## Rollout order

The spec is one cohesive design, but implementation can be staged. Suggested order for the implementation plan (writing-plans will refine):

1. Migration + Transaction model fields + Signal/EnrichmentResult types (no behaviour change yet).
2. Stages 1–2 (`normalize-merchant`, `detect-type`) + pipeline skeleton + `compute-review-flag` wired through.
3. Stages 4–5 refactor (`apply-rule`, `merchant-memory`) into pipeline form — existing behaviour preserved.
4. Stage 9 + new precedence — flip the `reviewFlag = true` hardcode to confidence-driven.
5. Stage 3 (`detect-recurring`).
6. Stage 6 (`link-items`) — pulls Amazon matching into the import path.
7. Stage 7 (`detect-relationships`).
8. Stage 8 (`ai-batch`) with per-row fallback.
9. `POST /api/transactions/:id/enrich` route.
10. Backfill script.
11. Review Inbox surfacing of `enrichment_signals`.

## Open questions for spec review

- Is `enrichment_signals` as a JSON column acceptable, or do we want a normalised `transaction_signals` table for future querying? (Default: JSON column; cheap to migrate later if needed.)
- Should `auto_confidence='high'` from `ai` alone (no deterministic signal at all) be enough to skip review? Current design: yes. Alternative: require at least medium-confidence corroboration from any non-AI source for cold rows.
- `merchantCanonical` brand dictionary — start with a hardcoded list of common brands (Amazon, Netflix, Spotify, Uber, Lyft, Apple, Google, etc.) or derive from `merchant_memory` modal cleaned merchants?

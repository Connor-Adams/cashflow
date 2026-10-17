# Smarter AI integration — design

Date: 2026-09-08
Status: proposed

## Problem

Three user-facing AI surfaces underperform: the CFO briefing reads as a to-do
tally, the insights page shows stale noise, and transaction categorization needs
manual correction too often.

Investigation found that none of these is a prompt-quality problem. Each has a
distinct structural cause.

### Cause 1 — insight detectors have not run since May

`backend/src/insights/` is a real detector framework: `runDetectorsForHousehold`
plus eight detectors in `detectors/index.ts` (duplicate transactions, merchant
spend spike, recurring increase, missing receipt, unusual category spend, cash
runway low, category trend, settlement imbalance). It persists `Insight` rows
with fingerprint dedup and an open/dismissed/resolved lifecycle, and
`InsightsPage` renders it via `GET /api/insights`.

Its only caller is `POST /api/insights/run` — the manual button in the UI.

Production, queried 2026-09-08:

| type | status | rows | newest `detected_at` |
|---|---|---:|---|
| `missing_receipt` | open | 140 | 2026-05-26 |
| `subscription_price_increase` | open | 11 | 2026-09-08 |
| `merchant_spend_spike` | open | 2 | 2026-05-26 |
| (dismissed money-leak types) | dismissed | 5 | 2026-06-01 |

The generic detectors ran once, on 2026-05-26. 88% of the page is a single
stale receipt-nag type. `subscription_price_increase` stays fresh only because
it is a registered job (`jobs/definitions/detectSubscriptionPriceChanges.ts`,
02:00 UTC daily).

`backend/src/jobs/` is a complete scheduler — `defineJob`, registry, runner,
Postgres advisory locks, per-job cron/enabled env overrides — with fifteen jobs
registered. The detector run simply is not one of them.

### Cause 2 — two forked insight engines, and the briefing consumes the wrong one

`backend/src/ai/insights.ts` (`buildFinancialInsights`, 397 lines) is a second,
unrelated insight path. It contains no LLM call and no detector logic. It emits
six hardcoded titles every period with new numbers:

- `Top category: X`
- `X is up`
- `Uncategorized spend is blocking clean reports`
- `Top merchant: X`
- `Uncategorized transactions`
- `Business and shared spend split`

Its consumers are `cfo/briefingBuilder.ts:237`, `ai/reviewRunner.ts:106`, and
`routes/ai.ts:298` — so the CFO briefing and the AI review both draw their
"anomalies" from the six templates and never see the eight real detectors.

`GET /api/ai/insights` additionally *persists* its output: it supersedes the
prior `AiSuggestion` row for the same period and currency, then writes a new one
with `kind = 'financial_insight'` and `model = 'deterministic'`
(`routes/ai.ts:305–334`). Those rows drive the Unified Inbox — `/inbox/count`
counts them at `routes/ai.ts:611`, and `useAiInboxCount.ts` renders the badge.
Generation happens only when something calls the endpoint; it is not scheduled.

So there are three insight surfaces over two engines:

| Surface | Source | Freshness |
|---|---|---|
| InsightsPage | `Insight` rows, real detectors | stale since 2026-05-26 |
| Unified Inbox | `AiSuggestion` `kind='financial_insight'`, six templates | regenerated on endpoint hit |
| CFO briefing / AI review | `buildFinancialInsights` in-process, six templates | per request |

Per the primitives spine in `CLAUDE.md`, this is a fork of the **Observation**
primitive: two objects with the same status machine under different names. The
rule is to fold, not to maintain both.

### Cause 3 — the briefing has no synthesis step

`cfo/briefingBuilder.ts` states in its own header that it is deterministic and
invokes no model. It fans out to eight sub-sources and concatenates their items
into a flat list. Its `summary` is `briefingShortSummary(counts)`, a pure
formatter producing e.g. `"12 action items: 3 missing receipts, 2 anomalies,
1 import issue."`

Nothing ranks the items, connects them, or explains why any of them matters.

### Cause 4 — the categorization feedback loop is write-only

`suggestionStore.ts:93` scores every suggestion against what the user actually
chose, persisting `AiSuggestion.status = 'accepted' | 'edited'` alongside
per-field mismatch metrics in `finalSnapshot.metrics`. That is a labeled record
of what the model gets wrong, per merchant.

Every read site is display-only: the accept-rate tally in `routes/ai.ts`, the
review inbox in `routes/reviewItems.ts`, and explanation attribution in
`routes/transactions.ts`. `buildTransactionSuggestionContext` assembles rules,
merchant memory, ten similar reviewed transactions, and receipt extracts — but
never past corrections.

Separately, `suggestTransactionFields` (the untracked variant,
`suggestTransaction.ts:290`) sends a materially poorer prompt than
`suggestTransactionFieldsTracked`: no merchant memory, no similar transactions,
no matching rule, no receipt extracts. It is still imported by
`routes/transactions.ts:21`.

## Non-goals

- **Multi-provider routing.** Considered and dropped. Model selection stays a
  config value; introducing a provider abstraction does not make the app
  smarter and none of the four causes above is a provider problem.
- **New detectors.** Eight exist and do not run. Adding more before scheduling
  the existing ones would compound the problem.
- **Chat improvements.** The chat surface is out of scope for this spec.

## Design

Four changes, ordered so each is independently shippable and independently
verifiable.

### Part 1 — schedule the detectors

Add `backend/src/jobs/definitions/runInsightDetectors.ts` following the
`detectSubscriptionPriceChanges` shape:

```ts
defineJob({
  name: 'run_insight_detectors',
  cronDefault: env.insightDetectorsCron,
  enabledDefault: env.insightDetectorsEnabled,
  handler: async () => { /* iterate households, run detectors */ },
});
```

Unlike `detectSubscriptionPriceChanges`, which is global,
`runDetectorsForHousehold` is per-household, so the handler iterates households
and aggregates per-household results into the job summary. A failure for one
household is logged and does not abort the others.

Add `insightDetectorsCron` and `insightDetectorsEnabled` to `config/env.ts`
following the existing per-job pattern, and import the definition in
`server.ts`.

Fingerprint dedup already prevents duplicate rows across runs, so a daily
cadence is safe without further guarding.

**Verification:** job appears in the registry; a manual run produces `Insight`
rows with today's `detected_at`; a second run in the same day creates no
duplicates.

### Part 2 — fold the forked insight engine

Point the briefing and the AI review at the real detectors.

`buildCfoBriefing` currently calls `buildFinancialInsights` for its `anomaly`
items. Replace that with a query over open `Insight` rows for the household,
mapped into `CfoBriefingActionItem` — the two shapes already correspond
(`severity`, `title`, `description`, `entityType`/`entityId`, `status`).

`Insight.severity` is `info | warning | critical`; `CfoBriefingActionItemSeverity`
is `info | watch | action`. Map `warning → watch`, `critical → action`.

Do the same for `ai/reviewRunner.ts:106`.

The Unified Inbox needs handling before anything can be deleted, since its
`financial_insight` slot is fed by `AiSuggestion` rows that only
`GET /api/ai/insights` writes. Repoint that slot at open `Insight` rows for the
household rather than dropping it: the inbox stays useful, and the count then
reflects detector output instead of a template regenerated on page load.

This also fixes a live inconsistency — an insight dismissed on InsightsPage
currently has no effect on the inbox badge, because the two read different
tables.

With all three surfaces repointed, delete `buildFinancialInsights` and
`backend/src/ai/insights.ts`, retire `GET /api/ai/insights`, and stop writing
`kind = 'financial_insight'` rows. Existing rows of that kind are left in place;
they are historical records, and `AiSuggestion.kind` keeps the value in its
union so old rows still load.

Note that `missing_receipt` exists both as a detector type and as a briefing
sub-source computed inline in `briefingBuilder.ts`. After the fold, the briefing
takes it from `Insight` rows only, so a receipt nag dismissed on the insights
page stops reappearing in the briefing.

**Verification:** a briefing generated after a detector run contains action
items sourced from real detector types; dismissing an insight removes it from
both the next briefing and the inbox badge; `ai/insights.ts` is deleted with no
remaining imports; `UnifiedInboxPage` tests pass against the repointed source.

### Part 3 — briefing synthesis pass

Keep the deterministic fan-out. Add an LLM pass over its output that produces a
narrative summary and a ranking, following the pattern already working in
`routes/reports.ts:314` (`maybeBuildAiSummary`): deterministic findings in,
strict JSON out, graceful degradation to the existing behaviour when the model
is unconfigured or fails.

Input: the assembled `CfoBriefingActionItem[]` plus the safe-to-spend snapshot.
Output:

```json
{
  "summary": "...",
  "ranking": [{ "id": "...", "rank": 1, "why": "..." }]
}
```

Constraints in the system prompt: refer only to figures present in the input;
never introduce an item id not in the input; order by what a household would
act on first.

The model may explain and order. It may not invent a number or an item. Any
`ranking` entry whose `id` is absent from the input is dropped at parse time,
and items the model omits keep their existing order after the ranked ones.

`CfoBriefing` already has `summary`, `model`, and `promptVersion` columns, so
this needs no migration. `briefingShortSummary(counts)` becomes the fallback
rather than the only path. Bump `CFO_BRIEFING_PROMPT_VERSION` to
`cfo-briefing-v2`.

**Verification:** with no API key, the briefing is byte-identical to today's;
with a key, `summary` is prose and `actionItems` are reordered; a stubbed model
response containing an unknown id or a fabricated figure is rejected by the
parser, not persisted.

### Part 4 — feed corrections back into categorization

Extend `buildTransactionSuggestionContext` with a `pastCorrections` field:
`AiSuggestion` rows for this household where `kind = 'transaction_fields'` and
`status = 'edited'`, restricted to the same normalized merchant key (reusing
`merchantMemory`'s `normalizeMerchantKey`), most recent first, capped at five.

Each correction contributes what was suggested, what the user chose, and which
fields mismatched — `finalSnapshot.metrics` already carries the per-field
booleans.

These enter the prompt as explicit negatives: *"On this merchant you previously
suggested X; the user corrected it to Y."* When no corrections exist for the
merchant, the field is an empty array and the prompt section is omitted rather
than rendered empty.

Bump `TRANSACTION_SUGGESTION_PROMPT_VERSION` to `transaction-fields-v3` so
`scripts/ai-eval.ts`'s per-prompt-version accept-rate breakdown separates the
before and after populations.

Delete `suggestTransactionFields` and repoint `routes/transactions.ts` at the
tracked variant, so every suggestion gets the full context and every suggestion
is scored.

**Verification:** `ai-eval.ts` reports a separate bucket for
`transaction-fields-v3`; a unit test asserts that a merchant with a prior edited
suggestion produces a prompt containing the correction, and that a merchant
without one produces a prompt with no corrections section.

## Testing

Backend unit tests are colocated (`foo.test.ts` beside `foo.ts`) and run under
`node:test` via `tsx`.

- **Part 1:** job definition registers with the expected name; the handler
  iterates households and survives a per-household failure. Existing
  `runInsightDetectors.test.ts` and `upsertInsight.test.ts` cover the detector
  run itself.
- **Part 2:** severity mapping is total over `info | warning | critical`;
  briefing items derive from `Insight` rows; dismissed insights are excluded.
  `cfoBriefingBuilder.test.ts` already covers the pure formatter and stays green
  because the fallback path is unchanged.
- **Part 3:** parser drops unknown ids; omitted items retain order; a thrown
  model call degrades to `briefingShortSummary`. Model calls are stubbed — no
  network in unit tests.
- **Part 4:** prompt-shape assertions with and without corrections; the
  correction query filters by household, kind, status, and merchant key.

Integration tests touching Postgres stay in `backend/test/integration/`.

## Sequencing

Parts 1 and 2 land together — scheduling the detectors without folding the fork
leaves the briefing still reading the six templates, and folding without
scheduling points the briefing at a stale table.

Part 3 depends on Part 2, since it synthesizes over the folded item list.

Part 4 is independent of all three and can land in either order.

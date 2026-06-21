# Smarter Email Search — Receipt Source Discovery

**Date:** 2026-06-18
**Status:** Approved (Phase 1 scoped; Phases 2–3 documented as fast-follows)
**Primitive impact:** None. `ReceiptSenderAllowlist` gains a status discriminator — extend, not a new primitive. Not a spine change.

## Problem

Cashflow's "email search" is a Gmail receipt auto-scraper, not a search tool. Discovery
is gated entirely by `buildGmailQuery()` in `backend/src/integrations/scanReceipts.ts`,
which builds `from:(<allowlist>) after:<date>`. The allowlist (hardcoded
`DEFAULT_RECEIPT_SENDERS` + household custom rows) is high-precision but narrow: any
receipt whose sender is not on the list is **never seen**. Real receipts — unknown
shops, SaaS invoices, one-off vendors, forwarded receipts — are silently missed.

Goal: widen discovery to catch receipts the allowlist misses, **without** flooding the
system with junk `ExternalOrder` rows or burning AI extraction on non-receipts.

## Approach

A separate **discovery pass** beside the existing fast allowlist scan. It casts a wide
net using Gmail's own purchase signals, evaluates each candidate, and splits results by
confidence:

- **High confidence → auto-ingest** (create `ExternalOrder`, auto-learn the sender).
- **Low confidence → suggest** (cluster by sender; user approves/dismisses; no order row).

The fast allowlist scan (`scanInbox`) is untouched and stays cheap. Discovery is an
opt-in action because the broad query returns far more messages.

### Trust model: hybrid by confidence

| Tier | Condition | Action |
|---|---|---|
| **HIGH** | Deterministic parser hit (amazon/apple/uber/interac) by content, any sender; **OR** `category:purchases` + clean structured extract (total + ≥1 item) + extracted amount matches an existing `Transaction` | Create `ExternalOrder` + `ExternalOrderItem`; auto-learn sender as `status=enabled, source=discovery`; auto-link to transactions via existing `matchReceiptOrderToTransactions()` |
| **LOW** | AI-only extract, not purchase-categorized, or no transaction amount match | **No order row.** Upsert a `suggested` sender row (increment `candidate_count`, refresh `sample_subject`/`last_seen_at`) |

A low-confidence AI extract is **not discarded** — the receipt's sender surfaces as a
suggestion, so a real receipt for a cash/uncleared transaction (no amount match) is
recovered the moment the user approves its sender and a normal scan runs.

## Components

### 1. Broad query builder — `buildDiscoveryQuery()`

New function in `backend/src/integrations/gmail.ts` (beside `buildGmailQuery`). Signals
OR together; known senders are excluded so discovery only surfaces *new* sources:

```
( category:purchases
  OR subject:(receipt OR invoice OR "order confirmation"
              OR "your order" OR "payment received" OR "tax invoice")
  OR (has:attachment filename:pdf subject:(invoice OR receipt))   ← Phase 2
)
-from:( <enabled allowlist senders> OR <dismissed senders> )
after:<sinceDate>
```

- **Phase 1** ships the `category:purchases` and `subject:` keyword clauses.
- The `has:attachment filename:pdf` clause is gated behind Phase 2 (it requires the PDF
  parse path); Phase 1 emits the query without it.
- Senders excluded: every `enabled` allowlist row (already covered by the fast scan) and
  every `dismissed` row (user said no). `suggested` rows are NOT excluded — re-seeing
  them bumps their candidate count.
- `DEFAULT_RECEIPT_SENDERS` are also excluded (they're effectively always-enabled).

### 2. Discovery orchestrator — `discoverReceiptSources()`

New module `backend/src/integrations/discoverReceiptSources.ts`. Reuses `scanReceipts.ts`
internals rather than duplicating: message listing (`listMessageIds`), body extraction,
the deterministic parsers, subject filter, AI extraction, dedupe-key construction, and
`matchReceiptOrderToTransactions()`. Per broad-matched message:

1. Skip if `ProcessedEmailMessage` already has this `messageId`.
2. Subject filter (`classifySubject`) — reject obvious non-receipts.
3. Parse attempt: deterministic parsers first, AI fallback (same order as `scanInbox`).
4. Classify confidence (table above). The `category:purchases` membership is read from
   the message's `labelIds` (Gmail `messages.get` returns `CATEGORY_PURCHASES` when
   applicable) — `fetchMessage` must surface `labelIds`. The "amount matches an existing
   `Transaction`" signal reuses `matchReceiptOrderToTransactions()`: a non-empty match
   set = matched.
5. **HIGH** → write `ExternalOrder`(+items), auto-learn sender, auto-link; record
   `ProcessedEmailMessage` with new status `auto_learned`.
6. **LOW** → upsert `suggested` sender row; record `ProcessedEmailMessage` with new
   status `suggested_sender`.
7. Stream a per-message NDJSON event (same shape the scan stream already uses).

Signature mirrors `scanInbox`: `discoverReceiptSources({ userId, householdId, maxMessages, sinceDateOverride }, callbacks)`. `maxMessages` default **300**, capped (e.g. 1000).

### 3. Suggestions store — extend `ReceiptSenderAllowlist`

Fold suggestions into the existing model (no new table). New columns:

| Column | Type | Default | Notes |
|---|---|---|---|
| `status` | enum-as-string (`enabled` \| `suggested` \| `dismissed`) | `enabled` | Richer than `enabled`; see invariant below |
| `source` | enum-as-string (`user` \| `discovery`) | `user` | Provenance |
| `sample_subject` | string(256) nullable | `null` | A representative subject for the UI |
| `candidate_count` | integer | `0` | How many broad hits clustered to this sender |
| `last_seen_at` | datetime nullable | `null` | Most recent candidate sighting |

**Invariant:** the existing fast scan filters on `enabled = true`. Keep `enabled` and
write it consistently with `status`: `enabled = (status === 'enabled')`. `suggested` and
`dismissed` rows therefore have `enabled = false` and are automatically ignored by the
existing scan path — no change needed there.

Migration: JavaScript Sequelize CLI migration `backend/src/migrations/YYYYMMDD-...-receipt-sender-allowlist-discovery.js`, dual-dialect (SQLite + Postgres), backfilling
existing rows to `status='enabled', source='user'`.

### 4. Routes — `backend/src/routes/emailIntegrations.ts`

- `POST /api/email/discover/google?stream=1` — run the discovery pass; streams NDJSON
  (`started` / `phase` / `message` / `summary` / `error`), same contract as
  `/api/email/scan/google`.
- `GET /api/email/suggestions` — list `suggested` rows (sender, label guess,
  `candidate_count`, `sample_subject`, `last_seen_at`), ordered by `candidate_count` desc.
- `POST /api/email/suggestions/:id/approve` — promote to `enabled` (`source` stays
  `discovery`); optional `?scan=1` immediately backfills that one sender via the existing
  scan path.
- `POST /api/email/suggestions/:id/dismiss` — set `status='dismissed'`; thereafter
  excluded from the discovery query and never re-suggested.

These are explicit rather than folded into the allowlist routes so the suggestion
lifecycle is legible. Mount under the existing authed `/api/email` boundary.

### 5. Frontend — `GmailSection.tsx`

- **"Discover new receipt sources"** button → `POST /api/email/discover/google?stream=1`,
  reusing the existing NDJSON streaming-results renderer.
- **Suggestions list**: one row per suggested sender — guessed label, sender address,
  "N emails", sample subject; **Approve** (→ enabled, optional immediate backfill) and
  **Dismiss** buttons. Auto-ingested HIGH results already appear in the normal scan
  history (`GmailScanHistory`), no new surface needed for them.

## Cost & correctness guards

- `ProcessedEmailMessage.messageId` dedupe prevents re-evaluating a message across runs
  (discovery writes rows with the new statuses, so a message evaluated once is skipped
  next pass).
- `-from:(enabled + dismissed)` keeps discovery from re-chewing mail the fast scan or the
  user already handled.
- Per-run `maxMessages` cap (default 300) bounds AI spend per discovery run.
- Discovery is opt-in (separate button), so the broad query's cost is never paid by the
  routine fast scan.

## Testing

**Unit (SQLite, colocated `*.test.ts`):**
- `buildDiscoveryQuery` — exact query string for each signal combination; correct
  exclusion of enabled + dismissed senders; `after:` formatting.
- Confidence classifier — deterministic hit → HIGH; AI + amount match → HIGH; AI no
  match → LOW; non-purchase AI → LOW.
- Suggestion upsert/cluster — second sighting of a sender increments `candidate_count`
  and refreshes `sample_subject`/`last_seen_at` without creating a duplicate row.
- `enabled`/`status` invariant — suggested/dismissed rows are excluded by the existing
  fast-scan `enabled=true` filter.

**Integration (Postgres, `backend/test/integration/`):**
- Discovery route end-to-end with a mocked Gmail client: a deterministic-parser message
  auto-ingests + auto-learns its sender; an AI-only message with no amount match produces
  a suggestion and **no** `ExternalOrder`; approve promotes the sender and (with `scan=1`)
  ingests its receipts; dismiss removes it from the next discovery query.

## Phasing

- **Phase 1 (this spec):** `category:purchases` + subject-keyword signals, confidence
  tiering, suggestions store + approval UI. The core "find more receipts" win.
- **Phase 2:** PDF-attachment extraction — add the `has:attachment filename:pdf` query
  clause; download the Gmail attachment (Gmail API attachments endpoint) → extract text
  via the existing `backend/src/import/pdf/extractLines.ts` / `pdfjs-dist` path → feed the
  same parser/AI pipeline. Catches PDF-only invoices (utilities, SaaS, contractors).
- **Phase 3:** Forwarded-receipt detection — `subject:(Fwd OR Fw)` + receipt keywords;
  parse the original sender/vendor out of the forwarded body so the receipt attributes to
  the real vendor, not the forwarder.

## Out of scope

- A user-facing free-text search box over emails/receipts (different feature — this is
  discovery/ingestion, not query UI).
- Scheduled/background discovery (Phase 1 is manual-trigger only; a cron can wrap
  `discoverReceiptSources()` later without API change).
- Changes to extraction fidelity or transaction-matching logic (separate concerns; this
  spec only widens *which* emails reach the existing pipeline).

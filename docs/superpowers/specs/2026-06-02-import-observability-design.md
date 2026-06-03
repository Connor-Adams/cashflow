# Async import observability — design

**Date:** 2026-06-02
**Status:** approved design, pre-plan
**Owner:** Connor
**Builds on:** the async PDF-bundle import (#528 — `pdf_import_batch`/`pdf_import_item`, `pdfImportProcessor.drainPendingChunk`, the `pdf_import_process` cron, `GET /import/pdf-batch/:id`, `ImportModal` polling).

## Goal

Make the async PDF import legible and faster: distinguish files we intentionally don't parse from real failures, log failures (with their saved S3 key) for investigation, drain bundles in minutes instead of ~20, and surface progress app-wide + in a history page with retry.

## Motivation (observed in prod)

A 266-file upload showed `57 failed` — but 56 were `*_CASH.pdf` (33) + `*_PERFORMANCE.pdf` (23) which have no parser by design, and only 1 was a genuinely unsupported statement (`WK56TFH01CAD` Save-for-Business). "57 failed" is alarming and wrong; progress only lived in the import modal; the cron's fixed 12-per-minute meant ~20 min to drain.

## Spine note

Extends the existing `pdf_import_batch`/`pdf_import_item` infra tables (a `skipped` status, a `skipped` count, a `started_at`, an item `reason`). No new primitive; these are job/progress-tracking infra (like `job_runs`).

## Components

### 1. Status model — `skipped` vs `failed` (keep every file)

- `pdf_import_item.status` gains `skipped` (enum now `pending|processing|done|failed|skipped`). Add `pdf_import_item.reason` (text, null) for the skip/fail explanation.
- `pdf_import_batch` gains `skipped` (int, default 0) and `started_at` (date, null — set on first processing).
- **Every uploaded file is still saved to S3 and gets an item** (no upload-time rejection — Connor keeps them all, including CASH/PERFORMANCE, for the archive + investigation).
- In `processItem`: when `findPdfParser(lines)` returns null (no parser matches the layout — the CASH/PERFORMANCE files and the unsupported Save-for-Business statement) → set item `skipped`, `reason: 'No parser matched this statement layout'`. Only a genuine error (PDF unreadable, parser threw, parse/commit error) → `failed` + `reason: <error>`.
- `recomputeBatch`: `processed = done + failed + skipped`; track `skipped`; terminal status = `processing` if any pending/processing; else `failed` only if `failed > 0 && succeeded === 0`; else `done` (done batches may carry `skipped > 0` and `failed > 0` — surfaced in counts, not the headline). Existing per-item failure isolation unchanged.

### 2. Failure logging for investigation

- `failed` → `logger.error('pdf_import_item_failed', { batchId, itemId, fileName, storageKey: storedFilename, storageKind, error })`. The `storageKey` lets the saved S3 object be pulled to investigate.
- `skipped` → `logger.info('pdf_import_item_skipped', { batchId, itemId, fileName, reason })`.
- Bytes already persist in S3 (kept, not deleted), so any failed/skipped file is recoverable by `readVaultObject(storageKey, encryptionAlgorithm)`.

### 3. Faster drain + ETA — time-budgeted loop

- Replace the fixed `chunk: 12` with a **time-budgeted loop** in `drainPendingChunk`: process pending items one at a time until either `~25s` elapsed (`DRAIN_BUDGET_MS`) or no pending remain, `await new Promise(r => setImmediate(r))` between items to keep the event loop responsive (pdfjs is CPU-bound, single web process). The job is wrapped in `withAdvisoryLock` + the reentrancy guard, so a longer tick is safe (the next cron tick is skipped while one runs). After a tick, if pending remain, the handler re-fires `runJobByName('pdf_import_process')` (best-effort) so it continues without waiting for the next minute. Keeps cron every-minute as the safety net + the upload-time trigger.
- `started_at`: set on the batch when its first item moves to `processing`.
- `estimatedRemainingMs` (in the progress endpoint): `processed > 0 ? Math.round((Date.now() - started_at) / processed * pending) : null` where `pending = total - processed`.
- The `drainPendingChunk` signature keeps an optional `{ budgetMs?, maxItems? }` so tests can bound it (e.g. `maxItems: 1`).

### 4. API

- `GET /import/pdf-batches` — recent batches for the caller's household (`limit ~20`, newest first): `[{ id, status, total, processed, succeeded, failed, skipped, createdAt, startedAt }]`. Powers the global indicator (filter to non-terminal) + the history page.
- `GET /import/pdf-batch/:id` — extend the existing response with `skipped`, `startedAt`, `estimatedRemainingMs`, and per-item `reason`. Household-scoped, 404 cross-household (unchanged).
- `POST /import/pdf-batch/:id/retry` — household-scoped; sets that batch's `failed` items back to `pending` (clear their `error`/`reason`), resets the batch to `processing` + recomputes counts, and fires `runJobByName('pdf_import_process')`. Skipped (unsupported) items are NOT retried. Returns the updated batch summary.

### 5. Frontend

- **Global progress** (`frontend/src/components/import/useActiveImports.ts` + a small header element): a hook polling `GET /api/import/pdf-batches` every ~3s; if any batch is `pending`/`processing`, render a header badge "Importing {processed}/{total} · ~{eta}" (app-wide, in the layout/header). On a batch transitioning to terminal, fire a toast ("Import done: N imported, M skipped, K failed") and call the accounts/transactions refresh. Stops polling when nothing is active.
- **Imports history page** (`frontend/src/pages/ImportsPage.tsx`, route `/imports`): a table of batches (time, status, ok/skipped/failed, total) → expand/drill into per-file rows (fileName, account, txn/act/hld counts, skip/fail `reason`) from `GET /pdf-batch/:id`; a **Retry failed** button (visible when `failed > 0`) calling the retry endpoint. Link to it from the Import modal/page.

## Data flow

upload (unchanged: save bytes + items + fire job) → drain loop (time-budgeted): per item → parse/commit → `done`, or no-parser → `skipped`, or error → `failed` (+ structured log) → batch recompute (counts + ETA) → re-fire if pending. Frontend: global hook polls `/pdf-batches` (badge + toast); history page polls `/pdf-batch/:id` (per-file + retry).

## Error handling

- Per-item failure isolated (unchanged) → `failed` + logged; drain continues. Per-item unsupported → `skipped` + logged.
- Retry only re-queues `failed` (idempotent; commit dedup makes re-processing safe). Retrying an already-`done` batch with 0 failed is a no-op.
- Time-budget loop: a single item that hangs is bounded only by its own work (no per-item timeout added here — out of scope); the budget bounds the tick, the advisory lock prevents overlap.
- Stale `processing` reset (existing, 10 min) unchanged — covers a crash mid-loop.

## Testing

- **Unit:** no-parser → `skipped` not `failed` (+ reason); real error → `failed` (+ logged); `recomputeBatch` counts (done/failed/skipped, terminal status); time-budget loop stops at `maxItems`/budget and re-fires when pending remain; ETA calc; retry re-queues only `failed` and resets batch.
- **Integration (Postgres):** upload a mixed batch (a brokerage PDF + a fake CASH-named PDF) → brokerage `done` + committed, CASH `skipped`, batch counts correct + `estimatedRemainingMs` present; `GET /pdf-batches` lists it; `POST retry` re-queues a failed item.
- **Frontend:** build clean; the history page + global badge render from a mocked response (if a frontend test harness exists; else build is the gate).

## Out of scope

- A parser for the Save-for-Business / `*_CASH.pdf` layouts (cash data already comes from `_BROKERAGE`; the 1 unsupported statement is a separate parser task).
- Per-item processing timeouts / cancellation of an in-flight batch.
- Surfacing the saved PDFs as browsable `VaultDocument`s.

## Risks

1. **CPU blocking** during a long time-budgeted tick — mitigated by the `setImmediate` yield between items + the 25s budget; the server stays responsive between items, and the advisory lock prevents overlapping ticks.
2. **Re-fire loop** — the handler re-fires only when pending remain and only via the best-effort `runJobByName`; the advisory lock + reentrancy guard prevent a runaway. Cron remains the safety net.
3. **Status migration** — adding `skipped` to existing rows is additive; existing `failed` rows from the current prod batch stay `failed` (a one-time reclassify is out of scope; new imports get correct status). Note this for the prod batch already processed.

# Async PDF-bundle import — design

**Date:** 2026-06-02
**Status:** approved design, pre-plan
**Owner:** Connor
**Builds on:** the synchronous WS PDF import (#521/#522/#523).

## Goal

Make `/upload-pdf-bundle` handle large bundles (180+ PDFs) without HTTP timeouts, for all issuers (RBC/CIBC/Questrade/Wise/Wealthsimple). The upload accepts files fast, persists bytes to S3, and returns immediately; a background cron drains the work, parsing + committing each PDF; the UI polls a status endpoint and shows per-file progress.

## Why

The current `pdfBundleHandler` (`backend/src/routes/import.ts:526-599`) processes every file **synchronously in the request** (`for (const file of files) await importPdfBundleFile(...)`) and only responds after all finish. Each PDF is run through pdfjs twice (`importPdfBundleFile` extracts for the header at `runImport.ts:952`, then `parseStatementFile` re-extracts at `parseStatementFile.ts:738`) + committed + enriched ≈ 1.5–3s/file. 180 files = many minutes in one request → exceeds the platform/proxy timeout (~5 min). The 120-file multer cap also rejects 180+ outright.

## Spine note

`pdf_import_batch` and `pdf_import_item` are **infrastructure** job/progress-tracking tables — the same category as the existing `jobs` / `job_runs` / `provider_job_log` tables, which already live outside the 13 primitives. They introduce no new domain status-machine. The domain outputs remain `Transaction` / `InvestmentActivity` / `HoldingSnapshot`. This is not a spine change.

## Existing infra reused

- **Byte storage:** `backend/src/storage/vaultStorage.ts` — `saveVaultObject(storedFilename, {buffer, contentType, originalName})` → `{storedFilename, storageKind, encryptionAlgorithm, encryptionKeyVersion}`; `readVaultObject(storedFilename, encryptionAlgorithm)` → Buffer; `deleteVaultObject(storedFilename)`. S3-backed when `AWS_*` env is set (the connected bucket), else local dir; AES-256-GCM at rest. `@aws-sdk/client-s3` already a dependency.
- **Cron jobs:** `backend/src/jobs/registry.ts` `defineJob({name, cronDefault, enabledDefault, handler})` + `startAllJobs()` (in-process, started at `server.ts:45`); `runJobByName(name)` (`registry.ts:75`) for manual trigger; `tick()` executor with a `runningTicks` reentrancy guard (`runner.ts`); `withAdvisoryLock(name, fn)` (`jobs/pgLock.ts:23`) for multi-instance safety (no-op on sqlite). `JobRun` history table.
- **Import (worker-safe, no req coupling — already called from `onboarding/runOnboardingImport.ts`):** `parseStatementFile({buffer, fileName, accountId, profileId?, householdId?, overrideBusiness?})` → `StatementPreview | {ok:false, error}` (`parseStatementFile.ts:453`); `commitStatementImport(preview, userId, householdId)` → `{inserted, insertedTransactions, insertedInvestmentActivities, insertedHoldings, skippedDuplicates, rowErrors, parseErrors, warnings}` (`commitStatementImport.ts:175`). Idempotent via `ImportHistory` contentHash + row-level dedup.
- **Account resolution:** `importPdfBundleFile` (`runImport.ts:942`) extracts lines → `findPdfParser` → `parser.parse` for `header` → `Account.findOrCreate({where:{householdId, shortCode: header.accountSuffix}, ...})` via `PDF_ACCOUNT_TEMPLATES` + `resolveEntityForHolder`. This logic is reused per-item in the worker.
- **Async precedent:** `aiReview` (`routes/aiReview.ts`) — persisted run row with `status` `pending`/`completed`/`failed`, `POST` creates, `GET /:id` polls. Its docstring blesses exactly this migration.

## Components

### 1. Tables + models

`pdf_import_batch` (model `PdfImportBatch`):
- `id` (uuid PK), `householdId` (FK), `userId` (FK), `status` enum `pending|processing|done|failed`, `total` int, `processed` int, `succeeded` int, `failed` int, `createdAt`, `updatedAt`.

`pdf_import_item` (model `PdfImportItem`):
- `id` (uuid PK), `batchId` (FK → pdf_import_batch, cascade), `storageKey` (string, the `storedFilename` from `saveVaultObject`), `storageKind` (`local|s3`), `encryptionAlgorithm` (string), `fileName` (string), `status` enum `pending|processing|done|failed`, `resultJson` (JSON: insert/skip counts + warnings + accountName), `error` (text, null), `accountId` (FK, null until resolved), `createdAt`, `updatedAt`.
- Index on `(status)` and `(batchId)` for the drain query + progress query.

Migrations under `backend/src/migrations/` (Postgres + sqlite compatible, matching existing migration style).

### 2. Upload endpoint — `POST /upload-pdf-bundle` (converted to async)

- Multer stays `memoryStorage`; raise `files` cap 120 → **200** (+ `array('files', 200)`).
- Handler: create a `pdf_import_batch` (`status: pending`, `total: files.length`). For each file: `saveVaultObject(uuid+ext, {buffer, contentType, originalName})` → create a `pdf_import_item` (`status: pending`, `storageKey`, `storageKind`, `fileName`). Respond `201 { batchId, total }` immediately. No parsing in-request.
- Best-effort: fire `runJobByName('pdfImportProcess')` (not awaited) so the first chunk starts without waiting for the cron tick.
- The response contract changes (was `{results:[...]}`, now `{batchId, total}`) — the frontend is updated in lockstep (§6).

### 3. Background processor — cron job `pdfImportProcess`

- `defineJob({name:'pdfImportProcess', cronDefault:'* * * * *' (every minute), enabledDefault:true, handler})`, registered in `server.ts`.
- Handler wrapped in `withAdvisoryLock('pdfImportProcess', ...)`; the `runningTicks` guard prevents overlap.
- Drains a **bounded chunk** (`CHUNK = 12`) of `pdf_import_item` rows where `status='pending'`, oldest first. For each: set `processing`; `readVaultObject(storageKey, encryptionAlgorithm)`; extract lines once via `extractPdfLines`; `findPdfParser`; resolve+find-or-create the Account from the header (shared helper extracted from `importPdfBundleFile`); `parseStatementFile({buffer, accountId, householdId, preExtractedLines})`; `commitStatementImport`; set item `done` + `resultJson`, or `failed` + `error`. Update the parent batch counts (`processed`/`succeeded`/`failed`); when no `pending` items remain for the batch, set batch `done` (or `failed` if all items failed).
- Bounded chunk per tick keeps the single web process responsive (pdfjs is CPU-bound); cron re-fires next minute for the next chunk. ~12–18 min for 187 files. Restart-safe: `pending` items survive a deploy and resume on the next tick. Re-processing is safe (dedup).
- Bytes are **kept** in S3 after parse (re-parseable). `deleteVaultObject` is NOT called (durable archive; cheap).

### 4. Single-extraction fix — `parseStatementFile`

Add an optional `preExtractedLines?: PdfLine[]` (and optional pre-resolved parser id) to the `parseStatementFile` opts. When provided, the `.pdf` branch skips `extractPdfLines` + `findPdfParser` and uses the supplied lines/parser. The worker extracts once (for header/account resolution) and passes the lines through, so each PDF hits pdfjs once instead of twice. The synchronous callers are unaffected (param optional). Extract the account-resolution block from `importPdfBundleFile` into a reusable `resolvePdfAccountFromHeader(header, householdId, userId)` so both the worker and the (now-thin) bundle path share it.

### 5. Progress endpoint — `GET /import/pdf-batch/:id`

Returns `{ id, status, total, processed, succeeded, failed, items: [{fileName, status, accountName, inserted, skipped, error}] }`, scoped to the caller's household (authz like other import routes). The aiReview poll pattern. Used by the UI to render progress.

### 6. Frontend — progress view

`ImportModal`/`UploadCard` PDF-bundle path: on upload, store the returned `batchId`; poll `GET /import/pdf-batch/:id` every ~2s; render a progress bar (`processed/total`) + per-file rows (account, imported/skipped counts, errors). Stop polling when `status` is `done`/`failed`. Replaces the inline-results render for the PDF bundle. The copy already lists Wealthsimple (from #522).

## Data flow

upload → save bytes to S3 + create batch(`pending`) + items(`pending`) → respond `{batchId}` → (trigger + cron) `pdfImportProcess` drains chunks → per item: S3 read → parse (single extract) → account find-or-create → commit (dedup) → item `done`/`failed` + batch counts → UI polls `GET /import/pdf-batch/:id` until `done`.

## Error handling

- Per-item failure (bad PDF, no parser matched, parse/commit error) → item `status:failed` + `error`; the drain continues other items; batch ends `done` with `failed>0` (not aborted). Nothing silently lost.
- Process restart mid-drain → `processing` items are re-set to `pending` at job start (a stuck-item reset: any `processing` item older than the chunk timeout reverts to `pending`) and reprocessed (dedup-safe).
- S3 read failure for an item → item `failed` + error; surfaced in the batch.
- Account resolution failure (no header) → item `failed` with a clear message (e.g. "no parser matched / no header").

## Testing

- **Unit:** batch/item creation on upload; the drain handler processes a bounded chunk and updates item + batch counts; a failing item marks `failed` without aborting the chunk; `processing`→`pending` reset on restart; `parseStatementFile` with `preExtractedLines` skips re-extraction (assert pdfjs called once).
- **Integration (migrated Postgres):** upload N files → batch+items rows created (`pending`), bytes in storage; run `pdfImportProcess` → Transactions/Holdings/Activities committed, items `done`, batch `done`; re-run the drain → 0 new inserts (dedup/idempotency); progress endpoint returns correct counts.
- **Frontend:** progress view polls + renders per-file results; stops on `done`.

## Out of scope

- Surfacing the stored PDFs as `VaultDocument`s in the vault UI (bytes persist in S3; a browsable archive is a follow-on).
- A general-purpose work queue (this is one feature-specific cron drain).
- SSE/websocket progress (polling is sufficient).
- Cancelling / retrying a batch from the UI (a failed item can be re-uploaded; dedup makes it safe).

## Risks

1. **CPU blocking** — pdfjs is CPU-bound and runs in the single web process. Mitigated by the bounded per-tick chunk (12) so each tick is short; the server stays responsive between ticks.
2. **Upload-time S3 latency** — saving 187 objects in the request could be slow. Mitigated: S3 PUTs only (no parse), parallelizable; if still slow, the cap keeps it bounded. Acceptable for a backfill; monitor.
3. **Stuck `processing` items** — handled by the restart reset (revert stale `processing`→`pending`).
4. **Response-contract change** — `/upload-pdf-bundle` now returns `{batchId}` not `{results}`. The frontend is updated in the same change; no other consumers (internal route).

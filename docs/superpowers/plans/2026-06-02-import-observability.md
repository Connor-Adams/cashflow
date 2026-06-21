# Async Import Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the async PDF import legible + fast — `skipped` vs `failed` status, failure logging with the S3 key, a time-budgeted drain with ETA, a batches-list + retry API, and an app-wide progress badge + `/imports` history page.

**Architecture:** Extends the async import infra (`pdf_import_batch`/`pdf_import_item`, `pdfImportProcessor`, the `pdf_import_process` cron, `GET /import/pdf-batch/:id`, `ImportModal`). Adds a `skipped` item status + `reason`, a `skipped`/`started_at` on the batch; rewrites the drain as a yielding time-budgeted loop that re-fires until drained; adds list/retry routes; adds a polling hook + header badge + history page.

**Tech Stack:** TypeScript (CommonJS), Sequelize (Postgres+sqlite), Express, node-cron jobs + pgLock, React + react-router, `node:test`/`tsx`.

**Spec:** `docs/superpowers/specs/2026-06-02-import-observability-design.md`

---

## File Structure

**Create:**
- `backend/src/migrations/20260602110000-pdf-import-observability.js` — add `pdf_import_items.reason`, `pdf_import_batches.skipped`, `pdf_import_batches.started_at`.
- `frontend/src/components/import/useActiveImports.ts` — polling hook for in-flight batches.
- `frontend/src/components/import/ImportProgressBadge.tsx` — the header badge + completion toast.
- `frontend/src/pages/ImportsPage.tsx` — history page.
- Tests: `backend/test/pdfImportObservability.test.ts`, `backend/test/integration/pdfImportObservabilityRoute.test.ts`.

**Modify:**
- `backend/src/models/PdfImportBatch.ts` (+ `skipped`, `startedAt`), `backend/src/models/PdfImportItem.ts` (+ `reason`, `'skipped'` in the status type).
- `backend/src/import/pdfImportProcessor.ts` — `skipped` categorization, structured logging, `started_at`, time-budget loop + `pendingRemaining`.
- `backend/src/jobs/definitions/pdfImportProcess.ts` — re-fire while pending remain.
- `backend/src/routes/import.ts` — extend `GET /pdf-batch/:id`, add `GET /pdf-batches` + `POST /pdf-batch/:id/retry`.
- `frontend/src/App.tsx` (route `/imports`), `frontend/src/components/Layout.tsx` (mount the badge), `frontend/src/components/import/ImportModal.tsx` (link to `/imports`).

---

## Task 1: Migration + model fields

**Files:**
- Create: `backend/src/migrations/20260602110000-pdf-import-observability.js`
- Modify: `backend/src/models/PdfImportBatch.ts`, `backend/src/models/PdfImportItem.ts`
- Test: `backend/test/pdfImportObservability.test.ts`

- [ ] **Step 1: Migration** — create `backend/src/migrations/20260602110000-pdf-import-observability.js`:

```js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('pdf_import_items', 'reason', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn('pdf_import_batches', 'skipped', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('pdf_import_batches', 'started_at', { type: Sequelize.DATE, allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('pdf_import_items', 'reason');
    await queryInterface.removeColumn('pdf_import_batches', 'skipped');
    await queryInterface.removeColumn('pdf_import_batches', 'started_at');
  },
};
```

- [ ] **Step 2: Model fields** —
In `backend/src/models/PdfImportBatch.ts`: change `PdfImportStatus` to `'pending' | 'processing' | 'done' | 'failed' | 'skipped'`; add to the class `declare skipped: CreationOptional<number>;` and `declare startedAt: CreationOptional<Date | null>;`; add to `init`: `skipped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }`, `startedAt: { type: DataTypes.DATE, field: 'started_at', allowNull: true }`.
In `backend/src/models/PdfImportItem.ts`: add `declare reason: CreationOptional<string | null>;` and to `init`: `reason: { type: DataTypes.TEXT, allowNull: true }`. (The `status` type already references `PdfImportStatus` which now includes `skipped`.)

- [ ] **Step 3: Failing test** — create `backend/test/pdfImportObservability.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../src/models';

async function hhUser() {
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id, displayName: 'T', passwordHash: 'x', passwordSalt: 'y', passwordParams: 'p' } as never);
  return { hh, u };
}

test('batch has skipped + startedAt; item has reason; skipped status persists', async () => {
  await sequelize.sync({ force: true });
  const { hh, u } = await hhUser();
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  const i = await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'x.pdf', storedFilename: 'k.pdf', storageKind: 'local', encryptionAlgorithm: 'none', status: 'skipped', reason: 'No parser matched this statement layout' });
  const got = await PdfImportItem.findByPk(i.id);
  assert.equal(got?.status, 'skipped');
  assert.equal(got?.reason, 'No parser matched this statement layout');
});
```

- [ ] **Step 4: Run** — `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportObservability.test.ts` → PASS (after model edits). `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** —
```bash
git add backend/src/migrations/20260602110000-pdf-import-observability.js backend/src/models/PdfImportBatch.ts backend/src/models/PdfImportItem.ts backend/test/pdfImportObservability.test.ts
git commit --no-verify -m "feat(import): skipped status + reason + batch skipped/startedAt"
```

---

## Task 2: Processor — skipped categorization + logging + started_at

**Files:**
- Modify: `backend/src/import/pdfImportProcessor.ts`
- Test: `backend/test/pdfImportProcessor.test.ts` (existing) + `pdfImportObservability.test.ts`

- [ ] **Step 1: Failing test** — append to `backend/test/pdfImportObservability.test.ts` (uses `drainPendingChunk` + a fake non-statement PDF):

```ts
import fs from 'node:fs';
import { saveVaultObject } from '../src/storage/vaultStorage';
import { drainPendingChunk } from '../src/import/pdfImportProcessor';

test('a no-parser file is skipped (not failed) with a reason', async () => {
  await sequelize.sync({ force: true });
  const { hh, u } = await hhUser();
  // a real but unmatched PDF: minimal valid PDF bytes (pdfjs reads it, no parser sniffs it)
  const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const put = await saveVaultObject(`${crypto.randomUUID()}.pdf`, { buffer: tinyPdf, contentType: 'application/pdf', originalName: 't.pdf' });
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 't.pdf', storedFilename: put.storedFilename, storageKind: put.storageKind, encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending' });
  const s = await drainPendingChunk({ maxItems: 5 });
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
  const item = await PdfImportItem.findOne({ where: { batchId: b.id } });
  assert.equal(item?.status, 'skipped');
  assert.match(item?.reason ?? '', /No parser matched/i);
  const batch = await PdfImportBatch.findByPk(b.id);
  assert.equal(batch?.status, 'done');     // skipped-only batch is done, not failed
  assert.equal(batch?.skipped, 1);
  assert.ok(batch?.startedAt);             // started_at set
});
```

> If `extractPdfLines` rejects the minimal PDF bytes (throws), that would route to `failed` not `skipped`. If so, replace `tinyPdf` with a real non-statement PDF: read a local `*_PERFORMANCE.pdf` from `/Users/connoradams/Downloads/monthly_pdf_statements` and gate the test on its existence (mirror the `CC_PDF` skip pattern in `pdfImportProcessor.test.ts`). The point is: pdfjs reads it, no parser sniffs it → `skipped`.

- [ ] **Step 2: Run → fail** (skipped is currently counted as failed / not tracked).

- [ ] **Step 3: Implement** — edit `backend/src/import/pdfImportProcessor.ts`:

(a) `DrainSummary` gains `skipped`: `export type DrainSummary = { processed: number; succeeded: number; failed: number; skipped: number };`

(b) `processItem` returns the outcome + handles no-parser as skip. Replace its signature + the no-parser line + the tail:
```ts
export async function processItem(item: PdfImportItem): Promise<'done' | 'skipped'> {
```
Replace `if (!parser) throw new Error('No PDF parser matched this statement layout');` with:
```ts
  if (!parser) {
    item.status = 'skipped';
    item.reason = 'No parser matched this statement layout';
    await item.save();
    logger.info(
      { batchId: item.batchId, itemId: item.id, fileName: item.fileName, reason: item.reason },
      'pdf_import_item_skipped',
    );
    return 'skipped';
  }
```
At the end (after `item.status = 'done'`), set `item.reason = null;` before `await item.save();` and `return 'done';`.

(c) `recomputeBatch` tracks skipped:
```ts
async function recomputeBatch(batchId: string): Promise<void> {
  const items = await PdfImportItem.findAll({ where: { batchId } });
  const succeeded = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const processed = succeeded + failed + skipped;
  const anyPending = items.some((i) => i.status === 'pending' || i.status === 'processing');
  const batch = await PdfImportBatch.findByPk(batchId);
  if (!batch) return;
  batch.processed = processed;
  batch.succeeded = succeeded;
  batch.failed = failed;
  batch.skipped = skipped;
  batch.status = anyPending ? 'processing' : (succeeded === 0 && failed > 0 ? 'failed' : 'done');
  await batch.save();
}
```

(d) In `drainPendingChunk`'s loop, set `started_at` + count skipped + richer failure log + handle the `processItem` outcome. (The loop is rewritten in Task 3; for THIS task, minimally update the existing loop: after `item.status='processing'; await item.save();` add the started_at set; replace `await processItem(item); summary.succeeded += 1;` with `const outcome = await processItem(item); if (outcome === 'skipped') summary.skipped += 1; else summary.succeeded += 1;`; in the catch set `item.reason = (err as Error).message;` and expand the log to `logger.error({ batchId: item.batchId, itemId: item.id, fileName: item.fileName, storageKey: item.storedFilename, storageKind: item.storageKind, err }, 'pdf_import_item_failed');`; initialize `summary.skipped = 0`.) Also add the started_at set:
```ts
    item.status = 'processing';
    await item.save();
    const b = await PdfImportBatch.findByPk(item.batchId);
    if (b && !b.startedAt) { b.startedAt = new Date(); await b.save(); }
```
Add `skipped: 0` to the `summary` initializer. (Add `maxItems?: number` to the opts now so the test compiles; honor it as a loop cap — the full time-budget loop lands in Task 3.)

- [ ] **Step 4: Run** — the new test + the existing `pdfImportProcessor.test.ts` pass. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** —
```bash
git add backend/src/import/pdfImportProcessor.ts backend/test/pdfImportObservability.test.ts
git commit --no-verify -m "feat(import): categorize unsupported files as skipped + structured failure log"
```

---

## Task 3: Time-budgeted drain loop + re-fire

**Files:**
- Modify: `backend/src/import/pdfImportProcessor.ts`, `backend/src/jobs/definitions/pdfImportProcess.ts`
- Test: `backend/test/pdfImportObservability.test.ts`

- [ ] **Step 1: Failing test** — append:

```ts
test('drain reports pendingRemaining and respects maxItems', async () => {
  await sequelize.sync({ force: true });
  const { hh, u } = await hhUser();
  const b = await PdfImportBatch.create({ id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 3, processed: 0, succeeded: 0, failed: 0, skipped: 0, startedAt: null });
  for (let k = 0; k < 3; k++) {
    const put = await saveVaultObject(`${crypto.randomUUID()}.pdf`, { buffer: Buffer.from('not a pdf'), contentType: 'application/pdf', originalName: 'b.pdf' });
    await PdfImportItem.create({ id: crypto.randomUUID(), batchId: b.id, fileName: 'b.pdf', storedFilename: put.storedFilename, storageKind: put.storageKind, encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending' });
  }
  const s = await drainPendingChunk({ maxItems: 2 });
  assert.equal(s.processed, 2);
  assert.equal(s.pendingRemaining, 1);
});
```

- [ ] **Step 2: Run → fail** (`pendingRemaining` not returned; loop processes all/limit differs).

- [ ] **Step 3: Implement the time-budget loop** — replace the body of `drainPendingChunk` with:

```ts
export async function drainPendingChunk(
  opts: { budgetMs?: number; maxItems?: number } = {},
): Promise<DrainSummary & { pendingRemaining: number }> {
  const budgetMs = opts.budgetMs ?? 25_000;
  const maxItems = opts.maxItems ?? Infinity;
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  await PdfImportItem.update(
    { status: 'pending' },
    { where: { status: 'processing', updatedAt: { [Op.lt]: staleCutoff } } },
  );

  const summary = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  const touchedBatches = new Set<string>();
  const start = Date.now();
  let count = 0;
  while (Date.now() - start < budgetMs && count < maxItems) {
    const item = await PdfImportItem.findOne({ where: { status: 'pending' }, order: [['created_at', 'ASC']] });
    if (!item) break;
    item.status = 'processing';
    await item.save();
    const b = await PdfImportBatch.findByPk(item.batchId);
    if (b && !b.startedAt) { b.startedAt = new Date(); await b.save(); }
    try {
      const outcome = await processItem(item);
      if (outcome === 'skipped') summary.skipped += 1; else summary.succeeded += 1;
    } catch (err) {
      item.status = 'failed';
      item.error = (err as Error).message;
      item.reason = (err as Error).message;
      await item.save();
      summary.failed += 1;
      logger.error(
        { batchId: item.batchId, itemId: item.id, fileName: item.fileName, storageKey: item.storedFilename, storageKind: item.storageKind, err },
        'pdf_import_item_failed',
      );
    }
    summary.processed += 1;
    count += 1;
    touchedBatches.add(item.batchId);
    await new Promise<void>((r) => setImmediate(r)); // yield — pdfjs is CPU-bound
  }
  for (const batchId of touchedBatches) await recomputeBatch(batchId);
  if (touchedBatches.size > 0) {
    const batches = await PdfImportBatch.findAll({ where: { id: [...touchedBatches] } });
    for (const hid of new Set(batches.map((bb) => bb.householdId))) {
      try { await syncTransactionEntityIds(hid); }
      catch (err) { logger.error({ err, hid }, 'pdf_import_entity_sync_failed'); }
    }
  }
  const pendingRemaining = await PdfImportItem.count({ where: { status: 'pending' } });
  return { ...summary, pendingRemaining };
}
```

- [ ] **Step 4: Re-fire in the job** — `backend/src/jobs/definitions/pdfImportProcess.ts`:

```ts
import { defineJob } from '../registry';
import { withAdvisoryLock } from '../pgLock';
import { runJobByName } from '../registry';
import { drainPendingChunk } from '../../import/pdfImportProcessor';

defineJob({
  name: 'pdf_import_process',
  cronDefault: '* * * * *',
  enabledDefault: true,
  handler: async () => {
    const res = await withAdvisoryLock('pdf_import_process', () => drainPendingChunk());
    if (!res.acquired) return { summary: { skipped: 'locked' } };
    const r = res.value;
    if (r.pendingRemaining > 0) {
      // Lock released (withAdvisoryLock returned); continue draining without
      // waiting for the next minute. Reentrancy guard + lock prevent overlap.
      setTimeout(() => { void runJobByName('pdf_import_process').catch(() => {}); }, 250);
    }
    return { summary: r as unknown as Record<string, unknown> };
  },
});
```

- [ ] **Step 5: Run** — the new test + existing processor + job tests pass; `npx tsc --noEmit` clean. (The existing `pdfImportProcessor.test.ts` calls `drainPendingChunk({chunk:12})` — update those calls to `{maxItems:12}` or `{}` since the opt renamed; grep + fix.)

- [ ] **Step 6: Commit** —
```bash
git add backend/src/import/pdfImportProcessor.ts backend/src/jobs/definitions/pdfImportProcess.ts backend/test/pdfImportProcessor.test.ts backend/test/pdfImportObservability.test.ts
git commit --no-verify -m "feat(import): time-budgeted drain loop + continue-until-drained"
```

---

## Task 4: API — batches list, retry, ETA

**Files:**
- Modify: `backend/src/routes/import.ts`
- Test: `backend/test/integration/pdfImportObservabilityRoute.test.ts`

- [ ] **Step 1: Extend `GET /pdf-batch/:id`** — in `backend/src/routes/import.ts`, the existing handler: add `skipped`, `startedAt`, `estimatedRemainingMs`, and per-item `reason` to the response:

```ts
    const pending = batch.total - batch.processed;
    const estimatedRemainingMs =
      batch.startedAt && batch.processed > 0 && pending > 0
        ? Math.round((Date.now() - new Date(batch.startedAt).getTime()) / batch.processed * pending)
        : null;
    res.json({
      id: batch.id, status: batch.status, total: batch.total,
      processed: batch.processed, succeeded: batch.succeeded, failed: batch.failed,
      skipped: batch.skipped, startedAt: batch.startedAt, estimatedRemainingMs,
      items: items.map((i) => {
        const r = (i.resultJson ?? {}) as Record<string, number | string | undefined>;
        return {
          fileName: i.fileName, status: i.status, accountName: r.accountName ?? null,
          insertedTransactions: r.insertedTransactions ?? 0,
          insertedInvestmentActivities: r.insertedInvestmentActivities ?? 0,
          insertedHoldings: r.insertedHoldings ?? 0,
          skippedDuplicates: r.skippedDuplicates ?? 0,
          reason: i.reason ?? null, error: i.error ?? null,
        };
      }),
    });
```

- [ ] **Step 2: Add `GET /pdf-batches`** — list recent batches:

```ts
router.get('/pdf-batches', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const batches = await PdfImportBatch.findAll({
      where: { householdId: household.id }, order: [['created_at', 'DESC']], limit: 20,
    });
    res.json(batches.map((b) => ({
      id: b.id, status: b.status, total: b.total, processed: b.processed,
      succeeded: b.succeeded, failed: b.failed, skipped: b.skipped,
      createdAt: b.createdAt, startedAt: b.startedAt,
    })));
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Add `POST /pdf-batch/:id/retry`** — re-queue failed items:

```ts
router.post('/pdf-batch/:id/retry', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const batch = await PdfImportBatch.findOne({ where: { id: req.params.id, householdId: household.id } });
    if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
    const [n] = await PdfImportItem.update(
      { status: 'pending', error: null, reason: null },
      { where: { batchId: batch.id, status: 'failed' } },
    );
    if (n > 0) { batch.status = 'processing'; await batch.save(); }
    void runJobByName('pdf_import_process').catch(() => {});
    res.json({ id: batch.id, retried: n, status: batch.status });
  } catch (e) { next(e); }
});
```

(`PdfImportBatch`/`PdfImportItem`, `currentAuth`, `runJobByName` are already imported in import.ts from the async-import work.)

- [ ] **Step 4: Route tests** — create `backend/test/integration/pdfImportObservabilityRoute.test.ts`, mirroring `backend/test/integration/pdfBundleUploadRoute.test.ts` (same Postgres harness + auth). Cover: a batch with a `done` + a `failed` + a `skipped` item → `GET /pdf-batch/:id` returns `skipped:1`, `estimatedRemainingMs` (number or null), and item `reason`s; `GET /pdf-batches` lists it; `POST /pdf-batch/:id/retry` flips the failed item to pending + returns `retried:1` (cross-household → 404).

- [ ] **Step 5: Run + commit** —
```bash
cd backend && npx tsc --noEmit
TEST_DATABASE_URL=postgres://connoradams@localhost:5432/postgres npx tsx --import ./test/setup.ts --test test/integration/pdfImportObservabilityRoute.test.ts
git add backend/src/routes/import.ts backend/test/integration/pdfImportObservabilityRoute.test.ts
git commit --no-verify -m "feat(import): pdf-batches list + retry endpoints + ETA/skipped in batch status"
```

---

## Task 5: Frontend — global progress badge

**Files:**
- Create: `frontend/src/components/import/useActiveImports.ts`, `frontend/src/components/import/ImportProgressBadge.tsx`
- Modify: `frontend/src/components/Layout.tsx`

- [ ] **Step 1: Hook** — create `frontend/src/components/import/useActiveImports.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import { getJson } from '../../lib/api'

export type BatchSummary = {
  id: string; status: 'pending' | 'processing' | 'done' | 'failed'
  total: number; processed: number; succeeded: number; failed: number; skipped: number
  createdAt: string; startedAt: string | null
}

export function useActiveImports(pollMs = 3000) {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const prevActive = useRef<Set<string>>(new Set())
  const [justFinished, setJustFinished] = useState<BatchSummary | null>(null)

  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const all = await getJson<BatchSummary[]>('/api/import/pdf-batches')
        if (!active) return
        setBatches(all)
        const nowActive = new Set(all.filter((b) => b.status === 'pending' || b.status === 'processing').map((b) => b.id))
        for (const id of prevActive.current) {
          if (!nowActive.has(id)) {
            const done = all.find((b) => b.id === id)
            if (done) setJustFinished(done)
          }
        }
        prevActive.current = nowActive
      } catch { /* keep polling */ }
      if (active) setTimeout(tick, pollMs)
    }
    void tick()
    return () => { active = false }
  }, [pollMs])

  const activeBatches = batches.filter((b) => b.status === 'pending' || b.status === 'processing')
  return { activeBatches, justFinished, clearFinished: () => setJustFinished(null) }
}
```

- [ ] **Step 2: Badge** — create `frontend/src/components/import/ImportProgressBadge.tsx`:

```tsx
import { Link } from 'react-router-dom'
import { useActiveImports } from './useActiveImports'

function etaText(b: { processed: number; total: number; startedAt: string | null }): string {
  if (!b.startedAt || b.processed === 0) return ''
  const elapsed = Date.now() - new Date(b.startedAt).getTime()
  const remaining = (elapsed / b.processed) * (b.total - b.processed)
  const m = Math.round(remaining / 60000)
  return m > 0 ? ` · ~${m}m` : ' · <1m'
}

export function ImportProgressBadge() {
  const { activeBatches } = useActiveImports()
  if (activeBatches.length === 0) return null
  const b = activeBatches[0]
  return (
    <Link to="/imports" className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">
      <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      Importing {b.processed}/{b.total}{etaText(b)}
    </Link>
  )
}
```

> Match the project's styling — if it uses a `Badge`/`Alert` primitive (check `frontend/src/components/ui/`), use that instead of raw Tailwind classes. Keep the link to `/imports`.

- [ ] **Step 3: Mount in Layout** — in `frontend/src/components/Layout.tsx`, import `ImportProgressBadge` and render `<ImportProgressBadge />` in the header/top bar area (read the file to find where the top-bar content lives; place it near the existing header actions).

- [ ] **Step 4: Build** — `cd frontend && yarn build` → clean; `yarn lint` → clean.

- [ ] **Step 5: Commit** —
```bash
git add frontend/src/components/import/useActiveImports.ts frontend/src/components/import/ImportProgressBadge.tsx frontend/src/components/Layout.tsx
git commit --no-verify -m "feat(import): app-wide import progress badge"
```

---

## Task 6: Frontend — imports history page

**Files:**
- Create: `frontend/src/pages/ImportsPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/components/import/ImportModal.tsx`

> Note: an `ImportBatchPage` already exists in `App.tsx`. Read it first — if it already renders a single PDF batch, reuse its row-rendering; `ImportsPage` is the LIST that links to per-batch detail.

- [ ] **Step 1: Page** — create `frontend/src/pages/ImportsPage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { getJson, postJson } from '../lib/api'
import { useActiveImports, type BatchSummary } from '../components/import/useActiveImports'
import { Button } from '@/components/ui/button'

type BatchDetail = {
  id: string; status: string; total: number; processed: number; succeeded: number; failed: number; skipped: number
  estimatedRemainingMs: number | null
  items: { fileName: string; status: string; accountName: string | null; insertedTransactions: number; insertedInvestmentActivities: number; insertedHoldings: number; skippedDuplicates: number; reason: string | null; error: string | null }[]
}

export function ImportsPage() {
  const { activeBatches } = useActiveImports()
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<BatchDetail | null>(null)

  useEffect(() => { void getJson<BatchSummary[]>('/api/import/pdf-batches').then(setBatches).catch(() => {}) }, [activeBatches.length])
  useEffect(() => { if (open) void getJson<BatchDetail>(`/api/import/pdf-batch/${open}`).then(setDetail).catch(() => {}); else setDetail(null) }, [open])

  const retry = async (id: string) => { await postJson(`/api/import/pdf-batch/${id}/retry`, {}); await getJson<BatchDetail>(`/api/import/pdf-batch/${id}`).then(setDetail) }

  return (
    <div className="page">
      <h1 className="text-xl font-semibold mb-4">Imports</h1>
      <table className="w-full text-sm">
        <thead><tr className="text-left muted"><th>When</th><th>Status</th><th>Files</th><th>Imported</th><th>Skipped</th><th>Failed</th><th></th></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-t border-border cursor-pointer hover:bg-muted/40" onClick={() => setOpen(open === b.id ? null : b.id)}>
              <td>{new Date(b.createdAt).toLocaleString()}</td><td>{b.status}</td>
              <td>{b.processed}/{b.total}</td><td>{b.succeeded}</td><td>{b.skipped}</td><td>{b.failed}</td>
              <td>{b.failed > 0 && <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); void retry(b.id) }}>Retry failed</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && detail && (
        <div className="mt-4 rounded-md border border-border p-2 text-xs">
          {detail.estimatedRemainingMs != null && <div className="muted mb-1">~{Math.round(detail.estimatedRemainingMs / 60000)}m remaining</div>}
          <ul className="max-h-96 overflow-y-auto">
            {detail.items.map((it, i) => (
              <li key={i} className="truncate py-0.5" title={it.reason ?? it.error ?? ''}>
                <span className={it.status === 'failed' ? 'text-red-600' : it.status === 'skipped' ? 'text-amber-600' : ''}>{it.status}</span>{' '}
                {it.fileName} → {it.accountName ?? '—'}
                {it.status === 'done' ? ` (txn=${it.insertedTransactions} act=${it.insertedInvestmentActivities} hld=${it.insertedHoldings} skip=${it.skippedDuplicates})` : ''}
                {it.reason ? ` · ${it.reason}` : ''}{it.error ? ` · ERR: ${it.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

> Confirm `postJson` exists in `frontend/src/lib/api.ts` (the WS bundle/holdings flows POST — check the helper name; if it's `postFormData` only, add a small `postJson` or use `fetch` with `credentials:'include'`). Match the table styling to an existing list page (e.g. `ImportBatchPage`/`RecurringPage`).

- [ ] **Step 2: Route** — in `frontend/src/App.tsx`, import `ImportsPage` and add `<Route path="/imports" element={<ImportsPage />} />` alongside the other routes (inside the authenticated `<Routes>`).

- [ ] **Step 3: Link from import** — in `frontend/src/components/import/ImportModal.tsx`, after a pdf-bundle upload starts (where it sets the batch feedback), add a link/button "View progress" → `navigate('/imports')` (import `useNavigate` from react-router-dom), so the user lands on the history page.

- [ ] **Step 4: Build** — `cd frontend && yarn build` → clean; `yarn lint` → clean.

- [ ] **Step 5: Commit** —
```bash
git add frontend/src/pages/ImportsPage.tsx frontend/src/App.tsx frontend/src/components/import/ImportModal.tsx
git commit --no-verify -m "feat(import): /imports history page with per-file results + retry"
```

---

## Task 7: End-to-end integration

**Files:**
- Modify: `backend/test/integration/pdfImportObservabilityRoute.test.ts` (add an e2e flow)

- [ ] **Step 1: e2e test** — add a test (gated on the brokerage + a non-statement PDF existing, mirroring `pdfImportAsync.test.ts`): create a batch with a real `*_BROKERAGE.pdf` item + a `*_PERFORMANCE.pdf` (or fake non-statement) item → `drainPendingChunk()` → assert brokerage `done` + committed, the other `skipped` (not failed), batch `done` with `succeeded:1 skipped:1 failed:0`, `estimatedRemainingMs` computed once started; then `POST retry` is a no-op (0 failed). Run against Postgres.

- [ ] **Step 2: Run + commit** —
```bash
cd backend && TEST_DATABASE_URL=postgres://connoradams@localhost:5432/postgres npx tsx --import ./test/setup.ts --test test/integration/pdfImportObservabilityRoute.test.ts
git add backend/test/integration/pdfImportObservabilityRoute.test.ts
git commit --no-verify -m "test(import): e2e skipped-vs-done batch + retry"
```

---

## Self-Review notes

- **Spec coverage:** skipped-vs-failed + reason + keep-all-files (T1+T2), failure logging w/ storageKey (T2), time-budget drain + re-fire + started_at + ETA (T3, T4), `/pdf-batches` + retry + extended `/pdf-batch/:id` (T4), global badge (T5), `/imports` history + retry (T6), e2e (T7). All spec sections map to a task.
- **Type consistency:** `PdfImportStatus` (+skipped) in T1 used everywhere; `DrainSummary` gains `skipped` (T2) + return adds `pendingRemaining` (T3); `processItem(): 'done'|'skipped'` (T2) consumed in the loop (T2/T3); `drainPendingChunk({budgetMs?, maxItems?})` (T3) — the existing `{chunk:12}` callers updated (T3 step 5); `BatchSummary`/`BatchDetail` frontend types match the route JSON (T4↔T5/T6).
- **Placeholders:** none — real code throughout; the `>` notes are "verify against existing pattern X" fidelity checks (minimal-PDF-vs-real-PDF for the skip test, ui primitive names, postJson helper, Layout header location), not TODOs.
- **Accepted:** the existing prod batch's already-`failed` rows stay failed (spec risk); new imports get correct status. A one-time reclassify is out of scope.
```

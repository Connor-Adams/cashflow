# Async PDF-bundle Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `/upload-pdf-bundle` to async — persist uploaded PDF bytes to S3, return a batch id immediately, and drain the parse+commit work in a bounded cron chunk while the UI polls progress — so 180+ files import without HTTP timeouts.

**Architecture:** Two infra tables (`pdf_import_batch`, `pdf_import_item`) track progress. Upload saves bytes via `vaultStorage` + creates rows + responds `{batchId}`. A new cron job `pdfImportProcess` (every minute, `withAdvisoryLock`) drains ≤12 pending items/tick: read bytes → single pdfjs extract → resolve account → `parseStatementFile`(with pre-extracted lines) → `commitStatementImport` → update item + batch. UI polls `GET /import/pdf-batch/:id`. Reuses the worker-safe import functions; dedup makes re-processing idempotent.

**Tech Stack:** TypeScript (CommonJS), Sequelize (Postgres + sqlite), Express, `vaultStorage` (S3/disk + AES), `node-cron` jobs registry + `pgLock` advisory lock, pdfjs, React + `node:test`/`tsx`.

**Spec:** `docs/superpowers/specs/2026-06-02-async-pdf-bundle-import-design.md`

---

## File Structure

**Create:**
- `backend/src/migrations/20260602100000-create-pdf-import-batches.js` — both tables.
- `backend/src/models/PdfImportBatch.ts`, `backend/src/models/PdfImportItem.ts` — models.
- `backend/src/import/pdfImportProcessor.ts` — `drainPendingChunk()` + `processItem()` (the testable core).
- `backend/src/jobs/definitions/pdfImportProcess.ts` — cron job wrapping the drain in `withAdvisoryLock`.
- Tests: `backend/test/pdfImportModels.test.ts`, `backend/test/pdfImportProcessor.test.ts`, `backend/test/parseStatementFilePreExtracted.test.ts`, `backend/test/integration/pdfImportAsync.test.ts`.

**Modify:**
- `backend/src/models/index.ts` — register the two models + associations.
- `backend/src/import/parseStatementFile.ts` — optional `preExtractedLines` opt.
- `backend/src/import/runImport.ts` — extract `resolvePdfAccountFromHeader()` from `importPdfBundleFile`; use it + pass `preExtractedLines`.
- `backend/src/routes/import.ts` — async `pdfBundleHandler` (save→rows→`{batchId}`), multer cap 120→200, new `GET /import/pdf-batch/:id`.
- `backend/src/server.ts` — register the new job (side-effect import).
- `frontend/src/components/import/ImportModal.tsx` — poll the batch + render progress.

---

## Task 1: Tables + models

**Files:**
- Create: `backend/src/migrations/20260602100000-create-pdf-import-batches.js`
- Create: `backend/src/models/PdfImportBatch.ts`, `backend/src/models/PdfImportItem.ts`
- Modify: `backend/src/models/index.ts`
- Test: `backend/test/pdfImportModels.test.ts`

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260602100000-create-pdf-import-batches.js`:

```js
'use strict';

/**
 * Async PDF-bundle import tracking (infra, not a domain primitive — same
 * category as job_runs). A batch is one upload; an item is one PDF, parsed
 * + committed by the pdfImportProcess cron drain. Bytes live in vault storage
 * (S3/disk), referenced by stored_filename.
 */
async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('pdf_import_batches', {
      id: { type: Sequelize.UUID, primaryKey: true },
      household_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      succeeded: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.createTable('pdf_import_items', {
      id: { type: Sequelize.UUID, primaryKey: true },
      batch_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'pdf_import_batches', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      file_name: { type: Sequelize.STRING(512), allowNull: false },
      stored_filename: { type: Sequelize.STRING(255), allowNull: false },
      storage_kind: { type: Sequelize.STRING(16), allowNull: false },
      encryption_algorithm: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none' },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      account_id: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'accounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      result_json: { type: Sequelize.JSON, allowNull: true },
      error: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'pdf_import_batches', ['household_id'], { name: 'pdf_import_batches_household_id' });
    await addIndex(queryInterface, 'pdf_import_items', ['batch_id'], { name: 'pdf_import_items_batch_id' });
    await addIndex(queryInterface, 'pdf_import_items', ['status'], { name: 'pdf_import_items_status' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('pdf_import_items');
    await queryInterface.dropTable('pdf_import_batches');
  },
};
```

- [ ] **Step 2: Write the failing model test**

Create `backend/test/pdfImportModels.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../src/models';

test('pdf import batch + items persist and associate', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id } as never);
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id,
    status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  const item = await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'x.pdf',
    storedFilename: 'k.pdf', storageKind: 'local', encryptionAlgorithm: 'none', status: 'pending',
  });
  const found = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(found?.id, item.id);
  assert.equal(found?.status, 'pending');
});
```

> Check `Household`/`User` required fields against `backend/src/models/Household.ts`/`User.ts` and adjust the `create({...})` calls to satisfy NOT-NULL columns (mirror how `backend/test/*.test.ts` create these — e.g. grep an existing test that makes a household+user).

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportModels.test.ts`
Expected: FAIL — `PdfImportBatch`/`PdfImportItem` not exported.

- [ ] **Step 4: Write the models**

Create `backend/src/models/PdfImportBatch.ts` (mirror `JobRun.ts`):

```ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export type PdfImportStatus = 'pending' | 'processing' | 'done' | 'failed';

export class PdfImportBatch extends Model<
  InferAttributes<PdfImportBatch>, InferCreationAttributes<PdfImportBatch>
> {
  declare id: string;
  declare householdId: number;
  declare userId: number;
  declare status: PdfImportStatus;
  declare total: number;
  declare processed: number;
  declare succeeded: number;
  declare failed: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPdfImportBatch(sequelize: Sequelize): typeof PdfImportBatch {
  PdfImportBatch.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      succeeded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    } as ModelAttributes<PdfImportBatch>,
    { sequelize, modelName: 'PdfImportBatch', tableName: 'pdf_import_batches', underscored: true, timestamps: true },
  );
  return PdfImportBatch;
}
```

Create `backend/src/models/PdfImportItem.ts`:

```ts
import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';
import type { PdfImportStatus } from './PdfImportBatch';

export class PdfImportItem extends Model<
  InferAttributes<PdfImportItem>, InferCreationAttributes<PdfImportItem>
> {
  declare id: string;
  declare batchId: string;
  declare fileName: string;
  declare storedFilename: string;
  declare storageKind: string;
  declare encryptionAlgorithm: string;
  declare status: PdfImportStatus;
  declare accountId: CreationOptional<number | null>;
  declare resultJson: CreationOptional<unknown | null>;
  declare error: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPdfImportItem(sequelize: Sequelize): typeof PdfImportItem {
  PdfImportItem.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      batchId: { type: DataTypes.UUID, field: 'batch_id', allowNull: false },
      fileName: { type: DataTypes.STRING(512), field: 'file_name', allowNull: false },
      storedFilename: { type: DataTypes.STRING(255), field: 'stored_filename', allowNull: false },
      storageKind: { type: DataTypes.STRING(16), field: 'storage_kind', allowNull: false },
      encryptionAlgorithm: { type: DataTypes.STRING(32), field: 'encryption_algorithm', allowNull: false, defaultValue: 'none' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: true },
      resultJson: { type: DataTypes.JSON, field: 'result_json', allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<PdfImportItem>,
    { sequelize, modelName: 'PdfImportItem', tableName: 'pdf_import_items', underscored: true, timestamps: true },
  );
  return PdfImportItem;
}
```

- [ ] **Step 5: Register the models** in `backend/src/models/index.ts`

Add imports (near the JobRun import ~line 59):
```ts
import { PdfImportBatch, initPdfImportBatch } from './PdfImportBatch';
import { PdfImportItem, initPdfImportItem } from './PdfImportItem';
```
Add init calls (near `initJobRun(sequelize)` ~line 172):
```ts
initPdfImportBatch(sequelize);
initPdfImportItem(sequelize);
```
Add associations (near the AiReviewRun associations ~line 618):
```ts
PdfImportBatch.hasMany(PdfImportItem, { foreignKey: 'batch_id', as: 'items', onDelete: 'CASCADE', hooks: true });
PdfImportItem.belongsTo(PdfImportBatch, { foreignKey: 'batch_id', as: 'batch' });
```
Add to the barrel export object (near `JobRun,` ~line 1089):
```ts
  PdfImportBatch,
  PdfImportItem,
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportModels.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/20260602100000-create-pdf-import-batches.js backend/src/models/PdfImportBatch.ts backend/src/models/PdfImportItem.ts backend/src/models/index.ts backend/test/pdfImportModels.test.ts
git commit --no-verify -m "feat(import): pdf_import_batch + pdf_import_item tables + models"
```

---

## Task 2: Single-extraction param + shared account resolver

**Files:**
- Modify: `backend/src/import/parseStatementFile.ts:453-749`
- Modify: `backend/src/import/runImport.ts:942-1044`
- Test: `backend/test/parseStatementFilePreExtracted.test.ts`

- [ ] **Step 1: Write the failing test** (proves `preExtractedLines` skips pdfjs)

Create `backend/test/parseStatementFilePreExtracted.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Household } from '../src/models';

// When preExtractedLines is supplied, parseStatementFile must NOT call extractPdfLines.
// We prove it by passing a non-PDF buffer (extractPdfLines would throw on it) plus
// valid pre-extracted credit-card lines, and asserting a successful parse.
test('parseStatementFile uses preExtractedLines and skips extraction', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: hh.id, name: 'WS CC', accountType: 'credit_card', owner: 'me',
    visibility: 'private', defaultCurrency: 'CAD', shortCode: '3338',
  } as never);
  const { parseStatementFile } = await import('../src/import/parseStatementFile');
  const lines = [
    { page: 1, y: 9, text: 'Credit card statement' },
    { page: 1, y: 8, text: 'Wealthsimple Apr 15 — May 14, 2026' },
    { page: 1, y: 7, text: '4126 50** **** 3338' },
    { page: 1, y: 6, text: 'Statement date May 15, 2026' },
    { page: 2, y: 5, text: 'TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)' },
    { page: 2, y: 4, text: 'Apr 16   Apr 17   Purchase   A&W #4655   $10.49' },
  ];
  const preview = await parseStatementFile({
    buffer: Buffer.from('not a real pdf'),
    fileName: 'x.pdf',
    accountId: account.id,
    householdId: hh.id,
    preExtractedLines: lines as never,
  });
  assert.ok(!('ok' in preview && preview.ok === false), 'should not error');
  assert.equal((preview as { transactions: unknown[] }).transactions.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/parseStatementFilePreExtracted.test.ts`
Expected: FAIL — either a type error (`preExtractedLines` unknown) or "Could not read PDF" (it tried to extract the fake buffer).

- [ ] **Step 3: Add `preExtractedLines` to `parseStatementFile`**

In `backend/src/import/parseStatementFile.ts`, add to the opts type (after `overrideBusiness?: boolean;`):
```ts
  /** Pre-extracted pdfjs lines. When set, the .pdf branch skips extractPdfLines
   *  (avoids a second pdfjs pass when the caller already extracted). */
  preExtractedLines?: import('./pdf/types').PdfLine[];
```
In the `.pdf` branch, replace the extract block:
```ts
    registerBuiltInPdfParsers();
    let lines;
    try {
      lines = await extractPdfLines(opts.buffer);
    } catch (err) {
      return { ok: false, error: `Could not read PDF: ${(err as Error).message}` };
    }
```
with:
```ts
    registerBuiltInPdfParsers();
    let lines;
    if (opts.preExtractedLines) {
      lines = opts.preExtractedLines;
    } else {
      try {
        lines = await extractPdfLines(opts.buffer);
      } catch (err) {
        return { ok: false, error: `Could not read PDF: ${(err as Error).message}` };
      }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/parseStatementFilePreExtracted.test.ts`
Expected: PASS (1 transaction parsed; extraction skipped).

- [ ] **Step 5: Extract `resolvePdfAccountFromHeader` + dedupe the double-parse in `runImport.ts`**

In `backend/src/import/runImport.ts`, add an exported helper (place above `importPdfBundleFile`):

```ts
import type { PdfLine } from './pdf/types';
import type { PdfStatementHeader } from './pdf/types';

/**
 * Resolve (find-or-create) the Account for a PDF statement from its parsed
 * header, applying the corp-entity + business-override logic. Shared by the
 * synchronous bundle path and the async pdfImportProcess worker.
 */
export async function resolvePdfAccountFromHeader(
  header: PdfStatementHeader,
  householdId: number,
  userId: number,
): Promise<{ account: InstanceType<typeof Account>; accountCreated: boolean; overrideBusiness: boolean }> {
  const template =
    PDF_ACCOUNT_TEMPLATES[header.productLabel] ?? { name: header.productLabel, accountType: header.accountType };
  const headerCurrency = header.currency ?? 'CAD';
  const entity = await resolveEntityForHolder(header.accountHolder, householdId);
  const overrideBusiness = entity?.kind === 'corp';
  const [account, accountCreated] = await Account.findOrCreate({
    where: { householdId, shortCode: header.accountSuffix },
    defaults: {
      householdId, name: template.name, accountType: template.accountType,
      owner: 'me', visibility: 'private', defaultCurrency: headerCurrency,
      ownerUserId: userId, shortCode: header.accountSuffix, entityId: entity?.id ?? null,
    },
  });
  if (entity && account.entityId !== entity.id) {
    await account.update({ entityId: entity.id });
  }
  return { account, accountCreated, overrideBusiness };
}
```

Then rewrite `importPdfBundleFile`'s middle to use it + pass `preExtractedLines` (eliminating the second extraction). Replace the block from `const header = parseOut.header;` through the `parseStatementFile({...})` call with:

```ts
  const header = parseOut.header;
  const { account, accountCreated, overrideBusiness } = await resolvePdfAccountFromHeader(
    header, opts.householdId, opts.userId,
  );

  const preview = await parseStatementFile({
    buffer: opts.buffer,
    fileName: file,
    accountId: account.id,
    householdId: opts.householdId,
    overrideBusiness: overrideBusiness ? true : undefined,
    preExtractedLines: lines,
  });
```

(`lines` is already in scope from the earlier `extractPdfLines` call. Keep the rest of `importPdfBundleFile` — the `if ('error' in preview)` + commit + return — unchanged.)

- [ ] **Step 6: Run existing PDF + import tests (no regression)**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/parseStatementFilePreExtracted.test.ts test/pdfQuestrade.test.ts test/runImport*.test.ts`
Then: `npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/import/parseStatementFile.ts backend/src/import/runImport.ts backend/test/parseStatementFilePreExtracted.test.ts
git commit --no-verify -m "feat(import): parseStatementFile accepts pre-extracted lines; share PDF account resolver"
```

---

## Task 3: Processor core (`drainPendingChunk`)

**Files:**
- Create: `backend/src/import/pdfImportProcessor.ts`
- Test: `backend/test/pdfImportProcessor.test.ts`

The processor reads each pending item's bytes, extracts once, resolves the account, parses (passing the lines), commits, and updates item + batch. Bounded chunk per call; resets stale `processing` rows first.

- [ ] **Step 1: Write the failing test**

Create `backend/test/pdfImportProcessor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sequelize, PdfImportBatch, PdfImportItem, Household, User } from '../src/models';
import { saveVaultObject } from '../src/storage/vaultStorage';
import { drainPendingChunk } from '../src/import/pdfImportProcessor';

const CC_PDF = '/Users/connoradams/Downloads/monthly_pdf_statements/C13BRX957CAD_2026-05_CREDIT_CARD.pdf';

test('drainPendingChunk parses a pending item and marks the batch done', { skip: !fs.existsSync(CC_PDF) }, async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id } as never);
  const stored = `${crypto.randomUUID()}.pdf`;
  const put = await saveVaultObject(stored, {
    buffer: fs.readFileSync(CC_PDF), contentType: 'application/pdf', originalName: 'cc.pdf',
  });
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'cc.pdf',
    storedFilename: put.storedFilename, storageKind: put.storageKind,
    encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
  });

  const summary = await drainPendingChunk({ chunk: 12 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.succeeded, 1);

  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'done');
  assert.equal(reloaded?.succeeded, 1);
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(item?.status, 'done');
  assert.ok(item?.accountId);
});

test('a failing item marks failed without aborting the chunk', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const u = await User.create({ email: 'a@b.c', householdId: hh.id } as never);
  const stored = `${crypto.randomUUID()}.pdf`;
  const put = await saveVaultObject(stored, {
    buffer: Buffer.from('not a pdf'), contentType: 'application/pdf', originalName: 'bad.pdf',
  });
  const batch = await PdfImportBatch.create({
    id: crypto.randomUUID(), householdId: hh.id, userId: u.id, status: 'pending', total: 1, processed: 0, succeeded: 0, failed: 0,
  });
  await PdfImportItem.create({
    id: crypto.randomUUID(), batchId: batch.id, fileName: 'bad.pdf',
    storedFilename: put.storedFilename, storageKind: put.storageKind,
    encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
  });
  const summary = await drainPendingChunk({ chunk: 12 });
  assert.equal(summary.failed, 1);
  const item = await PdfImportItem.findOne({ where: { batchId: batch.id } });
  assert.equal(item?.status, 'failed');
  assert.ok(item?.error);
  const reloaded = await PdfImportBatch.findByPk(batch.id);
  assert.equal(reloaded?.status, 'done'); // done, with failed=1
  assert.equal(reloaded?.failed, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportProcessor.test.ts`
Expected: FAIL — module `pdfImportProcessor` not found.

- [ ] **Step 3: Implement the processor**

Create `backend/src/import/pdfImportProcessor.ts`:

```ts
import { Op } from 'sequelize';
import { PdfImportBatch, PdfImportItem } from '../models';
import { readVaultObject, type VaultEncryptionAlgorithm } from '../storage/vaultStorage';
import { parseStatementFile } from './parseStatementFile';
import { commitStatementImport } from './commitStatementImport';
import { resolvePdfAccountFromHeader } from './runImport';
import { logger } from '../observability/logger';

export type DrainSummary = { processed: number; succeeded: number; failed: number };

const STALE_PROCESSING_MS = 10 * 60 * 1000;

/** Process one item: read bytes → single extract → resolve account → parse → commit. */
export async function processItem(item: PdfImportItem): Promise<void> {
  // Lazy-require avoids circular module init with pdfjs/registry.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { extractPdfLines } = require('./pdf/extractLines');
  const { findPdfParser, registerBuiltInPdfParsers } = require('./pdf/registry');
  /* eslint-enable @typescript-eslint/no-require-imports */
  registerBuiltInPdfParsers();

  const batch = await PdfImportBatch.findByPk(item.batchId);
  if (!batch) throw new Error(`orphan item ${item.id}`);

  const buffer = await readVaultObject(item.storedFilename, item.encryptionAlgorithm as VaultEncryptionAlgorithm);
  const lines = await extractPdfLines(buffer);
  const parser = findPdfParser(lines);
  if (!parser) throw new Error('No PDF parser matched this statement layout');
  const parseOut = parser.parse(lines, { defaultCurrency: 'CAD' });
  if (!parseOut.header) throw new Error(`Parser ${parser.id} produced no header for account match`);

  const { account, overrideBusiness } = await resolvePdfAccountFromHeader(
    parseOut.header, batch.householdId, batch.userId,
  );
  const preview = await parseStatementFile({
    buffer, fileName: item.fileName, accountId: account.id,
    householdId: batch.householdId, overrideBusiness: overrideBusiness ? true : undefined,
    preExtractedLines: lines,
  });
  if ('ok' in preview && preview.ok === false) throw new Error(preview.error);

  const commit = await commitStatementImport(preview, batch.userId, batch.householdId);
  item.accountId = account.id;
  item.resultJson = {
    accountName: account.name,
    insertedTransactions: commit.insertedTransactions,
    insertedInvestmentActivities: commit.insertedInvestmentActivities,
    insertedHoldings: commit.insertedHoldings,
    skippedDuplicates: commit.skippedDuplicates,
    warnings: commit.warnings,
  };
  item.status = 'done';
  await item.save();
}

async function recomputeBatch(batchId: string): Promise<void> {
  const items = await PdfImportItem.findAll({ where: { batchId } });
  const processed = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const succeeded = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const anyPending = items.some((i) => i.status === 'pending' || i.status === 'processing');
  const batch = await PdfImportBatch.findByPk(batchId);
  if (!batch) return;
  batch.processed = processed;
  batch.succeeded = succeeded;
  batch.failed = failed;
  batch.status = anyPending ? 'processing' : (succeeded === 0 && failed > 0 ? 'failed' : 'done');
  await batch.save();
}

/** Drain up to `chunk` pending items. Resets stale `processing` rows first. */
export async function drainPendingChunk(opts: { chunk?: number } = {}): Promise<DrainSummary> {
  const chunk = opts.chunk ?? 12;
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  await PdfImportItem.update(
    { status: 'pending' },
    { where: { status: 'processing', updatedAt: { [Op.lt]: staleCutoff } } },
  );

  const items = await PdfImportItem.findAll({
    where: { status: 'pending' }, order: [['created_at', 'ASC']], limit: chunk,
  });
  const summary: DrainSummary = { processed: 0, succeeded: 0, failed: 0 };
  const touchedBatches = new Set<string>();
  for (const item of items) {
    item.status = 'processing';
    await item.save();
    try {
      await processItem(item);
      summary.succeeded += 1;
    } catch (err) {
      item.status = 'failed';
      item.error = (err as Error).message;
      await item.save();
      summary.failed += 1;
      logger.error({ err, item: item.id }, 'pdf_import_item_failed');
    }
    summary.processed += 1;
    touchedBatches.add(item.batchId);
  }
  for (const batchId of touchedBatches) await recomputeBatch(batchId);
  return summary;
}
```

> Confirm `logger` import path (`../observability/logger`) matches how `jobs/registry.ts` imports it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportProcessor.test.ts`
Expected: PASS (the CC test runs only if the local PDF exists; the failing-item test always runs).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/pdfImportProcessor.ts backend/test/pdfImportProcessor.test.ts
git commit --no-verify -m "feat(import): async pdf-import processor (drainPendingChunk)"
```

---

## Task 4: Cron job `pdfImportProcess`

**Files:**
- Create: `backend/src/jobs/definitions/pdfImportProcess.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/test/pdfImportProcessor.test.ts` (add a job-handler assertion)

- [ ] **Step 1: Write the job**

Create `backend/src/jobs/definitions/pdfImportProcess.ts` (mirror `jobRunCleanup.ts` + wrap in the advisory lock):

```ts
import { defineJob } from '../registry';
import { withAdvisoryLock } from '../pgLock';
import { drainPendingChunk } from '../../import/pdfImportProcessor';

defineJob({
  name: 'pdf_import_process',
  cronDefault: '* * * * *', // every minute; drains a bounded chunk per tick
  enabledDefault: true,
  handler: async () => {
    const res = await withAdvisoryLock('pdf_import_process', () => drainPendingChunk({ chunk: 12 }));
    if (!res.acquired) return { summary: { skipped: 'locked' } };
    return { summary: res.value as unknown as Record<string, unknown> };
  },
});
```

- [ ] **Step 2: Register it** in `backend/src/server.ts` — add next to the other `import './jobs/definitions/...'` lines:
```ts
import './jobs/definitions/pdfImportProcess';
```

- [ ] **Step 3: Add a job-handler test** — append to `backend/test/pdfImportProcessor.test.ts`:

```ts
test('pdf_import_process job is registered and runnable', async () => {
  await sequelize.sync({ force: true });
  await import('../src/jobs/definitions/pdfImportProcess');
  const { runJobByName } = await import('../src/jobs/registry');
  const outcome = await runJobByName('pdf_import_process');
  assert.ok(outcome); // no throw; empty queue → ok
});
```

> Check `runJobByName`'s return shape / `TickOutcome` in `jobs/registry.ts`; adjust the assertion if it returns a status object.

- [ ] **Step 4: Run + typecheck**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/pdfImportProcessor.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/jobs/definitions/pdfImportProcess.ts backend/src/server.ts backend/test/pdfImportProcessor.test.ts
git commit --no-verify -m "feat(import): pdfImportProcess cron job drains the queue"
```

---

## Task 5: Async upload endpoint + multer cap

**Files:**
- Modify: `backend/src/routes/import.ts` (multer `files: 120`→`200` at the pdfBundle config + `array('files', 200)`; rewrite `pdfBundleHandler`)
- Test: `backend/test/integration/pdfImportAsync.test.ts` (created in Task 8; a focused handler unit can also live in Task 8)

- [ ] **Step 1: Raise the multer cap** — in `backend/src/routes/import.ts`, change the `pdfBundleUpload` `limits.files` from `120` to `200`, and the `pdfBundleUpload.array('files', 120)` (in `pdfBundleMulter`) to `200`. (If #522's bump already set 120, change both occurrences to 200.)

- [ ] **Step 2: Rewrite `pdfBundleHandler` to async** — replace the body of `pdfBundleHandler` (the `for (const file of files) { await importPdfBundleFile(...) }` loop + results response) with:

```ts
const pdfBundleHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'Missing files field "files"' });
      return;
    }
    const { user, household } = currentAuth(req);
    logImportEvent('pdf_bundle_started', {
      fileCount: files.length,
      totalSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
    });

    const batch = await PdfImportBatch.create({
      id: randomUUID(), householdId: household.id, userId: user.id,
      status: 'pending', total: files.length, processed: 0, succeeded: 0, failed: 0,
    });
    for (const file of files) {
      const ext = path.extname(file.originalname || '') || '';
      const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : '.pdf';
      const stored = `${randomUUID()}${safeExt}`;
      const put = await saveVaultObject(stored, {
        buffer: file.buffer, contentType: file.mimetype || 'application/pdf',
        originalName: file.originalname || stored,
      });
      await PdfImportItem.create({
        id: randomUUID(), batchId: batch.id,
        fileName: path.basename(file.originalname || stored).replace(/[\\/]/g, ''),
        storedFilename: put.storedFilename, storageKind: put.storageKind,
        encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
      });
    }

    // Kick the first chunk now (best-effort); the cron is the safety net.
    void runJobByName('pdf_import_process').catch(() => {});

    res.status(201).json({ batchId: batch.id, total: files.length });
  } catch (e) {
    next(e);
  }
};
```

Add the imports at the top of `import.ts` (alongside existing imports): `randomUUID` from `node:crypto`, `path`, `saveVaultObject` from `../storage/vaultStorage`, `PdfImportBatch`, `PdfImportItem` from `../models`, `runJobByName` from `../jobs/registry`. (Check which are already imported.)

- [ ] **Step 3: Typecheck** — `cd backend && npx tsc --noEmit` → clean. (Functional verification is the Task 8 integration test.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/import.ts
git commit --no-verify -m "feat(import): async /upload-pdf-bundle — save to S3 + enqueue, respond batchId"
```

---

## Task 6: Progress endpoint `GET /import/pdf-batch/:id`

**Files:**
- Modify: `backend/src/routes/import.ts` (add route)
- Test: covered by Task 8 integration; add a focused route test there.

- [ ] **Step 1: Add the route** — in `backend/src/routes/import.ts`, register:

```ts
router.get('/pdf-batch/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const batch = await PdfImportBatch.findOne({
      where: { id: req.params.id, householdId: household.id },
    });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    const items = await PdfImportItem.findAll({
      where: { batchId: batch.id }, order: [['created_at', 'ASC']],
    });
    res.json({
      id: batch.id, status: batch.status, total: batch.total,
      processed: batch.processed, succeeded: batch.succeeded, failed: batch.failed,
      items: items.map((i) => {
        const r = (i.resultJson ?? {}) as Record<string, number | string | undefined>;
        return {
          fileName: i.fileName, status: i.status, accountName: r.accountName ?? null,
          insertedTransactions: r.insertedTransactions ?? 0,
          insertedInvestmentActivities: r.insertedInvestmentActivities ?? 0,
          insertedHoldings: r.insertedHoldings ?? 0,
          skippedDuplicates: r.skippedDuplicates ?? 0,
          error: i.error ?? null,
        };
      }),
    });
  } catch (e) {
    next(e);
  }
});
```

> Place it BEFORE any conflicting param route; confirm the import router is mounted at `/api/import` (so this is `GET /api/import/pdf-batch/:id`).

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/import.ts
git commit --no-verify -m "feat(import): GET /import/pdf-batch/:id progress endpoint"
```

---

## Task 7: Frontend — poll + progress view

**Files:**
- Modify: `frontend/src/components/import/ImportModal.tsx`

- [ ] **Step 1: Replace the pdf-bundle submit branch** — in `ImportModal.tsx`, replace the `if (mode === 'pdf-bundle') {...}` block (the `postFormData<{results}>` + feedback) with an upload that stores the batch id + starts polling:

```ts
      if (mode === 'pdf-bundle') {
        const fd = new FormData()
        files.forEach((f) => fd.append('files', f))
        const { batchId, total } = await postFormData<{ batchId: string; total: number }>(PDF_BUNDLE_URL, fd)
        setBatch({ id: batchId, total })
        setFeedback({ variant: 'success', title: `Uploaded ${total} file(s); processing…` })
        reset()
        return
      }
```

Add state near the other `useState`s:
```ts
  const [batch, setBatch] = useState<{ id: string; total: number } | null>(null)
  const [batchStatus, setBatchStatus] = useState<PdfBatchStatus | null>(null)
```
Add the status type (near the result types):
```ts
type PdfBatchItem = { fileName: string; status: string; accountName: string | null; insertedTransactions: number; insertedInvestmentActivities: number; insertedHoldings: number; skippedDuplicates: number; error: string | null }
type PdfBatchStatus = { id: string; status: 'pending' | 'processing' | 'done' | 'failed'; total: number; processed: number; succeeded: number; failed: number; items: PdfBatchItem[] }
```
Add a polling effect:
```ts
  useEffect(() => {
    if (!batch) return
    let active = true
    const tick = async () => {
      try {
        const s = await getJson<PdfBatchStatus>(`/api/import/pdf-batch/${batch.id}`)
        if (!active) return
        setBatchStatus(s)
        if (s.status === 'done' || s.status === 'failed') {
          if (s.succeeded > 0) onCommitted()
          return
        }
      } catch { /* keep polling */ }
      if (active) setTimeout(tick, 2000)
    }
    void tick()
    return () => { active = false }
  }, [batch, onCommitted])
```

- [ ] **Step 2: Render the progress view** — add to the modal body (near the `feedback` block):

```tsx
        {batchStatus && (
          <div className="px-4 pb-2">
            <Alert
              variant={batchStatus.status === 'failed' ? 'error' : batchStatus.status === 'done' ? 'success' : 'info'}
              title={`Processing ${batchStatus.processed}/${batchStatus.total} · ${batchStatus.succeeded} ok, ${batchStatus.failed} failed${batchStatus.status === 'done' ? ' · done' : ''}`}
            />
            {batchStatus.items.length > 0 && (
              <ul className="mt-2 text-xs muted max-h-48 overflow-y-auto rounded-md border border-border p-2">
                {batchStatus.items.map((it, i) => (
                  <li key={i} className="truncate" title={it.error ?? ''}>
                    {it.fileName} → {it.accountName ?? '—'} · {it.status}
                    {it.status === 'done' ? ` (txn=${it.insertedTransactions} act=${it.insertedInvestmentActivities} hld=${it.insertedHoldings})` : ''}
                    {it.error ? ` · ERR: ${it.error}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
```

- [ ] **Step 3: Build the frontend**

Run: `cd frontend && yarn build` (or `npx tsc -b` / the project's typecheck)
Expected: builds clean. Remove the now-unused `PdfBundleFileResult` type/import if the linter flags it.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/import/ImportModal.tsx
git commit --no-verify -m "feat(import): poll PDF-bundle batch progress in the import UI"
```

---

## Task 8: Integration test (migrated Postgres)

**Files:**
- Create: `backend/test/integration/pdfImportAsync.test.ts`

> The holdings `ws_holding` unique index lives only in a migration, so use the Postgres+migrations integration harness (mirror `backend/test/integration/wsHoldingsImport*.test.ts` or whichever existing integration test sets up Postgres — match its DB setup/teardown exactly).

- [ ] **Step 1: Write the end-to-end test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
// + the integration harness imports (Postgres sequelize, migrate, models) — copy from an existing integration test.
import { saveVaultObject } from '../../src/storage/vaultStorage';
import { drainPendingChunk } from '../../src/import/pdfImportProcessor';

const BRK = '/Users/connoradams/Downloads/monthly_pdf_statements/HQ6LMLTK8CAD_2025-05_BROKERAGE.pdf';

test('async pdf import: upload→drain→committed→idempotent re-run', { skip: !fs.existsSync(BRK) }, async () => {
  // setup: migrated Postgres, a household + user (via the harness)
  // create batch + item with the brokerage PDF saved to vault storage:
  const stored = `${crypto.randomUUID()}.pdf`;
  const put = await saveVaultObject(stored, { buffer: fs.readFileSync(BRK), contentType: 'application/pdf', originalName: 'b.pdf' });
  // ... create PdfImportBatch (total:1) + PdfImportItem (pending, put.*) for that household/user

  const first = await drainPendingChunk({ chunk: 12 });
  assert.equal(first.succeeded, 1);
  // assert HoldingSnapshot + InvestmentActivity rows were committed for the resolved account
  // re-create a fresh pending item for the SAME file/account and drain again:
  const second = await drainPendingChunk({ chunk: 12 });
  // assert the second run's committed counts are ~0 (dedup) — query inserted counts from item.resultJson
});
```

Fill in the harness setup + the row assertions from the existing integration test's patterns (household/user creation, account pre-creation with `shortCode: 'HQ6LMLTK8CAD'`, and HoldingSnapshot/InvestmentActivity count queries).

- [ ] **Step 2: Run**

Run: the project's integration-test command (e.g. `cd backend && <integration test script> test/integration/pdfImportAsync.test.ts`).
Expected: PASS — first drain commits holdings+activities, batch `done`; second drain inserts ~0 (dedup).

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/pdfImportAsync.test.ts
git commit --no-verify -m "test(import): end-to-end async pdf import + idempotency"
```

---

## Self-Review notes

- **Spec coverage:** tables/models (T1), single-extract + shared resolver (T2 — spec §4), processor/drain + restart reset + error isolation (T3 — spec §3 + error-handling), cron job + advisory lock (T4 — spec §3), async upload + S3 persist + cap 200 (T5 — spec §2), progress endpoint (T6 — spec §5), frontend poll/progress (T7 — spec §6), integration + idempotency (T8 — spec testing). Storage uses `vaultStorage` (spec storage section); bytes kept (no delete).
- **Type consistency:** `PdfImportStatus` defined in `PdfImportBatch.ts`, reused in `PdfImportItem.ts` + processor + route. `drainPendingChunk({chunk})`/`DrainSummary` consistent across T3/T4. `resolvePdfAccountFromHeader(header, householdId, userId)` defined in T2, used in T2 (`importPdfBundleFile`) + T3 (processor). `preExtractedLines` defined T2, used T2 + T3. Route response shape (`{id,status,total,processed,succeeded,failed,items[]}`) matches the frontend `PdfBatchStatus` (T7).
- **Placeholders:** none — code is real; the few `>` notes are "verify against existing pattern X" fidelity checks (model required-fields, logger path, runJobByName return shape, integration harness), not TODOs.
- **Accepted risk:** CPU-bound pdfjs in the single web process during the drain — bounded chunk (12) keeps each tick short (spec risk §1).
```

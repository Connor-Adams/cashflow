import { Op } from 'sequelize';
import { PdfImportBatch, PdfImportItem } from '../models';
import { readVaultObject, type VaultEncryptionAlgorithm } from '../storage/vaultStorage';
import { parseStatementFile } from './parseStatementFile';
import { commitStatementImport } from './commitStatementImport';
import { resolvePdfAccountFromHeader } from './runImport';
import { logger } from '../observability/logger';
import { syncTransactionEntityIds } from '../tax/services/syncTransactionEntityIds';

export type DrainSummary = { processed: number; succeeded: number; failed: number; skipped: number };

const STALE_PROCESSING_MS = 10 * 60 * 1000;

/** Process one item: read bytes → single extract → resolve account → parse → commit. */
export async function processItem(item: PdfImportItem): Promise<'done' | 'skipped'> {
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

  // Narrow the union: at this point ok-false branch is excluded above.
  const statementPreview = preview as Exclude<typeof preview, { ok: false }>;
  const commit = await commitStatementImport(statementPreview, batch.userId, batch.householdId);
  item.accountId = account.id;
  // resultJson is typed CreationOptional<unknown | null>; cast through unknown to satisfy the brand.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  item.resultJson = {
    accountName: account.name,
    insertedTransactions: commit.insertedTransactions,
    insertedInvestmentActivities: commit.insertedInvestmentActivities,
    insertedHoldings: commit.insertedHoldings,
    skippedDuplicates: commit.skippedDuplicates,
    warnings: commit.warnings,
  } as unknown as typeof item.resultJson;
  item.status = 'done';
  item.reason = null;
  await item.save();
  return 'done';
}

export async function recomputeBatch(batchId: string): Promise<void> {
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

/** Drain pending items within a time budget. Resets stale `processing` rows first. */
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

  const summary: DrainSummary = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
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
  // Heal step: re-assert transaction.entity_id parity after any account→entity
  // changes that the import may have triggered. Best-effort: a failure must not
  // fail the drain (mirrors the post-bundle heal in restoreBundle / routes/import).
  if (touchedBatches.size > 0) {
    const batches = await PdfImportBatch.findAll({ where: { id: [...touchedBatches] } });
    for (const hid of new Set(batches.map((bb) => bb.householdId))) {
      try {
        await syncTransactionEntityIds(hid);
      } catch (err) {
        logger.error({ err, hid }, 'pdf_import_entity_sync_failed');
      }
    }
  }
  const pendingRemaining = await PdfImportItem.count({ where: { status: 'pending' } });
  return { ...summary, pendingRemaining };
}

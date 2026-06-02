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

  // Narrow the union: at this point ok-false branch is excluded above.
  const statementPreview = preview as Exclude<typeof preview, { ok: false }>;
  const commit = await commitStatementImport(statementPreview, batch.userId, batch.householdId);
  item.accountId = account.id;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (item as any).resultJson = {
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
  batch.status = anyPending ? 'processing' : 'done';
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

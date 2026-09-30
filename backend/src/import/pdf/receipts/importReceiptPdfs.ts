/**
 * Batching layer for receipt-PDF import.
 *
 * The per-file pipeline (extract -> parse -> persist -> match transactions)
 * already exists on the single-file route; this module owns only what batching
 * adds: isolating one bad file from the rest, reporting per-file outcomes, and
 * keeping the run sequential.
 *
 * Sequential is deliberate. Two uploads of the same receipt dedupe on
 * (householdId, dedupeKey); running them concurrently races findOrCreate and
 * can produce a duplicate order, so files are processed one at a time.
 */

export type ReceiptFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

/** What the per-file worker returns. `created: false` means dedupe matched an existing order. */
export type ImportOneResult = {
  created: boolean;
  parserId: string;
  orderId: number;
  warnings: string[];
  linksCreated: number;
  linksUpdated: number;
};

export type ReceiptImportStatus = 'imported' | 'duplicate' | 'failed';

export type ReceiptImportResult = {
  filename: string;
  status: ReceiptImportStatus;
  parserId?: string;
  orderId?: number;
  warnings?: string[];
  linksCreated?: number;
  linksUpdated?: number;
  error?: string;
};

export type ReceiptImportSummary = {
  total: number;
  imported: number;
  duplicates: number;
  failed: number;
  results: ReceiptImportResult[];
};

function looksLikePdf(file: ReceiptFile): boolean {
  const mime = (file.mimetype || '').toLowerCase();
  return mime === 'application/pdf' || /\.pdf$/i.test(file.originalname);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Import a batch of receipt PDFs, one at a time, never letting a single bad
 * file fail the batch. `importOne` is injected so the batching behaviour is
 * testable without pdfjs or a database.
 */
export async function importReceiptPdfsBulk(
  files: ReceiptFile[],
  importOne: (file: ReceiptFile) => Promise<ImportOneResult>,
): Promise<ReceiptImportSummary> {
  const results: ReceiptImportResult[] = [];

  for (const file of files) {
    if (!looksLikePdf(file)) {
      results.push({
        filename: file.originalname,
        status: 'failed',
        error: 'only application/pdf uploads are supported',
      });
      continue;
    }
    try {
      const r = await importOne(file);
      results.push({
        filename: file.originalname,
        status: r.created ? 'imported' : 'duplicate',
        parserId: r.parserId,
        orderId: r.orderId,
        warnings: r.warnings,
        linksCreated: r.linksCreated,
        linksUpdated: r.linksUpdated,
      });
    } catch (e) {
      results.push({ filename: file.originalname, status: 'failed', error: messageOf(e) });
    }
  }

  return {
    total: results.length,
    imported: results.filter((r) => r.status === 'imported').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

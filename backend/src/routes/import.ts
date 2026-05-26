import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { listImportProfiles } from '../import/csvProfiles';
import { PREVIEW_MAX_ROWS } from '../import/previewImport';
import {
  runImport,
  importCsvFile,
  importWsBundleFile,
  importWsHoldingsFile,
  importPdfBundleFile,
  type BundleFileResult,
  type PdfBundleFileResult,
} from '../import/runImport';
import { parseStatementFile } from '../import/parseStatementFile';
import { consumeStatementPreview } from '../import/statementPreviewStore';
import { commitStatementImport } from '../import/commitStatementImport';
import { ImportHistory } from '../models';
import { importUploadLimiter } from './importRateLimit';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  recordAudit,
} from '../audit/log';
import {
  aggregateBatchHealth,
  aggregateImportHealth,
} from '../summary/importConfidence';
import type { LogFields } from '../observability/logger';
import { logger } from '../observability/logger';

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 120 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(csv|pdf)$/i.test(file.originalname)) {
      const e = new Error('Only .csv and .pdf files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(csv|ofx|qfx|pdf)$/i.test(file.originalname)) {
      const e = new Error('Only .csv, .ofx, .qfx, and .pdf files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

// Higher per-request file count for the Wealthsimple bundle drop — a full
// 2-year archive across 8 accounts produces ~100+ CSVs. CSV-only filter.
const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 120 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      const e = new Error('Only .csv files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

// PDF bundle drop (RBC, CIBC, Questrade). PDF-only, mirrors Wealthsimple
// bundle limits (20 files, 15 MB each — matches statementUpload).
const pdfBundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.pdf')) {
      const e = new Error('Only .pdf files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

// Wealthsimple holdings/positions report is always a single CSV (one report
// covers all accounts).  Cap at 5 MB; tight `files: 1` so the route fails
// loudly if the frontend ever tries to multi-attach by mistake.
const holdingsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      const e = new Error('Only .csv files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

const router = Router();

function logImportEvent(
  event: string,
  details: LogFields
): void {
  logger.info(details, `import_${event}`);
}

router.get('/profiles', (_req, res) => {
  res.json([
    {
      id: 'auto',
      label: 'Automatic',
      hint: 'Detect from your CSV columns and sample rows (best for raw card exports).',
    },
    ...listImportProfiles(),
  ]);
});

router.post('/run', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const profileId = (req.body as { profileId?: string } | undefined)?.profileId;
    logImportEvent('folder_run_started', {
      profileId: profileId ?? 'auto',
    });
    const result = await runImport({ profileId, householdId: household.id, userId: user.id });
    const importedCount = result.results.filter((row) => {
      if (!row || typeof row !== 'object') return false;
      if ('skipped' in row && row.skipped === true) return false;
      return true;
    }).length;
    const skippedCount = result.results.length - importedCount;
    logImportEvent('folder_run_completed', {
      profileId: profileId ?? 'auto',
      filesSeen: result.results.length,
      filesImported: importedCount,
      filesSkipped: skippedCount,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post(
  '/preview',
  importUploadLimiter,
  (req, res, next) => {
    statementUpload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const accountIdRaw = (req.body as { accountId?: string }).accountId;
      if (accountIdRaw === undefined || accountIdRaw === null || accountIdRaw === '') {
        res.status(400).json({
          error:
            'accountId is required (create an account first, then pick it here)',
        });
        return;
      }
      const accountId = parseInt(String(accountIdRaw), 10);
      if (Number.isNaN(accountId) || accountId < 1) {
        res.status(400).json({ error: 'accountId must be a positive integer' });
        return;
      }
      const profileId =
        (req.body as { profileId?: string }).profileId ?? 'auto';
      logImportEvent('preview_started', {
        fileName: req.file.originalname,
        accountId,
        profileId,
        fileSizeBytes: req.file.size,
      });

      const result = await parseStatementFile({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        profileId,
        accountId,
        householdId: currentAuth(req).household.id,
      });
      if ('error' in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      const preview = result;
      logImportEvent('preview_completed', {
        fileName: req.file.originalname,
        accountId,
        profileId,
        usedProfileId: preview.usedProfileId,
        profileInferred: preview.profileInferred,
        rowCount: preview.rows?.length ?? 0,
      });
      res.json({ ...preview, previewRowLimit: PREVIEW_MAX_ROWS });
    } catch (e) {
      next(e);
    }
  }
);

router.post('/commit', async (req, res, next) => {
  try {
    const previewToken = String((req.body as { previewToken?: string })?.previewToken ?? '').trim();
    if (!previewToken) {
      res.status(400).json({ error: 'previewToken is required' });
      return;
    }
    const preview = consumeStatementPreview(previewToken);
    if (!preview) {
      res.status(404).json({ error: 'Preview expired or not found. Preview the file again.' });
      return;
    }
    const { user, household } = currentAuth(req);
    if (preview.accountId == null) {
      res.status(400).json({ error: 'Preview is missing accountId' });
      return;
    }
    if (household.id == null) {
      res.status(401).json({ error: 'Missing household' });
      return;
    }
    const result = await commitStatementImport(preview, user.id, household.id);
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.ImportCommitted,
      entityType: AUDIT_ENTITY_TYPES.Import,
      entityId: null,
      summary: `Imported ${result.inserted} row(s) from ${result.file}`,
      metadata: {
        file: result.file,
        batchLabel: result.batchLabel,
        inserted: result.inserted,
        insertedTransactions: result.insertedTransactions,
        insertedInvestmentActivities: result.insertedInvestmentActivities,
        insertedHoldings: result.insertedHoldings,
        skippedDuplicates: result.skippedDuplicates,
        rowErrors: result.rowErrors,
        parseErrors: result.parseErrors,
        usedParser: result.usedParser,
        usedProfileId: result.usedProfileId,
      },
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post(
  '/upload',
  importUploadLimiter,
  (req, res, next) => {
    // Multer's Request type can disagree with root @types/express (nested deps); runtime is correct.
    csvUpload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const accountId = (req.body as { accountId?: string }).accountId;
      if (accountId === undefined || accountId === null || accountId === '') {
        res.status(400).json({
          error:
            'accountId is required (create an account first, then pick it here)',
        });
        return;
      }
      const batchLabel =
        (req.body as { batchLabel?: string }).batchLabel &&
        String((req.body as { batchLabel?: string }).batchLabel).trim()
          ? String((req.body as { batchLabel?: string }).batchLabel).trim()
          : null;
      const profileId =
        (req.body as { profileId?: string }).profileId ?? 'auto';
      logImportEvent('upload_started', {
        fileName: req.file.originalname,
        accountId: parseInt(String(accountId), 10),
        batchLabel,
        profileId,
        fileSizeBytes: req.file.size,
      });

      const { user, household } = currentAuth(req);
      const result = await importCsvFile({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        accountId,
        batchLabel,
        profileId,
        householdId: household.id,
        userId: user.id,
      });
      logImportEvent('upload_completed', {
        fileName: req.file.originalname,
        accountId: parseInt(String(accountId), 10),
        batchLabel,
        profileId,
        usedProfileId:
          result && typeof result === 'object' ? result.usedProfileId : undefined,
        profileInferred:
          result && typeof result === 'object' ? result.profileInferred : undefined,
        inserted: result && typeof result === 'object' ? result.inserted : undefined,
        skipped:
          result && typeof result === 'object' ? (result as Record<string, unknown>).skipped : undefined,
        reason: result && typeof result === 'object' ? (result as Record<string, unknown>).reason : undefined,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/upload-many',
  importUploadLimiter,
  (req, res, next) => {
    csvUpload.array('files', 120)(req as never, res as never, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Missing files field "files"' });
        return;
      }
      const accountId = (req.body as { accountId?: string }).accountId;
      if (accountId === undefined || accountId === null || accountId === '') {
        res.status(400).json({
          error:
            'accountId is required (create an account first, then pick it here)',
        });
        return;
      }
      const batchLabel =
        (req.body as { batchLabel?: string }).batchLabel &&
        String((req.body as { batchLabel?: string }).batchLabel).trim()
          ? String((req.body as { batchLabel?: string }).batchLabel).trim()
          : null;
      const profileId =
        (req.body as { profileId?: string }).profileId ?? 'auto';
      const { user, household } = currentAuth(req);

      logImportEvent('multi_upload_started', {
        fileCount: files.length,
        accountId: parseInt(String(accountId), 10),
        batchLabel,
        profileId,
        totalSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      });

      // Per-file try/catch so a single throw (DB constraint, parser
      // crash, etc.) never kills the whole batch response. Every file
      // gets a result row; the frontend's per-file table depends on
      // the full results array for partial-failure visibility.
      const results: unknown[] = [];
      for (const file of files) {
        try {
          const result = await importCsvFile({
            buffer: file.buffer,
            fileName: file.originalname,
            accountId,
            batchLabel,
            profileId,
            householdId: household.id,
            userId: user.id,
          });
          results.push(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logImportEvent('multi_upload_file_failed', {
            file: file.originalname,
            error: message,
          });
          results.push({
            file: file.originalname,
            skipped: true,
            reason: 'error',
            error: message,
          });
        }
      }

      logImportEvent('multi_upload_completed', {
        fileCount: files.length,
        accountId: parseInt(String(accountId), 10),
        batchLabel,
        profileId,
        importedFiles: results.filter((row) => {
          if (!row || typeof row !== 'object') return false;
          if ('skipped' in row && row.skipped === true) return false;
          return true;
        }).length,
      });

      res.json({ results });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/upload-bundle',
  importUploadLimiter,
  (req, res, next) => {
    bundleUpload.array('files', 120)(req as never, res as never, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Missing files field "files"' });
        return;
      }
      const { user, household } = currentAuth(req);
      logImportEvent('bundle_started', {
        fileCount: files.length,
        totalSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      });

      // Per-file try/catch so a single throw (e.g. a DB constraint
      // violation that bubbled past the savepoint, an unexpected parser
      // error) never kills the whole bundle response. Every file gets a
      // result row; the response always includes the full `results`
      // array, which the frontend's per-file table relies on for
      // visibility into partial failures.
      const results: BundleFileResult[] = [];
      for (const file of files) {
        try {
          const result = await importWsBundleFile({
            buffer: file.buffer,
            fileName: file.originalname,
            householdId: household.id,
            userId: user.id,
          });
          results.push(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logImportEvent('bundle_file_failed', {
            file: file.originalname,
            error: message,
          });
          results.push({
            file: file.originalname,
            wsid: null,
            accountId: null,
            accountName: null,
            accountCreated: false,
            inserted: 0,
            insertedTransactions: 0,
            insertedInvestmentActivities: 0,
            skippedDuplicates: 0,
            rowErrors: 0,
            parseErrors: [],
            warnings: [],
            error: message,
          });
        }
      }

      const accountsCreated = results.filter((r) => r.accountCreated).length;
      const filesImported = results.filter((r) => !r.error).length;
      logImportEvent('bundle_completed', {
        fileCount: files.length,
        filesImported,
        accountsCreated,
      });

      res.json({ results });
    } catch (e) {
      next(e);
    }
  },
);

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

    const results: PdfBundleFileResult[] = [];
    for (const file of files) {
      try {
        const result = await importPdfBundleFile({
          buffer: file.buffer,
          fileName: file.originalname,
          householdId: household.id,
          userId: user.id,
        });
        results.push(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logImportEvent('pdf_bundle_file_failed', {
          file: file.originalname,
          error: message,
        });
        results.push({
          file: file.originalname,
          accountSuffix: null,
          productLabel: null,
          accountId: null,
          accountName: null,
          accountCreated: false,
          inserted: 0,
          insertedTransactions: 0,
          insertedInvestmentActivities: 0,
          insertedHoldings: 0,
          skippedDuplicates: 0,
          rowErrors: 0,
          parseErrors: [],
          warnings: [],
          error: message,
        });
      }
    }

    const accountsCreated = results.filter((r) => r.accountCreated).length;
    const filesImported = results.filter((r) => !r.error).length;
    logImportEvent('pdf_bundle_completed', {
      fileCount: files.length,
      filesImported,
      accountsCreated,
    });

    res.json({ results });
  } catch (e) {
    next(e);
  }
};

const pdfBundleMulter = (req: Request, res: Response, next: NextFunction) => {
  pdfBundleUpload.array('files', 20)(req as never, res as never, (err: unknown) => {
    if (err) {
      next(err);
      return;
    }
    next();
  });
};

router.post('/upload-pdf-bundle', importUploadLimiter, pdfBundleMulter, pdfBundleHandler);

router.post(
  '/upload-holdings',
  importUploadLimiter,
  (req, res, next) => {
    holdingsUpload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const { user, household } = currentAuth(req);
      logImportEvent('holdings_started', {
        fileName: req.file.originalname,
        fileSizeBytes: req.file.size,
      });

      const result = await importWsHoldingsFile({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        householdId: household.id,
        userId: user.id,
      });

      logImportEvent('holdings_completed', {
        fileName: req.file.originalname,
        statementDate: result.statementDate,
        totalRows: result.totalRows,
        inserted: result.inserted,
        updated: result.updated,
        skippedUnknownAccount: result.skippedUnknownAccount,
        accountsAffected: result.accountsAffected,
        errors: result.errors.length,
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

router.get('/history', async (req, res, next) => {
  try {
    const rows = await ImportHistory.findAll({
      where: householdWhere(req),
      order: [['startedAt', 'DESC']],
      limit: 50,
    });
    // Enrich each ImportHistory row with per-batch confidence counts (#214)
    // so the history table can render clean / needs-review badges without a
    // second round-trip per batch. A single grouped query over
    // `import_batch + import_confidence` keeps this O(rows-in-scope).
    const batchLabels = rows.map((r) => r.batchLabel).filter(Boolean);
    const batchHealth = await aggregateBatchHealth({
      householdScope: visibleTransactionWhere(req),
      currency: null,
      batchLabels,
    });
    const enriched = rows.map((row) => {
      const json = row.toJSON() as Record<string, unknown>;
      const health = batchHealth.get(row.batchLabel);
      json.cleanCount = health?.clean ?? 0;
      json.needsReviewCount = health?.needsReview ?? 0;
      json.unknownCount = health?.unknown ?? 0;
      return json;
    });
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/import/health?currency=CAD
 *
 * Aggregate import-confidence health for the active household (#214). Returns
 * the count of 'clean', 'needs_review', and legacy 'unknown' transactions, the
 * clean-percent ratio, and per-flag counts. Drives the ImportHealthTile on
 * the dashboard.
 */
router.get('/health', async (req, res, next) => {
  try {
    const currency = normalizeImportHealthCurrency(req.query.currency);
    const result = await aggregateImportHealth({
      householdScope: visibleTransactionWhere(req),
      currency,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

function normalizeImportHealthCurrency(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

export default router;

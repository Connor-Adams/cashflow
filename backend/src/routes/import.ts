import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { listImportProfiles } from '../import/csvProfiles';
import { PREVIEW_MAX_ROWS } from '../import/previewImport';
import {
  runImport,
  importCsvFile,
  importWsBundleFile,
  importWsHoldingsFile,
  type BundleFileResult,
} from '../import/runImport';
import { parseStatementFile } from '../import/parseStatementFile';
import { consumeStatementPreview } from '../import/statementPreviewStore';
import { commitStatementImport } from '../import/commitStatementImport';
import {
  executeRollback,
  previewRollback,
  RollbackBlockedError,
} from '../import/rollbackImportBatch';
import { sequelize, Account, ImportHistory, PdfImportBatch, PdfImportItem } from '../models';
import { saveVaultObject, deleteVaultObject } from '../storage/vaultStorage';
import { runJobByName } from '../jobs/registry';
import { importUploadLimiter } from './importRateLimit';
import { aiSuggestLimiter } from './aiRateLimit';
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

// PDF bundle drop (RBC, CIBC, Questrade, Wealthsimple). PDF-only; 200-file
// limit supports multi-year, multi-account statement archives; bytes are
// saved to vault storage (S3/disk) before responding — no parse-in-request.
const pdfBundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 200 },
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

    // Phase 1: save all bytes to vault storage BEFORE touching the DB.
    // If any save fails, clean up the already-saved ones and rethrow so
    // next(e) handles it — no batch or item rows are created.
    type SavedFile = { put: Awaited<ReturnType<typeof saveVaultObject>>; fileName: string };
    const saved: SavedFile[] = [];
    try {
      for (const file of files) {
        const ext = path.extname(file.originalname || '') || '';
        const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : '.pdf';
        const stored = `${randomUUID()}${safeExt}`;
        const put = await saveVaultObject(stored, {
          buffer: file.buffer, contentType: file.mimetype || 'application/pdf',
          originalName: file.originalname || stored,
        });
        saved.push({
          put,
          fileName: path.basename(file.originalname || stored).replace(/[\\/]/g, ''),
        });
      }
    } catch (saveErr) {
      // Best-effort cleanup of already-saved bytes, then rethrow.
      await Promise.all(
        saved.map(({ put }) => deleteVaultObject(put.storedFilename).catch(() => {}))
      );
      throw saveErr;
    }

    // Phase 2: create the batch + all items in a single DB transaction so
    // either all rows land or none do. total is set from files.length which
    // is known before the transaction, so it will always equal the item count.
    const batch = await sequelize.transaction(async (t) => {
      const b = await PdfImportBatch.create({
        id: randomUUID(), householdId: household.id, userId: user.id,
        status: 'pending', total: files.length, processed: 0, succeeded: 0, failed: 0,
      }, { transaction: t });
      for (const { put, fileName } of saved) {
        await PdfImportItem.create({
          id: randomUUID(), batchId: b.id,
          fileName,
          storedFilename: put.storedFilename, storageKind: put.storageKind,
          encryptionAlgorithm: put.encryptionAlgorithm, status: 'pending',
        }, { transaction: t });
      }
      return b;
    });

    // Phase 3: kick the processor and respond.
    void runJobByName('pdf_import_process').catch(() => {});
    logImportEvent('pdf_bundle_queued', { batchId: batch.id, total: files.length });
    res.status(201).json({ batchId: batch.id, total: files.length });
  } catch (e) {
    next(e);
  }
};

const pdfBundleMulter = (req: Request, res: Response, next: NextFunction) => {
  pdfBundleUpload.array('files', 200)(req as never, res as never, (err: unknown) => {
    if (err) {
      next(err);
      return;
    }
    next();
  });
};

router.post('/upload-pdf-bundle', importUploadLimiter, pdfBundleMulter, pdfBundleHandler);

/**
 * GET /api/import/pdf-batch/:id
 *
 * Progress endpoint for an async PDF-bundle import batch. Returns the batch
 * status + per-item counts so the frontend can poll progress without polling
 * the DB directly. Scoped to the authenticated household — a batch belonging
 * to another household returns 404, not 200, to prevent cross-household leaks.
 */
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
    const enriched = rows.map((row) => enrichBatchRow(row, batchHealth));
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/import/batches?limit=100&offset=0
 *
 * Import batch manager list (#231). Returns ImportHistory rows for the active
 * household, enriched with per-batch confidence counts and ordered most
 * recent first. Supports paging beyond the 50-row /api/import/history cap so
 * the batch manager can scroll history end-to-end.
 *
 * Each row also exposes the structured account / profile / count fields
 * captured at import time (NULL on legacy rows).
 *
 * Rate-limited with aiSuggestLimiter so an unauthenticated abuse path can't
 * tag a (otherwise auth'd) household with cheap DB hits. CodeQL flags any
 * unrate-limited authenticated DB route as high severity.
 */
router.get('/batches', aiSuggestLimiter, async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);
    const total = await ImportHistory.count({ where: householdWhere(req) });
    const rows = await ImportHistory.findAll({
      where: householdWhere(req),
      order: [['startedAt', 'DESC']],
      limit,
      offset,
    });
    const batchLabels = rows.map((r) => r.batchLabel).filter(Boolean);
    const batchHealth = await aggregateBatchHealth({
      householdScope: visibleTransactionWhere(req),
      currency: null,
      batchLabels,
    });
    const enriched = rows.map((row) => enrichBatchRow(row, batchHealth));
    res.json({ total, limit, offset, batches: enriched });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/import/batches/:id
 *
 * Batch detail endpoint (#231). Returns the full ImportHistory row, account
 * snapshot, profile id, per-stage counts, and confidence breakdown so the
 * frontend doesn't have to find-by-label inside the paginated list.
 *
 * Rate-limited like /batches above — same CodeQL guidance.
 */
router.get('/batches/:id', aiSuggestLimiter, async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ error: 'Batch id must be a positive integer' });
      return;
    }
    const row = await ImportHistory.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    const batchHealth = await aggregateBatchHealth({
      householdScope: visibleTransactionWhere(req),
      currency: null,
      batchLabels: [row.batchLabel],
    });
    const account = row.accountId
      ? await Account.findOne({
          where: { id: row.accountId, ...householdWhere(req) },
          attributes: ['id', 'name', 'shortCode', 'accountType'],
        })
      : null;
    const enriched = enrichBatchRow(row, batchHealth);
    enriched.account = account
      ? {
          id: account.id,
          name: account.name,
          shortCode: account.shortCode,
          accountType: account.accountType,
        }
      : null;
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

type EnrichedBatch = Record<string, unknown> & {
  cleanCount: number;
  needsReviewCount: number;
  unknownCount: number;
  account?: {
    id: number;
    name: string;
    shortCode: string | null;
    accountType: string;
  } | null;
};

/**
 * Shared enrichment: ImportHistory.toJSON() + per-batch confidence counts.
 * Used by /history, /batches, and /batches/:id so the wire shape stays
 * uniform.
 */
function enrichBatchRow(
  row: ImportHistory,
  batchHealth: Map<string, { clean: number; needsReview: number; unknown: number }>,
): EnrichedBatch {
  const json = row.toJSON() as Record<string, unknown>;
  const health = batchHealth.get(row.batchLabel);
  json.cleanCount = health?.clean ?? 0;
  json.needsReviewCount = health?.needsReview ?? 0;
  json.unknownCount = health?.unknown ?? 0;
  return json as EnrichedBatch;
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

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

/**
 * GET /api/import/history/:batchLabel/rollback-preview
 *
 * Returns the impact of rolling back a single batch (#233): affected
 * transaction count, dependent-record counts, a small sample, and a list of
 * blockers explaining why the rollback is unsafe (if any). The frontend
 * confirmation dialog renders this payload before the user clicks Rollback.
 *
 * The `:batchLabel` path segment must be URI-encoded by the caller — batch
 * labels can contain slashes and spaces.
 *
 * Rate-limited via `importUploadLimiter` (same per-IP bucket the other
 * destructive import routes use) so an authenticated user cannot abuse this
 * read endpoint to fingerprint batch contents at scale. CodeQL flags any
 * authenticated route with DB reads scoped by user input as needing a limit.
 */
router.get(
  '/history/:batchLabel/rollback-preview',
  importUploadLimiter,
  async (req, res, next) => {
    try {
      const batchLabel = decodeURIComponent(req.params.batchLabel ?? '');
      if (!batchLabel) {
        res.status(400).json({ error: 'batchLabel is required' });
        return;
      }
      const impact = await previewRollback({
        batchLabel,
        householdScope: householdWhere(req),
        transactionScope: visibleTransactionWhere(req),
      });
      res.json(impact);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * POST /api/import/history/:batchLabel/rollback
 *
 * Executes the rollback: deletes the batch's transactions + dependent
 * records, flips the ImportHistory row to status='rolled_back', and stamps
 * `rolled_back_at` / `rolled_back_by_user_id` for the audit trail (#233).
 *
 * Responds 409 with the blocker payload if the rollback is blocked. The
 * service re-validates blockers inside its own SQL transaction so a racing
 * edit between preview and execute cannot create a dependent row we would
 * silently destroy.
 *
 * Rate-limited via `importUploadLimiter` — destructive route on
 * authenticated DB writes, exactly the shape CodeQL flags as needing a limit.
 */
router.post(
  '/history/:batchLabel/rollback',
  importUploadLimiter,
  async (req, res, next) => {
    try {
      const { user } = currentAuth(req);
      const batchLabel = decodeURIComponent(req.params.batchLabel ?? '');
      if (!batchLabel) {
        res.status(400).json({ error: 'batchLabel is required' });
        return;
      }
      logImportEvent('rollback_started', {
        batchLabel,
        userId: user.id,
      });
      const result = await executeRollback({
        batchLabel,
        householdScope: householdWhere(req),
        transactionScope: visibleTransactionWhere(req),
        userId: user.id,
      });
      logImportEvent('rollback_completed', {
        batchLabel,
        userId: user.id,
        deletedTransactions: result.deletedTransactions,
        deletedReceipts: result.deletedReceipts,
        deletedAiSuggestions: result.deletedAiSuggestions,
      });
      res.json(result);
    } catch (e) {
      if (e instanceof RollbackBlockedError) {
        res.status(409).json({
          error: 'rollback_blocked',
          batchLabel: e.batchLabel,
          blockers: e.blockers,
        });
        return;
      }
      next(e);
    }
  },
);

export default router;

import { Router } from 'express';
import multer from 'multer';
import { listImportProfiles } from '../import/csvProfiles';
import { previewImportCsv, PREVIEW_MAX_ROWS } from '../import/previewImport';
import { runImport, importCsvFile } from '../import/runImport';
import { ImportHistory } from '../models';
import { importUploadLimiter } from './importRateLimit';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
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
  details: Record<string, unknown>
): void {
  console.info(`[import] ${event}`, details);
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
    const profileId = (req.body as { profileId?: string } | undefined)?.profileId;
    logImportEvent('folder_run_started', {
      profileId: profileId ?? 'auto',
    });
    const result = await runImport({ profileId });
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
    upload.single('file')(req as never, res as never, (err: unknown) => {
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

      const result = await previewImportCsv({
        buffer: req.file.buffer,
        profileId,
        accountId,
      });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      logImportEvent('preview_completed', {
        fileName: req.file.originalname,
        accountId,
        profileId,
        usedProfileId: result.usedProfileId,
        profileInferred: result.profileInferred,
        rowCount: result.rows.length,
      });
      res.json({
        headers: result.headers,
        rows: result.rows,
        previewRowLimit: PREVIEW_MAX_ROWS,
        usedProfileId: result.usedProfileId,
        profileInferred: result.profileInferred,
      });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/upload',
  importUploadLimiter,
  (req, res, next) => {
    // Multer's Request type can disagree with root @types/express (nested deps); runtime is correct.
    upload.single('file')(req as never, res as never, (err: unknown) => {
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

      const result = await importCsvFile({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        accountId,
        batchLabel,
        profileId,
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
          result && typeof result === 'object' ? result.skipped : undefined,
        reason: result && typeof result === 'object' ? result.reason : undefined,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  }
);

router.get('/history', async (_req, res, next) => {
  try {
    const rows = await ImportHistory.findAll({
      order: [['startedAt', 'DESC']],
      limit: 50,
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

export default router;

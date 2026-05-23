import { Router } from 'express';
import multer from 'multer';
import { listImportProfiles } from '../import/csvProfiles';
import { PREVIEW_MAX_ROWS } from '../import/previewImport';
import { runImport, importCsvFile } from '../import/runImport';
import { parseStatementFile } from '../import/parseStatementFile';
import { consumeStatementPreview } from '../import/statementPreviewStore';
import { commitStatementImport } from '../import/commitStatementImport';
import { ImportHistory } from '../models';
import { importUploadLimiter } from './importRateLimit';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import type { LogFields } from '../observability/logger';
import { logger } from '../observability/logger';

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
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

const router = Router();

function logImportEvent(
  event: string,
  details: LogFields
): void {
  logger.info(`import_${event}`, details);
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
    csvUpload.array('files', 20)(req as never, res as never, (err: unknown) => {
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

      const results = [];
      for (const file of files) {
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

router.get('/history', async (req, res, next) => {
  try {
    const rows = await ImportHistory.findAll({
      where: householdWhere(req),
      order: [['startedAt', 'DESC']],
      limit: 50,
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

export default router;

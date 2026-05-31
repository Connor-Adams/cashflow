/**
 * Data export API (#302).
 *
 * POST   /api/me/export           — request a new export (409 if in-flight)
 * GET    /api/me/exports          — list exports newest-first
 * GET    /api/me/export/:id       — status of a specific export
 * GET    /api/me/export/:id/download?exp=&sig=  — stream the ZIP
 */
import fs from 'fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { DataExport } from '../models';
import { createUserDataExport } from '../services/dataExportArchive';
import { mintExportDownloadParams, verifyExportDownloadParams } from '../services/signedUrl';
import { logger } from '../observability/logger';

const router = Router();

function serializeExport(row: DataExport, userId: number) {
  const base = {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    byteSize: row.byteSize,
    errorMessage: row.errorMessage,
    downloadParams: null as { exp: string; sig: string } | null,
  };
  if (row.status === 'ready' && row.storageKey) {
    base.downloadParams = mintExportDownloadParams(row.id, userId);
  }
  return base;
}

// POST /api/me/export
router.post('/export', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);

    const existing = await DataExport.findOne({
      where: {
        userId: user.id,
        status: { [Op.in]: ['queued', 'running'] },
      },
    });
    if (existing) {
      res.status(409).json({
        error: 'EXPORT_IN_FLIGHT',
        message: 'An export is already being prepared. We will notify you when it is ready.',
      });
      return;
    }

    const row = await DataExport.create({
      userId: user.id,
      status: 'queued',
      requestedAt: new Date(),
      readyAt: null,
      expiresAt: null,
      storageKey: null,
      byteSize: null,
      errorMessage: null,
    });

    // Run the export in the background.
    runExportBackground(row.id, user.id);

    res.status(201).json({ exportId: row.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// GET /api/me/exports
router.get('/exports', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await DataExport.findAll({
      where: { userId: user.id },
      order: [['requestedAt', 'DESC']],
      limit: 20,
    });
    res.json({ exports: rows.map((r) => serializeExport(r, user.id)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/me/export/:id
router.get('/export/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const row = await DataExport.findOne({
      where: { id: Number(req.params.id), userId: user.id },
    });
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(serializeExport(row, user.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/me/export/:id/download
router.get('/export/:id/download', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const exportId = Number(req.params.id);
    const { exp, sig } = req.query as { exp?: string; sig?: string };

    if (!exp || !sig || !verifyExportDownloadParams(exportId, user.id, exp, sig)) {
      res.status(403).json({ error: 'INVALID_OR_EXPIRED_SIGNATURE' });
      return;
    }

    const row = await DataExport.findOne({
      where: { id: exportId, userId: user.id },
    });
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (row.status !== 'ready' || !row.storageKey) {
      res.status(409).json({ error: 'NOT_READY' });
      return;
    }
    if (row.expiresAt && row.expiresAt < new Date()) {
      res.status(410).json({ error: 'EXPORT_EXPIRED', message: 'This export has expired. Request a new one.' });
      return;
    }

    const date = (row.readyAt ?? row.requestedAt).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="cashflow-export-${date}.zip"`);
    const stream = fs.createReadStream(row.storageKey);
    stream.pipe(res);
    stream.on('error', (err) => {
      logger.warn({ exportId, err: err.message }, 'export_stream_error');
      if (!res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

/** Fire-and-forget background export runner. */
function runExportBackground(exportId: number, userId: number): void {
  void (async () => {
    const row = await DataExport.findByPk(exportId);
    if (!row) return;
    try {
      await row.update({ status: 'running' });
      const { storagePath, byteSize } = await createUserDataExport(userId, exportId);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      await row.update({
        status: 'ready',
        storageKey: storagePath,
        byteSize,
        readyAt: now,
        expiresAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ exportId, userId, err }, 'data_export_failed');
      await row.update({ status: 'failed', errorMessage: msg.slice(0, 1000) }).catch(() => undefined);
    }
  })();
}

export default router;

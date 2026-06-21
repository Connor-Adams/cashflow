/**
 * Data export routes (issue #302).
 *
 * Mounted on `/api/me` (so route paths here are relative to that prefix):
 *   GET    /api/me/exports              — list user's exports newest-first
 *   POST   /api/me/export               — request a new export (201)
 *   GET    /api/me/export/:id           — status of one export
 *   GET    /api/me/export/:id/download  — stream ZIP (requires valid signed URL)
 *
 * Security notes:
 *  - All routes require session auth (`requireAuth`).
 *  - Download requires a valid HMAC signature binding (exportId, userId, exp)
 *    so a signed URL issued to user A cannot be replayed by user B (AC #13).
 *  - Download returns 410 Gone for expired archives; 403 for bad/missing sig.
 *  - Only one in-flight export per user (409 EXPORT_IN_FLIGHT).
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { DataExport } from '../models/DataExport';
import { requireAuth, currentAuth } from '../auth/middleware';
import { runUserDataExport } from '../jobs/definitions/userDataExport';
import { buildSignedParams, verifySignedParams } from '../services/signedUrl';
import { openExportStream } from '../services/dataExportArchive';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

type ExportRow = {
  id: number;
  status: string;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
  errorMessage: string | null;
  downloadUrl: string | null;
};

function serializeExport(row: DataExport, req: import('express').Request): ExportRow {
  const auth = currentAuth(req);
  let downloadUrl: string | null = null;

  if (row.status === 'ready' && row.storageKey && row.expiresAt) {
    const params = buildSignedParams(row.id, auth.user.id, row.expiresAt);
    downloadUrl =
      `/api/me/export/${row.id}/download?exp=${params.exp}&sig=${params.sig}`;
  }

  return {
    id: row.id,
    status: row.status,
    requestedAt: (row.requestedAt ?? row.createdAt).toISOString(),
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    byteSize: row.byteSize ?? null,
    errorMessage: row.errorMessage ?? null,
    downloadUrl,
  };
}

// ---------------------------------------------------------------------------
// GET /api/me/exports
// ---------------------------------------------------------------------------

router.get('/exports', async (req, res) => {
  const auth = currentAuth(req);
  const rows = await DataExport.findAll({
    where: { userId: auth.user.id },
    order: [['requestedAt', 'DESC']],
  });
  res.json({ data: rows.map((r) => serializeExport(r, req)) });
});

// ---------------------------------------------------------------------------
// POST /api/me/export
// ---------------------------------------------------------------------------

router.post('/export', async (req, res) => {
  const auth = currentAuth(req);
  const userId = auth.user.id;

  // Check for an in-flight export (AC #3)
  const inFlight = await DataExport.findOne({
    where: {
      userId,
      status: { [Op.in]: ['queued', 'running'] },
    },
  });

  if (inFlight) {
    res.status(409).json({
      error: 'EXPORT_IN_FLIGHT',
      message:
        'An export is already being prepared. We will notify you when it is ready.',
      exportId: inFlight.id,
    });
    return;
  }

  // Create queued row (AC #2)
  const exportRow = await DataExport.create({
    userId,
    status: 'queued',
    readyAt: null,
    expiresAt: null,
    storageKey: null,
    byteSize: null,
    errorMessage: null,
  });

  // Fire background job (non-blocking) (AC #2)
  setImmediate(() => {
    void runUserDataExport(exportRow.id).catch((err) => {
      // Errors are already handled inside runUserDataExport; this catch
      // prevents unhandled rejection if it throws after the route returns.
      const { logger } = require('../observability/logger');
      logger.error({ err, exportId: exportRow.id }, 'data_export_bg_uncaught');
    });
  });

  res.status(201).json({ exportId: exportRow.id, status: 'queued' });
});

// ---------------------------------------------------------------------------
// GET /api/me/export/:id
// ---------------------------------------------------------------------------

router.get('/export/:id', async (req, res) => {
  const auth = currentAuth(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid export id' });
    return;
  }

  const row = await DataExport.findOne({
    where: { id, userId: auth.user.id },
  });

  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json(serializeExport(row, req));
});

// ---------------------------------------------------------------------------
// GET /api/me/export/:id/download
// ---------------------------------------------------------------------------

router.get('/export/:id/download', async (req, res) => {
  const auth = currentAuth(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid export id' });
    return;
  }

  const row = await DataExport.findOne({
    where: { id, userId: auth.user.id },
  });

  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Verify signature (AC #6)
  const { exp, sig } = req.query as Record<string, string | undefined>;
  const verifyResult = verifySignedParams(id, auth.user.id, exp, sig);

  if (!verifyResult.ok) {
    if (verifyResult.reason === 'expired') {
      res.status(410).json({
        error: 'EXPORT_EXPIRED',
        message: 'This export has expired. Request a new one.',
      });
    } else {
      res.status(403).json({ error: 'INVALID_SIGNATURE' });
    }
    return;
  }

  // Also check if the export itself has expired by its own row (AC #7)
  if (row.status !== 'ready' || !row.storageKey) {
    if (row.expiresAt && row.expiresAt < new Date()) {
      res.status(410).json({
        error: 'EXPORT_EXPIRED',
        message: 'This export has expired. Request a new one.',
      });
    } else {
      res.status(409).json({ error: 'Export not ready', status: row.status });
    }
    return;
  }

  // Stream the ZIP
  const filename = `cashflow-export-${new Date(row.requestedAt ?? row.createdAt).toISOString().slice(0, 10)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (row.byteSize) {
    res.setHeader('Content-Length', String(row.byteSize));
  }

  const stream = openExportStream(row.storageKey);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read export file' });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

export default router;

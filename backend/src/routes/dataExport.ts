/**
 * User data export routes (issue #302).
 *
 * Mounted on `/api` behind the global `requireAuth` guard:
 *   POST /api/me/export              — request a new export
 *   GET  /api/me/exports             — list user's exports, newest-first
 *   GET  /api/me/export/:exportId    — get status + download URL
 *   GET  /api/me/export/:exportId/download — stream the gzip archive
 */
import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Router } from 'express';
import { Op } from 'sequelize';
import { DataExport } from '../models';
import { currentAuth } from '../auth/middleware';
import { runDataExport } from '../jobs/definitions/userDataExport';
import { logger } from '../observability/logger';

const router = Router();

// ---- helpers ----------------------------------------------------------------

function serialize(row: DataExport) {
  return {
    id: Number(row.id),
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    byteSize: row.byteSize != null ? Number(row.byteSize) : null,
    errorMessage: row.errorMessage ?? null,
  };
}

// ---- POST /api/me/export ----------------------------------------------------

router.post('/me/export', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);

    // 409 if any export is still in flight for this user.
    const inflight = await DataExport.findOne({
      where: {
        userId: user.id,
        status: { [Op.in]: ['queued', 'running'] },
      },
    });
    if (inflight) {
      res.status(409).json({ error: 'EXPORT_IN_FLIGHT', exportId: Number(inflight.id) });
      return;
    }

    const now = new Date();
    const row = await DataExport.create({
      userId: user.id,
      status: 'queued',
      requestedAt: now,
      readyAt: null,
      expiresAt: null,
      storageKey: null,
      byteSize: null,
      errorMessage: null,
    });

    // Fire-and-forget — do not await.
    runDataExport(Number(row.id)).catch((err: unknown) => {
      logger.error({ err, exportId: row.id }, 'data_export_fire_and_forget_failed');
    });

    res.status(201).json({ exportId: Number(row.id), status: 'queued' });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/me/exports -----------------------------------------------------

router.get('/me/exports', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);

    const rows = await DataExport.findAll({
      where: { userId: user.id },
      order: [['requested_at', 'DESC']],
      limit: 50,
    });

    res.json({ exports: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/me/export/:exportId -------------------------------------------

router.get('/me/export/:exportId', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.exportId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid exportId' });
      return;
    }

    const row = await DataExport.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const downloadUrl =
      row.status === 'ready' ? `/api/me/export/${id}/download` : null;

    res.json({ ...serialize(row), downloadUrl });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/me/export/:exportId/download ----------------------------------

router.get('/me/export/:exportId/download', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.exportId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid exportId' });
      return;
    }

    const row = await DataExport.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (row.status !== 'ready' || !row.storageKey) {
      res.status(404).json({ error: 'Export not ready' });
      return;
    }

    // 410 Gone if expired.
    if (row.expiresAt && row.expiresAt < new Date()) {
      res.status(410).json({ error: 'Export has expired' });
      return;
    }

    if (!existsSync(row.storageKey)) {
      res.status(404).json({ error: 'Archive file not found' });
      return;
    }

    const date = row.requestedAt.toISOString().slice(0, 10);
    const filename = `cashflow-export-${date}.json.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (row.byteSize != null) {
      res.setHeader('Content-Length', String(row.byteSize));
    }

    createReadStream(row.storageKey).pipe(res);
  } catch (e) {
    next(e);
  }
});

export default router;

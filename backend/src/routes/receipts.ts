import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { Transaction, Receipt } from '../models';
import { getReceiptsUploadDir } from '../config/receipts';
import { analyzeReceiptFile } from '../ai/receiptVision';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';

const router = Router();

const allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mt = file.mimetype.toLowerCase();
    if (!allowedMime.has(mt)) {
      const e = new Error(
        'Only JPEG, PNG, or WebP images are allowed',
      ) as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

async function ensureDir(): Promise<string> {
  const dir = getReceiptsUploadDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** POST /api/transactions/:transactionId/receipts */
router.post(
  '/transactions/:transactionId/receipts',
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
      const tid = parseInt(String(req.params.transactionId), 10);
      if (Number.isNaN(tid) || tid < 1) {
        res.status(400).json({ error: 'Invalid transaction id' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const txn = await Transaction.findByPk(tid);
      if (!txn) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
      const dir = await ensureDir();
      const ext = path.extname(req.file.originalname) || '.jpg';
      const stored = `${crypto.randomUUID()}${ext}`;
      await fs.writeFile(path.join(dir, stored), req.file.buffer);

      const row = await Receipt.create({
        transactionId: tid,
        storedFilename: stored,
        originalName: req.file.originalname.slice(0, 500),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        extractedNote: null,
      });

      res.status(201).json({
        id: row.id,
        transactionId: tid,
        originalName: row.originalName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
      });
    } catch (e) {
      next(e);
    }
  },
);

/** GET /api/transactions/:transactionId/receipts */
router.get('/transactions/:transactionId/receipts', async (req, res, next) => {
  try {
    const tid = parseInt(String(req.params.transactionId), 10);
    if (Number.isNaN(tid) || tid < 1) {
      res.status(400).json({ error: 'Invalid transaction id' });
      return;
    }
    const rows = await Receipt.findAll({
      where: { transactionId: tid },
      order: [['createdAt', 'DESC']],
      attributes: [
        'id',
        'transactionId',
        'originalName',
        'mimeType',
        'sizeBytes',
        'extractedNote',
        'createdAt',
      ],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/** GET /api/receipts/:id/file — download raw file */
router.get('/receipts/:id/file', async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Receipt.findByPk(id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const dir = getReceiptsUploadDir();
    const abs = path.join(dir, row.storedFilename);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(row.originalName)}"`,
    );
    res.type(row.mimeType);
    res.sendFile(path.resolve(abs), (err) => {
      if (err) next(err);
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/receipts/:id', async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Receipt.findByPk(id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const dir = getReceiptsUploadDir();
    const abs = path.join(dir, row.storedFilename);
    await row.destroy();
    try {
      await fs.unlink(abs);
    } catch {
      /* ignore */
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

/** POST /api/receipts/:id/analyze — OpenAI vision */
router.post(
  '/receipts/:id/analyze',
  aiSuggestLimiter,
  async (req, res, next) => {
    try {
      if (!getOpenAiConfig()) {
        res.status(503).json({ error: 'OpenAI is not configured' });
        return;
      }
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id) || id < 1) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      const row = await Receipt.findByPk(id);
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const extracted = await analyzeReceiptFile(row);
      const note = JSON.stringify(extracted);
      await row.update({ extractedNote: note });
      res.json({ extracted, receiptId: row.id });
    } catch (e) {
      next(e);
    }
  },
);

export default router;

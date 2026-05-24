import { Router } from 'express';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { Op } from 'sequelize';
import { Transaction, Receipt, ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../models';
import { extractReceiptFromImage } from '../ai/extractReceiptItems';
import { persistExtractedOrder } from './externalOrders';
import { matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { currentAuth } from '../auth/middleware';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';
import { visibleTransactionWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import {
  deleteReceiptObject,
  readReceiptObject,
  saveReceiptObject,
} from '../storage/receiptStorage';

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
      const txn = await Transaction.findOne({ where: { id: tid, ...visibleTransactionWhere(req) } });
      if (!txn) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
      const ext = path.extname(req.file.originalname) || '.jpg';
      const stored = `${crypto.randomUUID()}${ext}`;
      const storedKey = await saveReceiptObject(stored, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      });

      const row = await Receipt.create({
        transactionId: tid,
        storedFilename: storedKey,
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
    const txn = await Transaction.findOne({ where: { id: tid, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    const receipts = await Receipt.findAll({
      where: { transactionId: tid },
      order: [['createdAt', 'DESC']],
    });
    const orderIds = receipts.map((r) => r.externalOrderId).filter((x): x is number => x != null);
    const [orders, items] = await Promise.all([
      orderIds.length
        ? ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds }, householdId: txn.householdId } })
        : Promise.resolve([] as InstanceType<typeof ExternalOrder>[]),
      orderIds.length
        ? ExternalOrderItem.findAll({ where: { externalOrderId: { [Op.in]: orderIds } } })
        : Promise.resolve([] as InstanceType<typeof ExternalOrderItem>[]),
    ]);
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    const itemsByOrder = new Map<number, typeof items>();
    for (const it of items) {
      const list = itemsByOrder.get(it.externalOrderId) ?? [];
      list.push(it);
      itemsByOrder.set(it.externalOrderId, list);
    }
    res.json(
      receipts.map((r) => {
        const order = r.externalOrderId != null ? ordersById.get(r.externalOrderId) : null;
        return {
          id: r.id,
          transactionId: r.transactionId,
          originalName: r.originalName,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          extractedNote: r.extractedNote,
          createdAt: r.createdAt,
          externalOrderId: r.externalOrderId,
          order: order
            ? {
                id: order.id,
                vendor: order.vendor,
                subtotal: order.subtotal,
                tax: order.tax,
                shipping: order.shipping,
                total: order.total,
                currency: order.currency,
              }
            : null,
          items: (r.externalOrderId != null ? (itemsByOrder.get(r.externalOrderId) ?? []) : []).map(
            (it) => ({
              id: it.id,
              externalOrderId: it.externalOrderId,
              title: it.title,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              totalPrice: it.totalPrice,
              inferredCategory: it.inferredCategory,
              categoryOverride: it.categoryOverride,
              businessUsePercent: it.businessUsePercent,
              businessUseOverride: it.businessUseOverride,
            }),
          ),
        };
      }),
    );
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
    const txn = await Transaction.findOne({
      where: { id: row.transactionId, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const buffer = await readReceiptObject(row.storedFilename);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(row.originalName)}"`,
    );
    res.type(row.mimeType);
    res.send(buffer);
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
    const txn = await Transaction.findOne({
      where: { id: row.transactionId, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    try {
      await deleteReceiptObject(row.storedFilename);
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
      if (rejectDemoAiRequest(req, res)) return;
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
      const txn = await Transaction.findOne({
        where: { id: row.transactionId, ...visibleTransactionWhere(req) },
      });
      if (!txn) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const buf = await readReceiptObject(row.storedFilename);
      const mime = row.mimeType.toLowerCase();
      if (!mime.startsWith('image/')) {
        res.status(400).json({ error: 'Vision analysis supports image receipts only' });
        return;
      }
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const extracted = await extractReceiptFromImage(dataUrl);
      const auth = currentAuth(req);
      const { order } = await persistExtractedOrder(extracted, {
        userId: auth.user.id,
        householdId: auth.household.id,
        source: 'receipt-analyze',
      });
      const previousExternalOrderId = row.externalOrderId;
      await row.update({
        externalOrderId: order.id,
        extractedNote: JSON.stringify(extracted),
      });
      if (previousExternalOrderId != null && previousExternalOrderId !== order.id) {
        await TransactionOrderLink.destroy({
          where: { externalOrderId: previousExternalOrderId, status: 'suggested' },
        });
      }
      if (auth.household.id != null) {
        await matchReceiptOrderToTransactions({
          externalOrderId: order.id,
          householdId: auth.household.id,
        });
      }
      res.json({ receipt: row.toJSON(), order: order.toJSON(), extracted });
    } catch (e) {
      next(e);
    }
  },
);

router.patch('/external-order-items/:id', async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const item = await ExternalOrderItem.findByPk(id);
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const links = await TransactionOrderLink.findAll({
      where: { externalOrderId: item.externalOrderId },
    });
    if (links.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const txn = await Transaction.findOne({
      where: {
        id: { [Op.in]: links.map((l) => l.transactionId) },
        ...visibleTransactionWhere(req),
      },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { categoryOverride?: string | null; businessUseOverride?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'categoryOverride')) {
      const v = body.categoryOverride;
      if (v === null || v === '') patch.categoryOverride = null;
      else if (typeof v === 'string') patch.categoryOverride = v;
      else {
        res.status(400).json({ error: 'categoryOverride must be string or null' });
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'businessUseOverride')) {
      const v = body.businessUseOverride;
      if (v === null || v === '') patch.businessUseOverride = null;
      else if (typeof v !== 'number' && typeof v !== 'string') {
        res.status(400).json({ error: 'businessUseOverride must be number, string, or null' });
        return;
      }
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          res.status(400).json({ error: 'businessUseOverride must be in [0,100]' });
          return;
        }
        patch.businessUseOverride = String(n);
      }
    }
    await item.update(patch);
    res.json(item.toJSON());
  } catch (e) {
    next(e);
  }
});

export default router;

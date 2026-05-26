import { Router } from 'express';
import { Op } from 'sequelize';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { UserCaptureToken } from '../models';
import { currentAuth } from '../auth/middleware';
import { hashCaptureToken, mintCaptureTokenPlaintext } from '../auth/captureToken';
import { captureAuth } from '../auth/captureAuth';
import { captureOrders } from '../import/vendorCapture';
import { runBackfill } from '../import/runEnrichmentBackfill';
import { backfillRunning } from '../import/backfillCoordinator';
import { logger } from '../observability/logger';

const router = Router();

/**
 * Rate limiter for the public POST /orders bookmarklet endpoint.
 *
 * Bearer-token auth alone isn't enough: a leaked or brute-forced token could
 * flood backfills. Cap at 30 req/min per IP — matches the pattern used in
 * sibling public endpoints (clientLogs.ts, import routes). Skipped under
 * NODE_ENV=test so integration tests stay deterministic.
 */
const captureOrdersLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

const ALLOWED_ORIGINS = new Set([
  'https://www.amazon.com',
  'https://www.amazon.ca',
  'https://www.amazon.co.uk',
  'https://amazon.com',
  'https://amazon.ca',
  'https://amazon.co.uk',
  'https://reportaproblem.apple.com',
]);

export const captureCors = cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: false,
});

router.post('/tokens', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const label = String((req.body as { label?: unknown } | undefined)?.label ?? '').trim() || 'Browser';
    if (label.length > 64) {
      res.status(400).json({ error: 'Label must be 64 characters or fewer' });
      return;
    }
    const plaintext = mintCaptureTokenPlaintext();
    const row = await UserCaptureToken.create({
      userId: user.id,
      tokenHash: hashCaptureToken(plaintext),
      label,
      lastUsedAt: null,
      revokedAt: null,
    });
    res.status(201).json({
      id: row.id,
      plaintext,
      label: row.label,
      createdAt: row.createdAt,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/tokens', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await UserCaptureToken.findAll({
      where: { userId: user.id, revokedAt: { [Op.is]: null } },
      order: [['createdAt', 'DESC']],
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      })),
    );
  } catch (e) {
    next(e);
  }
});

router.delete('/tokens/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await UserCaptureToken.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    if (row.revokedAt == null) {
      await row.update({ revokedAt: new Date() });
    }
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// CORS preflights for `/orders` are handled by an app-level mount of `captureCors`
// before the global `cors()` middleware (see `app.ts`). The redundant `captureCors`
// on the POST handler below re-applies the cross-origin allow header after the
// global handler runs, so the actual JSON response carries the correct origin.
router.options('/orders', captureCors);

router.post('/orders', captureCors, captureOrdersLimiter, captureAuth, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vendor = String(body.vendor ?? '').trim().toLowerCase();
    if (vendor !== 'amazon' && vendor !== 'apple') {
      res.status(400).json({ error: 'vendor must be one of: amazon, apple' });
      return;
    }
    const ordersRaw = Array.isArray(body.orders) ? body.orders : null;
    if (!ordersRaw || ordersRaw.length === 0) {
      res.status(400).json({ error: 'orders must be a non-empty array' });
      return;
    }
    if (ordersRaw.length > 200) {
      res.status(400).json({ error: 'orders cap is 200 per request' });
      return;
    }

    const orders = ordersRaw.map((raw, idx) => {
      const o = raw as Record<string, unknown>;
      const orderDate = String(o.orderDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
        throw new Error(`orders[${idx}].orderDate must be YYYY-MM-DD`);
      }
      // Reject inputs like '2026-13-45' that match the regex but aren't real
      // calendar dates. SQLite would store the string as-is; downstream
      // `new Date(...)` would crash inside the post-response setImmediate.
      const parsed = new Date(`${orderDate}T00:00:00Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== orderDate
      ) {
        throw new Error(
          `orders[${idx}].orderDate is not a valid calendar date: ${orderDate}`,
        );
      }
      const total = Number(o.total);
      if (!Number.isFinite(total)) {
        throw new Error(`orders[${idx}].total must be a number`);
      }
      const items = Array.isArray(o.items) ? o.items : [];
      return {
        vendorOrderId: typeof o.vendorOrderId === 'string' ? o.vendorOrderId : null,
        orderDate,
        total,
        currency: typeof o.currency === 'string' && o.currency.length === 3 ? o.currency : 'CAD',
        paymentLast4:
          typeof o.paymentLast4 === 'string' && /^\d{4}$/.test(o.paymentLast4) ? o.paymentLast4 : null,
        items: items.map((itRaw) => {
          const it = itRaw as Record<string, unknown>;
          const title = String(it.title ?? '').trim();
          return {
            title: title || 'Unknown item',
            quantity: typeof it.quantity === 'number' ? it.quantity : 1,
            unitPrice: typeof it.unitPrice === 'number' ? it.unitPrice : null,
            totalPrice: typeof it.totalPrice === 'number' ? it.totalPrice : null,
          };
        }),
      };
    });

    const { user, household } = req.captureAuth!;
    const source = `bookmarklet-${vendor}-v1`;
    const result = await captureOrders({
      householdId: household.id,
      userId: user.id,
      vendor,
      source,
      orders,
    });

    // Compute the post-response backfill window BEFORE responding, so any
    // unexpected throw here surfaces as a 400 instead of a
    // "headers already sent" crash inside setImmediate.
    const dates = orders.map((o) => o.orderDate).sort();
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    if (dates.length > 0) {
      const from = new Date(`${dates[0]}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 14);
      const to = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
      to.setUTCDate(to.getUTCDate() + 14);
      dateFrom = from.toISOString().slice(0, 10);
      dateTo = to.toISOString().slice(0, 10);
    }

    res.json(result);

    if (dateFrom && dateTo) {
      setImmediate(() => {
        if (backfillRunning.has(household.id)) {
          // Another backfill is in flight for this household — skip this one;
          // its date window will be covered by the in-flight call or a
          // subsequent one. Prevents thundering-herd on rapid bookmarklet clicks.
          return;
        }
        backfillRunning.add(household.id);
        runBackfill({
          dryRun: false,
          noReviewFlag: false,
          reviewOnly: false,
          verbose: false,
          accountId: null,
          householdId: household.id,
          limit: null,
          batchSize: 50,
          dateFrom,
          dateTo,
        })
          .catch((err) => logger.error({ err, module: 'capture' }, 'post_capture_backfill_failed'))
          .finally(() => backfillRunning.delete(household.id));
      });
    }
  } catch (e) {
    if (e instanceof Error && /orders\[\d+\]/.test(e.message)) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

export default router;

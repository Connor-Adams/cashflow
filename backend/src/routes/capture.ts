import { Router } from 'express';
import { Op } from 'sequelize';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { UserCaptureToken } from '../models';
import { currentAuth, requireAuth } from '../auth/middleware';
import { hashCaptureToken, mintCaptureTokenPlaintext } from '../auth/captureToken';
import { captureAuth } from '../auth/captureAuth';
import { captureOrders, type CapturedOrderInput, type CaptureResult } from '../import/vendorCapture';
import { scheduleInternalBackfill } from '../import/backfillCoordinator';
import { runAmazonMatching } from '../amazon/matcher';
import { logger } from '../observability/logger';

class CapturePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapturePayloadError';
  }
}

/**
 * Validate a capture payload, persist the orders, and schedule the post-write
 * enrichment backfill. Shared by the bearer-token route (live bookmarklet
 * fetch) and the session-authed paste route (clipboard fallback when a
 * vendor's CSP blocks the direct fetch). `sourcePrefix` distinguishes the two
 * call sites in `external_orders.source` and in backfill logs.
 */
async function processCapturePayload(args: {
  body: unknown;
  householdId: number;
  userId: number;
  sourcePrefix: string;
}): Promise<CaptureResult & { matchSuggested: number }> {
  const body = (args.body ?? {}) as Record<string, unknown>;
  const vendor = String(body.vendor ?? '').trim().toLowerCase();
  if (vendor !== 'amazon' && vendor !== 'apple') {
    throw new CapturePayloadError('vendor must be one of: amazon, apple');
  }
  const ordersRaw = Array.isArray(body.orders) ? body.orders : null;
  if (!ordersRaw || ordersRaw.length === 0) {
    throw new CapturePayloadError('orders must be a non-empty array');
  }
  if (ordersRaw.length > 1000) {
    throw new CapturePayloadError('orders cap is 1000 per request');
  }

  const orders: CapturedOrderInput[] = ordersRaw.map((raw, idx) => {
    const o = raw as Record<string, unknown>;
    const orderDate = String(o.orderDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
      throw new CapturePayloadError(`orders[${idx}].orderDate must be YYYY-MM-DD`);
    }
    // Reject inputs like '2026-13-45' that match the regex but aren't real
    // calendar dates. SQLite would store the string as-is; downstream
    // `new Date(...)` would crash inside the post-response setImmediate.
    const parsed = new Date(`${orderDate}T00:00:00Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== orderDate
    ) {
      throw new CapturePayloadError(
        `orders[${idx}].orderDate is not a valid calendar date: ${orderDate}`,
      );
    }
    const total = Number(o.total);
    if (!Number.isFinite(total)) {
      throw new CapturePayloadError(`orders[${idx}].total must be a number`);
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

  const source = `${args.sourcePrefix}-${vendor}-v1`;
  const result = await captureOrders({
    householdId: args.householdId,
    userId: args.userId,
    vendor,
    source,
    orders,
  });

  // Widen by ±14 days so the enrichment sweep catches transactions that
  // posted before / after the captured order date.
  const dates = orders.map((o) => o.orderDate).sort();
  if (dates.length > 0) {
    const from = new Date(`${dates[0]}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 14);
    const to = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 14);
    scheduleInternalBackfill({
      householdId: args.householdId,
      dateFrom: from.toISOString().slice(0, 10),
      dateTo: to.toISOString().slice(0, 10),
      source: `capture-${args.sourcePrefix}-${vendor}`,
    });
  }

  let matchSuggested = 0;
  if (vendor === 'amazon') {
    try {
      const match = await runAmazonMatching({ householdId: args.householdId });
      matchSuggested = match.suggested;
    } catch (err) {
      // Matching is best-effort and the capture already committed — never let a
      // matching failure turn a successful capture into a 500. The user can
      // re-run matching from the UI. Log and continue.
      logger.error({ err }, 'capture_amazon_matching_failed_after_commit');
    }
  }

  return { ...result, matchSuggested };
}

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
    const { user, household } = req.captureAuth!;
    const client = String((req.body as { client?: unknown } | undefined)?.client ?? '')
      .trim()
      .toLowerCase();
    const result = await processCapturePayload({
      body: req.body,
      householdId: household.id,
      userId: user.id,
      sourcePrefix: client === 'extension' ? 'extension' : 'bookmarklet',
    });
    res.json(result);
  } catch (e) {
    if (e instanceof CapturePayloadError) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

/**
 * Session-authed paste fallback. When a vendor page's CSP blocks the
 * bookmarklet's direct fetch (e.g. reportaproblem.apple.com), the bookmarklet
 * copies the orders JSON to the clipboard and the user pastes it into the
 * Settings → Imports UI, which posts here. Same payload shape as /orders, but
 * authenticated by session cookie instead of a bearer capture token.
 */
router.post('/orders-from-paste', requireAuth, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const result = await processCapturePayload({
      body: req.body,
      householdId: household.id,
      userId: user.id,
      sourcePrefix: 'bookmarklet-paste',
    });
    res.json(result);
  } catch (e) {
    if (e instanceof CapturePayloadError) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

export default router;

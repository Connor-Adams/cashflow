import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Subscription,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_CADENCES,
  type SubscriptionStatus,
  type SubscriptionCadence,
} from '../models/Subscription';
import { Transaction } from '../models';
import { num } from '../util/numbers';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { currentAuth } from '../auth/middleware';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';
import {
  detectRecurring,
  type RecurringInputTxn,
} from './recurring';
import {
  annualizeCost,
  mergeDetectionWithExisting,
  normalizeMerchantName,
  type ExistingSubscriptionRow,
} from '../subscriptions/detect';
import {
  ALLOWED_HORIZON_MONTHS,
  computeCancelImpact,
  isAllowedHorizon,
} from '../subscriptions/cancelImpact';

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 180;
const DEFAULT_MIN_OCCURRENCES = 3;

interface SubscriptionResponse {
  id: number;
  householdId: number;
  merchantName: string;
  normalizedName: string;
  amount: string;
  currency: string;
  cadence: string;
  lastChargeDate: string;
  nextExpectedDate: string | null;
  status: SubscriptionStatus;
  category: string | null;
  annualizedCost: string;
  priceChangeDetected: boolean;
  cancellationUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: InstanceType<typeof Subscription>): SubscriptionResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    merchantName: row.merchantName,
    normalizedName: row.normalizedName,
    amount: String(row.amount),
    currency: row.currency,
    cadence: row.cadence,
    lastChargeDate: row.lastChargeDate,
    nextExpectedDate: row.nextExpectedDate,
    status: row.status,
    category: row.category,
    annualizedCost: String(row.annualizedCost),
    priceChangeDetected: Boolean(row.priceChangeDetected),
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface SubscriptionPatch {
  status?: SubscriptionStatus;
  cadence?: SubscriptionCadence;
  cancellationUrl?: string | null;
  notes?: string | null;
}

type PatchValidation =
  | { ok: true; value: SubscriptionPatch }
  | { ok: false; status: number; error: string };

/**
 * Pure validator for PATCH /api/subscriptions/:id bodies. The user-curated
 * fields are mutable from this endpoint: status, cancellationUrl, notes, and
 * cadence. Cadence is special — it is detection-derived but a user may correct
 * a misdetected value (annual misread as monthly), so an explicit edit sticks.
 * Everything else (amount, category, …) is derived from detection and gets
 * overwritten on the next refresh, so allowing PATCH on those would be
 * surprising and pointless.
 */
export function validateSubscriptionPatch(
  raw: Record<string, unknown>,
): PatchValidation {
  const value: SubscriptionPatch = {};

  if (raw.status !== undefined) {
    const candidate = String(raw.status);
    if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`,
      };
    }
    value.status = candidate as SubscriptionStatus;
  }

  if (raw.cadence !== undefined) {
    const candidate = String(raw.cadence);
    if (!(SUBSCRIPTION_CADENCES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: 'INVALID_CADENCE',
      };
    }
    value.cadence = candidate as SubscriptionCadence;
  }

  if (raw.cancellationUrl !== undefined) {
    if (raw.cancellationUrl === null || raw.cancellationUrl === '') {
      value.cancellationUrl = null;
    } else {
      const candidate = String(raw.cancellationUrl).trim();
      // Lightweight scheme check — full URL validation is overkill for a
      // field users paste from "how do I cancel X" support pages. We just
      // refuse obviously bad input like "javascript:..." that could harm
      // a user who clicks the link out of the UI.
      if (
        candidate.length > 2048 ||
        !/^https?:\/\//i.test(candidate)
      ) {
        return {
          ok: false,
          status: 400,
          error: 'cancellationUrl must be an http(s) URL under 2048 chars',
        };
      }
      value.cancellationUrl = candidate;
    }
  }

  if (raw.notes !== undefined) {
    if (raw.notes === null || raw.notes === '') {
      value.notes = null;
    } else {
      const candidate = String(raw.notes).slice(0, 2000);
      value.notes = candidate;
    }
  }

  return { ok: true, value };
}

/**
 * Load the household's transactions (charges only) for the last
 * `windowDays`, run detectRecurring, then merge the detected groups into
 * persisted subscription rows. Returns the freshly written rows.
 *
 * Exported so a future cron job could call it without going through HTTP.
 */
export async function refreshDetectedSubscriptions(args: {
  householdId: number;
  // Pass the request-derived `visibleTransactionWhere` so superadmins and
  // partners see the same scoped data the rest of the app sees.
  visibleWhere: Record<string, unknown>;
  windowDays?: number;
  minOccurrences?: number;
}): Promise<void> {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minOccurrences = args.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const since = new Date(Date.now() - windowDays * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);

  const txnRows = await Transaction.findAll({
    where: {
      ...args.visibleWhere,
      date: { [Op.gte]: since },
    },
    attributes: [
      'date',
      'currency',
      'amount',
      'merchantRaw',
      'merchantClean',
      'finalCategory',
    ],
    raw: true,
  });

  type Row = {
    date: string;
    currency: string;
    amount: unknown;
    merchantRaw: string | null;
    merchantClean: string | null;
    finalCategory: string | null;
  };

  const candidates: RecurringInputTxn[] = [];
  for (const row of txnRows as unknown as Row[]) {
    const amount = num(row.amount);
    if (amount == null) continue;
    if (amount >= 0) continue;
    if (
      classifyPositiveFlow({
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      }) === 'payment'
    ) {
      continue;
    }
    const merchant =
      (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
    if (!merchant) continue;
    candidates.push({
      merchant,
      amount,
      currency: row.currency,
      date: row.date,
      category: row.finalCategory,
    });
  }

  const detected = detectRecurring(candidates, { minOccurrences });

  const existingRows = await Subscription.findAll({
    where: { householdId: args.householdId },
  });
  const existing: ExistingSubscriptionRow[] = existingRows.map((row) => ({
    id: row.id,
    normalizedName: row.normalizedName,
    currency: row.currency,
    amount: String(row.amount),
    status: row.status,
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
  }));

  const ops = mergeDetectionWithExisting(detected, existing);
  for (const op of ops) {
    if (op.kind === 'insert') {
      await Subscription.create({
        householdId: args.householdId,
        merchantName: op.merchantName,
        normalizedName: op.normalizedName,
        currency: op.currency,
        amount: op.amount,
        cadence: op.cadence,
        lastChargeDate: op.lastChargeDate,
        nextExpectedDate: op.nextExpectedDate,
        status: op.status,
        category: op.category,
        annualizedCost: op.annualizedCost,
        priceChangeDetected: op.priceChangeDetected,
        cancellationUrl: null,
        notes: null,
      });
    } else {
      await Subscription.update(op.patch, { where: { id: op.id } });
    }
  }
}

router.get('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const refreshParam = String(req.query.refresh ?? '1');
    if (refreshParam !== '0') {
      await refreshDetectedSubscriptions({
        householdId: auth.household.id,
        visibleWhere: visibleTransactionWhere(req) as Record<string, unknown>,
      });
    }

    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.status) {
      const statusCandidate = String(req.query.status);
      if (
        !(SUBSCRIPTION_STATUSES as readonly string[]).includes(statusCandidate)
      ) {
        res.status(400).json({
          error: `status filter must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`,
        });
        return;
      }
      where.status = statusCandidate;
    }
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const rows = await Subscription.findAll({
      where,
      order: [
        ['status', 'ASC'],
        ['annualizedCost', 'DESC'],
        ['merchantName', 'ASC'],
      ],
    });
    res.json({ items: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const refreshParam = String(req.query.refresh ?? '1');
    if (refreshParam !== '0') {
      await refreshDetectedSubscriptions({
        householdId: auth.household.id,
        visibleWhere: visibleTransactionWhere(req) as Record<string, unknown>,
      });
    }

    const rows = await Subscription.findAll({
      where: { ...householdWhere(req) },
    });

    type CurrencyBucket = {
      currency: string;
      activeCount: number;
      monthlyCost: number;
      annualCost: number;
    };
    const byCurrency = new Map<string, CurrencyBucket>();
    let totalActive = 0;
    let ignored = 0;
    let cancelled = 0;
    let unknown = 0;
    let priceChangeCount = 0;

    for (const row of rows) {
      if (row.priceChangeDetected) priceChangeCount += 1;
      if (row.status === 'active') {
        totalActive += 1;
        const annual = Number(row.annualizedCost);
        const monthly = annual / 12;
        const bucket = byCurrency.get(row.currency) ?? {
          currency: row.currency,
          activeCount: 0,
          monthlyCost: 0,
          annualCost: 0,
        };
        bucket.activeCount += 1;
        bucket.monthlyCost += monthly;
        bucket.annualCost += annual;
        byCurrency.set(row.currency, bucket);
      } else if (row.status === 'ignored') ignored += 1;
      else if (row.status === 'cancelled') cancelled += 1;
      else if (row.status === 'unknown') unknown += 1;
    }

    const byCurrencyArr = Array.from(byCurrency.values()).sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );

    res.json({
      totals: {
        active: totalActive,
        ignored,
        cancelled,
        unknown,
        priceChangeDetected: priceChangeCount,
      },
      byCurrency: byCurrencyArr,
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Subscription.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateSubscriptionPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const patch = result.value;
    if (patch.status !== undefined) row.set('status', patch.status);
    if (patch.cadence !== undefined) {
      row.set('cadence', patch.cadence);
      // Keep the derived annual cost consistent with the corrected cadence so
      // the summary rollup and any cached annual figures stay accurate until
      // the next detection refresh. The per-period `amount` is unchanged.
      row.set(
        'annualizedCost',
        annualizeCost(Number(row.amount), patch.cadence).toFixed(4),
      );
    }
    if (patch.cancellationUrl !== undefined) {
      row.set('cancellationUrl', patch.cancellationUrl);
    }
    if (patch.notes !== undefined) row.set('notes', patch.notes);
    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/subscriptions/:id/cancel-impact?horizonMonths=6|12|24
 *
 * Projects the total spend on this subscription over the next N months at its
 * current cadence — i.e. how much the user would save by cancelling. Scoped to
 * the caller's household (404 otherwise). Rejects horizons outside {6, 12, 24}.
 */
router.get('/:id/cancel-impact', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    const horizonMonths = Number(req.query.horizonMonths);
    if (!isAllowedHorizon(horizonMonths)) {
      res.status(400).json({
        error: `horizonMonths must be one of: ${ALLOWED_HORIZON_MONTHS.join(', ')}`,
      });
      return;
    }

    const row = await Subscription.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const impact = computeCancelImpact({
      perPeriodAmount: Number(row.amount),
      cadence: row.cadence,
      horizonMonths,
    });

    res.json({
      amount: impact.amount,
      currency: row.currency,
      count: impact.count,
      horizonMonths: impact.horizonMonths,
    });
  } catch (e) {
    next(e);
  }
});

// Re-export for unit tests that exercise normalization helpers.
export { normalizeMerchantName };

export default router;

import { Router } from 'express';
import { Op } from 'sequelize';
import {
  SUBSCRIPTION_CADENCES,
  type SubscriptionCadence,
} from '../models/PlannedEvent';
import { PlannedEvent, HouseholdMember, Transaction, Insight } from '../models';
import {
  fromSubscriptionStatus,
  serializeSubscription,
  toSubscriptionStatus,
  type SubscriptionStatus,
} from '../expectations/subscriptionMapper';
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
  type ExistingSubscriptionRow,
} from '../subscriptions/detect';
import {
  ALLOWED_HORIZON_MONTHS,
  computeCancelImpact,
  isAllowedHorizon,
} from '../subscriptions/cancelImpact';

const router = Router();

/**
 * The legacy Subscription status set, kept here so PATCH/GET validation and the
 * `/summary` rollup stay byte-identical after the Expectation merge. The merged
 * `PlannedEvent` model stores a different status machine (planned/cancelled/…);
 * the subscriptionMapper translates between the two.
 */
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'cancelled',
  'ignored',
  'unknown',
] as const;

/**
 * Translate a legacy Subscription status filter into a `where` fragment against
 * the merged PlannedEvent columns. This is the exact inverse of
 * `toSubscriptionStatus`: `unknown` is any row flagged uncertain; `cancelled`
 * and `ignored` map to their own (non-uncertain) statuses; `active` is the
 * catch-all — not uncertain and not cancelled/ignored.
 */
function legacyStatusWhere(
  status: SubscriptionStatus,
): Record<string, unknown> {
  switch (status) {
    case 'unknown':
      return { statusUncertain: true };
    case 'cancelled':
      return { status: 'cancelled', statusUncertain: false };
    case 'ignored':
      return { status: 'ignored', statusUncertain: false };
    case 'active':
    default:
      return {
        statusUncertain: false,
        status: { [Op.notIn]: ['cancelled', 'ignored'] },
      };
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 180;
const DEFAULT_MIN_OCCURRENCES = 3;

interface PendingPriceChange {
  id: number;
  prevCents: number;
  newCents: number;
  pctChange: string;
  detectedOn: string;
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

  // Merged Expectation rows require a non-null user_id; subscriptions are a
  // household-level concept, so attribute new rows to the household owner.
  const owner = await HouseholdMember.findOne({
    where: { householdId: args.householdId, role: 'owner' },
    attributes: ['userId'],
    raw: true,
  });
  if (!owner) throw new Error(`household ${args.householdId} has no owner member`);

  const existingRows = await PlannedEvent.findAll({
    where: { householdId: args.householdId, kind: 'subscription' },
  });
  const existing: ExistingSubscriptionRow[] = existingRows.map((row) => ({
    id: row.id,
    normalizedName: row.normalizedName ?? '',
    currency: row.currency,
    amount: String(row.amount),
    status: toSubscriptionStatus(row.status, row.statusUncertain),
    cancellationUrl: row.cancellationUrl,
    notes: row.notes,
  }));

  const ops = mergeDetectionWithExisting(detected, existing);
  for (const op of ops) {
    if (op.kind === 'insert') {
      const mapped = fromSubscriptionStatus(op.status);
      await PlannedEvent.create({
        householdId: args.householdId,
        userId: owner.userId,
        kind: 'subscription',
        type: 'expense',
        source: 'recurring_detection',
        name: op.merchantName,
        normalizedName: op.normalizedName,
        currency: op.currency,
        amount: op.amount,
        cadence: op.cadence,
        lastChargeDate: op.lastChargeDate,
        nextExpectedDate: op.nextExpectedDate,
        expectedDate: op.nextExpectedDate ?? op.lastChargeDate,
        status: mapped.status,
        statusUncertain: mapped.statusUncertain,
        category: op.category,
        annualizedCost: op.annualizedCost,
        cancellationUrl: null,
        notes: null,
      });
    } else {
      // op.patch is keyed by legacy Subscription field names. The detection
      // merge never touches `status` (user-curated state is preserved across
      // refreshes), but translate it defensively if a future change adds it.
      // `merchantName` maps onto the merged model's `name` column.
      const patch: Record<string, unknown> = { ...op.patch };
      if (typeof patch.status === 'string') {
        const mapped = fromSubscriptionStatus(patch.status as SubscriptionStatus);
        patch.status = mapped.status;
        patch.statusUncertain = mapped.statusUncertain;
      }
      if ('merchantName' in patch) {
        patch.name = patch.merchantName;
        delete patch.merchantName;
      }
      await PlannedEvent.update(patch, {
        where: { id: op.id, kind: 'subscription' },
      });
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

    const where: Record<string, unknown> = {
      ...householdWhere(req),
      kind: 'subscription',
    };
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
      // The column stores the merged status machine, so translate the legacy
      // filter into the exact inverse of `toSubscriptionStatus`.
      Object.assign(where, legacyStatusWhere(statusCandidate as SubscriptionStatus));
    }
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const rows = await PlannedEvent.findAll({ where });

    // Pending price changes now derive from OPEN `subscription_price_increase`
    // Insights (the Observation primitive), keyed by the subscription's
    // PlannedEvent id (the Insight's entityId), NOT the retired
    // subscription_price_changes table. Dismissing/resolving the Insight
    // clears the chip on the next read because we only read status='open'.
    const priceInsights = await Insight.findAll({
      where: {
        householdId: auth.household.id,
        type: 'subscription_price_increase',
        status: 'open',
      },
      attributes: ['id', 'entityId', 'metadata', 'detectedAt'],
      raw: true,
    });
    const pendingMap = new Map<number, PendingPriceChange>();
    for (const ins of priceInsights) {
      // If multiple open Insights exist for one subscription, keep the first.
      if (ins.entityId == null || pendingMap.has(ins.entityId)) continue;
      const md = (ins.metadata ?? {}) as {
        previousAmountCents?: number;
        newAmountCents?: number;
        pctChange?: number;
      };
      pendingMap.set(ins.entityId, {
        id: ins.id,
        prevCents: md.previousAmountCents ?? 0,
        newCents: md.newAmountCents ?? 0,
        pctChange: String(md.pctChange ?? 0),
        detectedOn: (ins.detectedAt instanceof Date
          ? ins.detectedAt
          : new Date(ins.detectedAt as string)
        )
          .toISOString()
          .slice(0, 10),
      });
    }

    // Order in JS by the *legacy* serialized shape: the merged `status` column
    // holds a different value set than the legacy enum, and the merchant name
    // lives in `name`, so a DB-level ORDER BY would not match the historical
    // [status ASC, annualizedCost DESC, merchantName ASC] order. Attach any
    // pending price change while mapping. `serializeSubscription` no longer
    // sources `priceChangeDetected` from the (retired) column, so set it here
    // from the chip: true exactly when an open price-increase Insight exists.
    const items = rows
      .map((row) => {
        const pendingPriceChange = pendingMap.get(row.id) ?? null;
        return {
          ...serializeSubscription(row),
          priceChangeDetected: pendingPriceChange != null,
          pendingPriceChange,
        };
      })
      .sort(
        (a, b) =>
          a.status.localeCompare(b.status) ||
          Number(b.annualizedCost) - Number(a.annualizedCost) ||
          a.merchantName.localeCompare(b.merchantName),
      );
    res.json({ items });
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

    const rows = await PlannedEvent.findAll({
      where: { ...householdWhere(req), kind: 'subscription' },
    });
    // Count by the legacy status the DTO exposes, not the merged column.
    const subs = rows.map(serializeSubscription);

    // Price-increase count derives from OPEN `subscription_price_increase`
    // Insights (entityId = subscription's PlannedEvent id), matching the chip
    // — `serializeSubscription` no longer sources it from the retired column.
    const subIds = new Set<number>(rows.map((r) => r.id));
    const priceInsights = await Insight.findAll({
      where: {
        householdId: auth.household.id,
        type: 'subscription_price_increase',
        status: 'open',
      },
      attributes: ['entityId'],
      raw: true,
    });
    const priceChangeSubIds = new Set<number>(
      priceInsights
        .map((i) => i.entityId)
        .filter((x): x is number => x != null && subIds.has(x)),
    );
    const priceChangeCount = priceChangeSubIds.size;

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

    for (const row of subs) {
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
    const row = await PlannedEvent.findOne({
      where: { id, ...householdWhere(req), kind: 'subscription' },
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
    if (patch.status !== undefined) {
      // Inbound is the legacy status; persist as the merged status + flag.
      const mapped = fromSubscriptionStatus(patch.status);
      row.set('status', mapped.status);
      row.set('statusUncertain', mapped.statusUncertain);
    }
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
    res.json(serializeSubscription(row));
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

    const row = await PlannedEvent.findOne({
      where: { id, ...householdWhere(req), kind: 'subscription' },
    });
    if (!row || row.cadence == null) {
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

export default router;

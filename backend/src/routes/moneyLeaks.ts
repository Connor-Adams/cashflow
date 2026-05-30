/**
 * Routes for the money leaks dashboard (Cashflow #220).
 *
 * The endpoint surfaces a list of detected leaks (price-increase
 * subscriptions, small subscriptions, recurring fees, duplicate services,
 * high delivery-fee spend) along with monthly + annual impact totals.
 *
 * Leak rows themselves are deterministic and recomputed on every read,
 * sourced from:
 *   - Subscriptions table (already maintained by /api/subscriptions
 *     refresh-on-read)
 *   - The pure recurring detector from routes/recurring.ts (re-run here
 *     against transactions for the household)
 *   - An aggregated 90-day delivery-spend rollup computed from
 *     transactions whose merchant matches the delivery pattern.
 *
 * Only DISMISSALS are persisted (one table: money_leak_dismissals). A leak
 * is dismissed by its `(leakType, identityKey)` pair; the detector strips
 * matching rows from its output on the next read.
 */

import { Router } from 'express';
import { Op } from 'sequelize';
import {
  MoneyLeakDismissal,
  MONEY_LEAK_TYPES,
  type MoneyLeakType,
} from '../models/MoneyLeakDismissal';
import { Subscription } from '../models/Subscription';
import { Expectation } from '../models/Expectation';
import { Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';
import {
  detectRecurring,
  type RecurringInputTxn,
} from './recurring';
import {
  detectMoneyLeaks,
  type LeakSubscription,
  type LeakRecurringGroup,
  type LeakDeliverySpend,
} from '../money_leaks/detect';

const router = Router();

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECURRING_WINDOW_DAYS = 180;
const DELIVERY_WINDOW_DAYS = 90;
const DELIVERY_MERCHANT_PATTERN =
  /\b(uber\s*eats|doordash|dd\s*\*doordash|skip\s*the\s*dishes|skipthedishes|grubhub|instacart|deliveroo)\b/i;

/**
 * Build the LeakDeliverySpend buckets per currency from the household's
 * trailing 90-day transactions. We use merchant-pattern matching so this
 * works regardless of whether the user's categorization has tagged
 * deliveries explicitly — the pattern catches the major aggregators that
 * appear in canonical merchant text.
 */
function aggregateDeliverySpend(
  rows: Array<{
    currency: string;
    amount: unknown;
    merchantRaw: string | null;
    merchantClean: string | null;
    finalCategory: string | null;
  }>,
): LeakDeliverySpend[] {
  type Bucket = { currency: string; total90d: number; transactionCount: number };
  const byCurrency = new Map<string, Bucket>();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    if (amount >= 0) continue;
    const merchant =
      (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
    if (!merchant) continue;
    if (!DELIVERY_MERCHANT_PATTERN.test(merchant)) continue;
    if (
      classifyPositiveFlow({
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      }) === 'payment'
    ) {
      continue;
    }
    const bucket = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      total90d: 0,
      transactionCount: 0,
    };
    bucket.total90d += Math.abs(amount);
    bucket.transactionCount += 1;
    byCurrency.set(row.currency, bucket);
  }
  return Array.from(byCurrency.values()).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/**
 * Validate a leakType supplied via JSON body or path param. Returns the
 * narrowed MoneyLeakType or null. Centralized so the same check protects
 * both POST /dismiss and DELETE /dismiss.
 */
function parseLeakType(raw: unknown): MoneyLeakType | null {
  if (typeof raw !== 'string') return null;
  if (!(MONEY_LEAK_TYPES as readonly string[]).includes(raw)) return null;
  return raw as MoneyLeakType;
}

function parseIdentityKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 255) return null;
  return trimmed;
}

/**
 * Currency filter parser. Returns the uppercase 3-letter currency or null
 * if the input is missing/invalid (in which case the route serves all
 * currencies).
 */
function parseCurrency(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return null;
  return s;
}

router.get('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const currency = parseCurrency(req.query.currency);

    // 1. Active subscriptions for this household.
    //
    // Primary source: legacy Subscription table (maintained by
    // /api/subscriptions refresh-on-read). Secondary source: Expectation rows
    // with a recurring cadence (cadence != 'one_shot') that originated from
    // Subscription detection (source_subscription_id IS NOT NULL). The two sets
    // are merged by source_subscription_id so each real subscription appears
    // exactly once — the Subscription table row takes precedence because it
    // holds fresher detection data. Expectation-only rows (no matching
    // Subscription) are included so the MoneyLeak view is forward-compatible as
    // new recurring Expectations are written directly to the expectations table.
    const subRows = await Subscription.findAll({
      where: { ...householdWhere(req) },
    });

    // Index existing Subscription rows by id for fast deduplication below.
    const subIdsSeen = new Set<number>(subRows.map((r) => r.id));

    const subscriptions: LeakSubscription[] = subRows.map((row) => ({
      id: row.id,
      merchantName: row.merchantName,
      normalizedName: row.normalizedName,
      currency: row.currency,
      amount: Number(row.amount),
      cadence: row.cadence,
      annualizedCost: Number(row.annualizedCost),
      status: row.status,
      priceChangeDetected: Boolean(row.priceChangeDetected),
      category: row.category,
      lastChargeDate: row.lastChargeDate,
      nextExpectedDate: row.nextExpectedDate,
    }));

    // Add any recurring Expectations that do NOT correspond to an existing
    // Subscription row (i.e. future expectations written directly to the table,
    // not seeded from the old subscriptions table). For now this is primarily
    // a forward-compatibility hook — the migration seeds expectations from
    // subscriptions, so newly created recurring expectations that bypass the
    // old Subscription model will surface in the leak detector.
    const expRows = await Expectation.findAll({
      where: {
        ...householdWhere(req),
        cadence: { [Op.ne]: 'one_shot' },
        // Only include rows not already covered by a Subscription table row.
        [Op.or]: [
          { sourceSubscriptionId: null },
          { sourceSubscriptionId: { [Op.notIn]: subIdsSeen.size > 0 ? [...subIdsSeen] : [-1] } },
        ],
      },
    });
    for (const row of expRows) {
      // Translate Expectation cadence → SubscriptionCadence. Expectation uses
      // 'yearly'; the old Subscription type used 'annual'. We keep 'annual' in
      // the LeakSubscription shape so the detector logic is unchanged.
      type SubCadence = LeakSubscription['cadence'];
      type SubStatus = LeakSubscription['status'];
      const cadenceMap: Record<string, SubCadence> = {
        weekly: 'weekly',
        monthly: 'monthly',
        quarterly: 'quarterly',
        yearly: 'annual',
        custom: 'monthly', // best-effort fallback for custom RRULE cadences
      };
      const cadence: SubCadence = cadenceMap[row.cadence] ?? 'monthly';

      // Translate Expectation status → SubscriptionStatus. Expectation has
      // richer statuses ('planned', 'posted', 'skipped', 'needs_review',
      // 'paused') that don't exist on Subscription. We map them to the closest
      // equivalent so the leak detector can still reason about them.
      const statusMap: Record<string, SubStatus> = {
        planned: 'unknown',
        posted: 'active',
        skipped: 'ignored',
        active: 'active',
        cancelled: 'cancelled',
        paused: 'ignored',
        needs_review: 'unknown',
      };
      const status: SubStatus = statusMap[row.status] ?? 'unknown';

      subscriptions.push({
        id: row.id,
        merchantName: row.name,
        normalizedName: row.normalizedName ?? row.name,
        currency: row.currency,
        amount: Number(row.amount),
        cadence,
        annualizedCost: row.annualizedCost != null ? Number(row.annualizedCost) : 0,
        status,
        priceChangeDetected: Boolean(row.priceChangeDetected),
        category: row.category,
        lastChargeDate: row.lastChargeDate ?? new Date().toISOString().slice(0, 10),
        nextExpectedDate: row.expectedAt,
      });
    }

    // 2. Recurring transaction groups (180d window) — for recurring_fee.
    const sinceRecurring = new Date(
      Date.now() - RECURRING_WINDOW_DAYS * MS_PER_DAY,
    )
      .toISOString()
      .slice(0, 10);
    const recurringRows = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        date: { [Op.gte]: sinceRecurring },
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
    for (const row of recurringRows as unknown as Row[]) {
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
    const recurringItems = detectRecurring(candidates);
    const recurringGroups: LeakRecurringGroup[] = recurringItems.map((item) => ({
      merchant: item.merchant,
      currency: item.currency,
      cadence: item.cadence,
      avgAmount: item.avgAmount,
      occurrences: item.occurrences,
      category: item.category,
      lastSeen: item.lastSeen,
    }));

    // 3. Delivery-spend rollup (90d window).
    const sinceDelivery = new Date(
      Date.now() - DELIVERY_WINDOW_DAYS * MS_PER_DAY,
    )
      .toISOString()
      .slice(0, 10);
    const deliveryRows = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        date: { [Op.gte]: sinceDelivery },
      },
      attributes: [
        'currency',
        'amount',
        'merchantRaw',
        'merchantClean',
        'finalCategory',
      ],
      raw: true,
    });
    const deliverySpend = aggregateDeliverySpend(
      deliveryRows as unknown as Array<{
        currency: string;
        amount: unknown;
        merchantRaw: string | null;
        merchantClean: string | null;
        finalCategory: string | null;
      }>,
    );

    // 4. Dismissals for this household.
    const dismissalRows = await MoneyLeakDismissal.findAll({
      where: { householdId: auth.household.id },
      attributes: ['leakType', 'identityKey'],
      raw: true,
    });
    const dismissals = new Set<string>(
      dismissalRows.map((row) => `${row.leakType}|${row.identityKey}`),
    );

    // 5. Run detection.
    const detected = detectMoneyLeaks({
      subscriptions,
      recurringGroups,
      deliverySpend,
      dismissals,
      currency: currency ?? undefined,
    });

    res.json(detected);
  } catch (e) {
    next(e);
  }
});

router.get('/dismissed', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const rows = await MoneyLeakDismissal.findAll({
      where: { householdId: auth.household.id },
      order: [['updatedAt', 'DESC']],
    });
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        leakType: row.leakType,
        identityKey: row.identityKey,
        snapshot: row.snapshot,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/dismiss', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const leakType = parseLeakType(body.leakType);
    if (!leakType) {
      res.status(400).json({
        error: `leakType must be one of: ${MONEY_LEAK_TYPES.join(', ')}`,
      });
      return;
    }
    const identityKey = parseIdentityKey(body.identityKey);
    if (!identityKey) {
      res.status(400).json({
        error: 'identityKey must be a non-empty string under 256 chars',
      });
      return;
    }
    // Snapshot is optional and free-form. Trim to reasonable size — we want
    // it for audit/undo, not as a full transaction log.
    const snapshot =
      body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;

    // Idempotent upsert: if a dismissal already exists for this household +
    // (leakType, identityKey), bump updated_at and return it. We avoid the
    // ON CONFLICT route here to keep cross-dialect SQL clean.
    const existing = await MoneyLeakDismissal.findOne({
      where: {
        householdId: auth.household.id,
        leakType,
        identityKey,
      },
    });
    if (existing) {
      if (snapshot !== null) {
        existing.set('snapshot', snapshot);
      }
      existing.set('dismissedByUserId', auth.user.id);
      await existing.save();
      res.json({
        id: existing.id,
        leakType: existing.leakType,
        identityKey: existing.identityKey,
        snapshot: existing.snapshot,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      });
      return;
    }
    const row = await MoneyLeakDismissal.create({
      householdId: auth.household.id,
      leakType,
      identityKey,
      snapshot,
      dismissedByUserId: auth.user.id,
    });
    res.status(201).json({
      id: row.id,
      leakType: row.leakType,
      identityKey: row.identityKey,
      snapshot: row.snapshot,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/dismiss/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await MoneyLeakDismissal.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;

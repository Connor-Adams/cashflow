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
 * Only DISMISSALS are persisted. A leak is dismissed by its
 * `(leakType, identityKey)` pair; the detector strips matching rows from its
 * output on the next read.
 *
 * Dismissals live on the Observation primitive (#639): each is an `Insight`
 * row with `status='dismissed'`, `entityType='money_leak'`, `type=leakType`,
 * and `fingerprint=`${leakType}|${identityKey}``. The standalone
 * `money_leak_dismissals` table was folded away — MoneyLeak is fully derived,
 * with dismissal state carried as a dismissed Observation.
 */

import { Router } from 'express';
import { Op } from 'sequelize';
import {
  MONEY_LEAK_TYPES,
  type MoneyLeakType,
} from '../money_leaks/detect';
import { Insight, PlannedEvent, Transaction } from '../models';
import type { InsightType } from '../models/Insight';
import { serializeSubscription } from '../expectations/subscriptionMapper';
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

/**
 * Marker stored in `Insight.entityType` for dismissed-leak Observations.
 * Scopes the dismissal-as-Insight query so it never collides with other
 * Insight types that happen to share a `type` value.
 */
const LEAK_ENTITY_TYPE = 'money_leak';

/**
 * Stable per-dismissal fingerprint = `${leakType}|${identityKey}`. Unique per
 * household via the `insights_household_type_fingerprint` index — mirrors the
 * old `money_leak_dismissals (household, leak_type, identity_key)` unique
 * constraint. The migration that drops the table reconstructs the exact same
 * string, so dismissals survive the fold.
 */
function leakFingerprint(leakType: MoneyLeakType, identityKey: string): string {
  return `${leakType}|${identityKey}`;
}

/**
 * The DTO returned by POST/GET dismiss endpoints. Reconstructed from an
 * Insight row so the response stays byte-stable with the pre-#639 shape
 * (id/leakType/identityKey/snapshot/createdAt/updatedAt). identityKey is the
 * fingerprint tail after `${leakType}|`; snapshot is the Insight's metadata.
 */
function serializeDismissal(row: Insight): {
  id: number;
  leakType: MoneyLeakType;
  identityKey: string;
  snapshot: unknown;
  createdAt: string;
  updatedAt: string;
} {
  const prefix = `${row.type}|`;
  const identityKey = row.fingerprint.startsWith(prefix)
    ? row.fingerprint.slice(prefix.length)
    : row.fingerprint;
  return {
    id: row.id,
    leakType: row.type as MoneyLeakType,
    identityKey,
    snapshot: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const currency = parseCurrency(req.query.currency);

    // 1. Subscriptions for this household — now folded into planned_events as
    //    kind='subscription' (Expectation merge). serializeSubscription maps a
    //    merged row back to the legacy Subscription DTO the detector expects.
    const subRows = await PlannedEvent.findAll({
      where: { ...householdWhere(req), kind: 'subscription' },
    });
    // The price-increase signal now lives in an open Insight
    // (type='subscription_price_increase', entityId=PlannedEvent.id), not the
    // retired planned_events.price_change_detected column. Build the set of
    // subscriptions with an OPEN price-increase Insight; dismissing/resolving
    // the Insight clears the leak on the next read.
    const priceInsights = await Insight.findAll({
      where: {
        ...householdWhere(req),
        type: 'subscription_price_increase',
        status: 'open',
      },
      attributes: ['entityId'],
      raw: true,
    });
    const priceUp = new Set<number>(
      priceInsights.map((i) => i.entityId).filter((x): x is number => x != null),
    );
    const subscriptions: LeakSubscription[] = subRows
      .map(serializeSubscription)
      .map((row) => ({
        id: row.id,
        merchantName: row.merchantName,
        normalizedName: row.normalizedName,
        currency: row.currency,
        amount: Number(row.amount),
        cadence: row.cadence,
        annualizedCost: Number(row.annualizedCost),
        status: row.status,
        priceChangeDetected: priceUp.has(row.id),
        category: row.category,
        lastChargeDate: row.lastChargeDate,
        nextExpectedDate: row.nextExpectedDate,
      }));

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

    // 4. Dismissals for this household — dismissed-leak Observations (#639).
    const dismissalRows = await Insight.findAll({
      where: {
        householdId: auth.household.id,
        entityType: LEAK_ENTITY_TYPE,
        status: 'dismissed',
        type: { [Op.in]: MONEY_LEAK_TYPES as readonly string[] },
      },
      attributes: ['fingerprint'],
      raw: true,
    });
    // fingerprint already IS `${leakType}|${identityKey}`, which is exactly the
    // dismissed-key the detector checks against.
    const dismissals = new Set<string>(
      dismissalRows.map((row) => row.fingerprint),
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
    const rows = await Insight.findAll({
      where: {
        householdId: auth.household.id,
        entityType: LEAK_ENTITY_TYPE,
        status: 'dismissed',
        type: { [Op.in]: MONEY_LEAK_TYPES as readonly string[] },
      },
      order: [['updatedAt', 'DESC']],
    });
    res.json({
      items: rows.map(serializeDismissal),
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
    // it for audit/undo, not as a full transaction log. Stored as the
    // dismissed Observation's metadata.
    const snapshot =
      body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;

    const fingerprint = leakFingerprint(leakType, identityKey);

    // Idempotent upsert: if a dismissed-leak Observation already exists for
    // this household + (leakType, identityKey), bump updated_at and return it.
    // We avoid ON CONFLICT to keep cross-dialect SQL clean.
    const existing = await Insight.findOne({
      where: {
        householdId: auth.household.id,
        entityType: LEAK_ENTITY_TYPE,
        type: leakType,
        fingerprint,
      },
    });
    if (existing) {
      if (snapshot !== null) {
        existing.set('metadata', snapshot);
      }
      existing.set('userId', auth.user.id);
      existing.set('status', 'dismissed');
      await existing.save();
      res.json(serializeDismissal(existing));
      return;
    }
    const row = await Insight.create({
      householdId: auth.household.id,
      userId: auth.user.id,
      type: leakType as InsightType,
      severity: 'info',
      title: `Dismissed money leak: ${leakType}`,
      description: null,
      entityType: LEAK_ENTITY_TYPE,
      entityId: null,
      status: 'dismissed',
      fingerprint,
      metadata: snapshot,
      detectedAt: new Date(),
    });
    res.status(201).json(serializeDismissal(row));
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
    const row = await Insight.findOne({
      where: {
        id,
        ...householdWhere(req),
        entityType: LEAK_ENTITY_TYPE,
        status: 'dismissed',
        type: { [Op.in]: MONEY_LEAK_TYPES as readonly string[] },
      },
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

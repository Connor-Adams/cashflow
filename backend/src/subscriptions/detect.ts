/**
 * Pure helpers for the subscription optimizer (Cashflow #205).
 *
 * The actual recurring-charge detection lives in routes/recurring.ts —
 * detectRecurring() groups transactions by merchant+currency, classifies
 * cadence, and returns one RecurringItem per group. This module takes that
 * raw detector output, annualizes the cost, optionally flags a price
 * increase given the prior amount, and merges with already-persisted
 * subscription rows so user-edited fields (status, cancellationUrl, notes)
 * are preserved across refresh-on-read.
 *
 * Keeping these helpers pure (no DB, no Express) makes the price-change
 * heuristic and merge logic trivially unit-testable.
 */
import type { RecurringItem } from '../routes/recurring';
import type {
  SubscriptionCadence,
  SubscriptionStatus,
} from '../models/Subscription';
import { periodsPerYear } from './cancelImpact';

/**
 * Conservative threshold for "price went up". Real-world subscriptions
 * commonly drift by ±5¢ over time as merchants adjust microtransaction fees
 * or apply rounding, and FX-pegged services swing as exchange rates move.
 * Requiring a >10% increase keeps the flag meaningful — Netflix going from
 * $15.99 to $17.99 (~12.5%) trips it, but a $9.99 → $10.20 round trip
 * (~2%) does not.
 *
 * TODO(#205-followup): move this into per-household settings once we know
 * how users want to tune the noise floor.
 */
export const PRICE_INCREASE_THRESHOLD = 0.1;

/**
 * Annualize a cadence-aware recurring amount. Returns the absolute annual
 * total a user would spend at the current cadence and amount. Amounts come
 * in as negative numbers for charges per the codebase convention; we take
 * the absolute value so callers don't have to remember the sign.
 *
 * Multiplies the per-period charge by the cadence's occurrences-per-year
 * (52 weekly, 12 monthly, 4 quarterly, 2 semiannual, 1 annual).
 */
export function annualizeCost(
  amount: number,
  cadence: SubscriptionCadence,
): number {
  return Math.abs(amount) * periodsPerYear(cadence);
}

/**
 * Decide whether the current amount is enough higher than a prior amount
 * to count as a meaningful price increase. Uses absolute values so the
 * caller need not normalize signs.
 *
 * Returns false if priorAmount is missing or zero — we cannot meaningfully
 * compute a percentage change in either case.
 */
export function detectPriceIncrease(
  currentAmount: number,
  priorAmount: number | null,
): boolean {
  if (priorAmount == null) return false;
  const prior = Math.abs(priorAmount);
  if (prior === 0) return false;
  const current = Math.abs(currentAmount);
  const delta = (current - prior) / prior;
  return delta > PRICE_INCREASE_THRESHOLD;
}

/** Normalized lookup key used to match a detected item to a persisted row. */
export function normalizeMerchantName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Existing subscription rows we read out of the DB, keyed by normalizedName+currency. */
export interface ExistingSubscriptionRow {
  id: number;
  normalizedName: string;
  currency: string;
  amount: string;
  status: SubscriptionStatus;
  cancellationUrl: string | null;
  notes: string | null;
}

/** Output of mergeDetectionWithExisting — either an upsert payload or a status-only update. */
export type SubscriptionMergeOp =
  | {
      kind: 'insert';
      merchantName: string;
      normalizedName: string;
      currency: string;
      amount: string;
      cadence: SubscriptionCadence;
      lastChargeDate: string;
      nextExpectedDate: string | null;
      status: SubscriptionStatus;
      category: string | null;
      annualizedCost: string;
      priceChangeDetected: boolean;
    }
  | {
      kind: 'update';
      id: number;
      patch: {
        merchantName: string;
        amount: string;
        cadence: SubscriptionCadence;
        lastChargeDate: string;
        nextExpectedDate: string | null;
        category: string | null;
        annualizedCost: string;
        priceChangeDetected: boolean;
      };
    };

/**
 * Reconcile freshly detected recurring items against the persisted
 * subscription rows for a household. Detection-derived fields (amount,
 * cadence, lastChargeDate, nextExpectedDate, category, annualizedCost,
 * priceChangeDetected) get overwritten on every refresh; user-curated
 * fields (status, cancellationUrl, notes) are NEVER touched here — they
 * live only in the DB and survive untouched.
 *
 * If no existing row matches a detected item, we propose an INSERT with
 * status='active'. If a detected item is missing from the existing set
 * (the subscription has stopped charging within the detection window),
 * the caller can decide what to do; this function does not propose
 * deletions because a user might keep a long-tail record of a cancelled
 * subscription on purpose.
 */
export function mergeDetectionWithExisting(
  detected: RecurringItem[],
  existing: ExistingSubscriptionRow[],
): SubscriptionMergeOp[] {
  const existingByKey = new Map<string, ExistingSubscriptionRow>();
  for (const row of existing) {
    existingByKey.set(`${row.normalizedName}\0${row.currency}`, row);
  }

  const ops: SubscriptionMergeOp[] = [];
  for (const item of detected) {
    const normalizedName = normalizeMerchantName(item.merchant);
    const currency = item.currency;
    const key = `${normalizedName}\0${currency}`;
    const annualized = annualizeCost(item.avgAmount, item.cadence);
    const amountAbs = Math.abs(item.avgAmount);
    const match = existingByKey.get(key);
    if (match) {
      const priorAmount = Number(match.amount);
      const priceChange = detectPriceIncrease(amountAbs, priorAmount);
      ops.push({
        kind: 'update',
        id: match.id,
        patch: {
          merchantName: item.merchant,
          amount: amountAbs.toFixed(4),
          cadence: item.cadence,
          lastChargeDate: item.lastSeen,
          nextExpectedDate: item.nextExpected ?? null,
          category: item.category,
          annualizedCost: annualized.toFixed(4),
          priceChangeDetected: priceChange,
        },
      });
    } else {
      ops.push({
        kind: 'insert',
        merchantName: item.merchant,
        normalizedName,
        currency,
        amount: amountAbs.toFixed(4),
        cadence: item.cadence,
        lastChargeDate: item.lastSeen,
        nextExpectedDate: item.nextExpected ?? null,
        status: 'active',
        category: item.category,
        annualizedCost: annualized.toFixed(4),
        priceChangeDetected: false,
      });
    }
  }
  return ops;
}

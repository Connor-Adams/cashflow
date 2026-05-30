/**
 * Nightly job that detects subscription price changes by comparing
 * the most recent charge against the median of historical charges.
 * Emits SubscriptionPriceChange rows for changes >= 5%.
 */
import { QueryTypes } from 'sequelize';
import { Subscription } from '../models/Subscription';
import { SubscriptionPriceChange } from '../models/SubscriptionPriceChange';
import { sequelize } from '../models';
import { logger } from '../observability/logger';

const THRESHOLD = 0.05; // 5%
const WINDOW_DAYS = 90;
const MIN_HISTORY = 2; // minimum historical charges (excluding latest) to compute baseline

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

type PriceChangeResult = {
  detected: number;
  skipped: number;
  households: number;
};

export async function runDetectSubscriptionPriceChanges(): Promise<PriceChangeResult> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Get all active subscriptions across all households
  const subscriptions = await Subscription.findAll({
    where: { status: 'active' },
    attributes: ['id', 'householdId', 'normalizedName', 'currency'],
  });

  const householdIds = new Set(subscriptions.map((s) => s.householdId));
  let detected = 0;
  let skipped = 0;

  for (const sub of subscriptions) {
    try {
      // Query recent negative-amount transactions matching this merchant+currency
      type TxnRow = { id: number; date: string; amount: string };
      const txns = await sequelize.query<TxnRow>(
        `SELECT id, date, amount
         FROM transactions
         WHERE household_id = :householdId
           AND currency = :currency
           AND amount < 0
           AND date >= :since
           AND LOWER(COALESCE(merchant_clean, merchant_raw, '')) = :normalizedName
         ORDER BY date DESC
         LIMIT 20`,
        {
          replacements: {
            householdId: sub.householdId,
            currency: sub.currency,
            since,
            normalizedName: sub.normalizedName,
          },
          type: QueryTypes.SELECT,
        },
      );

      if (txns.length < MIN_HISTORY + 1) {
        skipped++;
        continue;
      }

      const first = txns[0]!;
      const latest = Math.abs(Number(first.amount));
      const historical = txns.slice(1).map((t) => Math.abs(Number(t!.amount)));

      const baseline = median(historical);
      if (baseline === 0) { skipped++; continue; }

      const pctChange = (latest - baseline) / baseline;
      if (Math.abs(pctChange) < THRESHOLD) { skipped++; continue; }

      const prevCents = Math.round(baseline * 100);
      const newCents = Math.round(latest * 100);
      const todayStr = new Date().toISOString().slice(0, 10);

      // Idempotency: skip if unacknowledged row for this (subscriptionId, newAmountCents) already exists
      const existing = await SubscriptionPriceChange.findOne({
        where: {
          subscriptionId: sub.id,
          newAmountCents: newCents,
          acknowledgedAt: null,
        },
      });
      if (existing) { skipped++; continue; }

      // Use the userId from the most-recent triggering transaction's household membership
      // We store userId = 0 as a sentinel when no user is available (job context)
      // The actual userId is set by the route when a user triggers ack
      const triggeringTxnId = Number(first.id);

      await SubscriptionPriceChange.create({
        subscriptionId: sub.id,
        userId: null, // job-created; no specific user context
        detectedOn: todayStr,
        previousAmountCents: prevCents,
        newAmountCents: newCents,
        pctChange: String(pctChange.toFixed(3)),
        currency: sub.currency,
        triggeringTransactionId: triggeringTxnId,
        acknowledgedAt: null,
        acknowledgedByUserId: null,
      });

      detected++;
    } catch (e) {
      logger.warn({ subscriptionId: sub.id, err: e }, 'detect_subscription_price_change_skip');
      skipped++;
    }
  }

  return { detected, skipped, households: householdIds.size };
}

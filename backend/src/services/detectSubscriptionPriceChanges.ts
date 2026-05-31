import { Op } from 'sequelize';
import { Subscription, SubscriptionPriceChange, Transaction } from '../models';
import { logger } from '../observability/logger';

const CHANGE_THRESHOLD = 0.05; // 5%
const BASELINE_DAYS = 60;
const LOOKBACK_DAYS = 90;
const MIN_HISTORICAL_CHARGES = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function toDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function detectSubscriptionPriceChanges(): Promise<{
  processed: number;
  detected: number;
  skipped: number;
}> {
  const allSubs = await Subscription.findAll({ where: { status: 'active' } });
  let processed = 0;
  let detected = 0;
  let skipped = 0;

  for (const sub of allSubs) {
    processed++;
    try {
      const windowStart = toDate(LOOKBACK_DAYS);
      const baselineEnd = toDate(LOOKBACK_DAYS - BASELINE_DAYS);

      const txns = await Transaction.findAll({
        where: {
          householdId: sub.householdId,
          merchantClean: { [Op.like]: `%${sub.normalizedName}%` },
          date: { [Op.gte]: windowStart },
          amount: { [Op.lt]: '0' },
        },
        order: [['date', 'DESC']],
        attributes: ['id', 'date', 'amount', 'currency'],
      });

      if (txns.length === 0) { skipped++; continue; }

      // Only process single-currency subscriptions
      const currencies = new Set(txns.map((t) => t.currency));
      if (currencies.size > 1) {
        logger.info({ subscriptionId: sub.id }, 'detectSubscriptionPriceChanges: skipping multi-currency sub');
        skipped++;
        continue;
      }

      const currency = txns[0].currency;
      if (currency !== sub.currency) { skipped++; continue; }

      const latestTxn = txns[0];
      const latestAmount = Math.abs(Number(latestTxn.amount));
      const latestAmountCents = Math.round(latestAmount * 100);

      const baselineTxns = txns.filter((t) => t.date <= baselineEnd);
      if (baselineTxns.length < MIN_HISTORICAL_CHARGES) { skipped++; continue; }

      const baselineAmounts = baselineTxns.map((t) => Math.abs(Number(t.amount)));
      const baselineMedian = median(baselineAmounts);
      if (baselineMedian === 0) { skipped++; continue; }

      const pctChange = (latestAmount - baselineMedian) / baselineMedian;
      if (Math.abs(pctChange) < CHANGE_THRESHOLD) { skipped++; continue; }

      const prevAmountCents = Math.round(baselineMedian * 100);

      // Idempotency: skip if unacknowledged row already exists for this new amount
      const existing = await SubscriptionPriceChange.findOne({
        where: {
          subscriptionId: sub.id,
          newAmountCents: latestAmountCents,
          acknowledgedAt: null,
        },
      });
      if (existing) { skipped++; continue; }

      await SubscriptionPriceChange.create({
        subscriptionId: sub.id,
        householdId: sub.householdId,
        detectedOn: new Date().toISOString().slice(0, 10),
        previousAmountCents: prevAmountCents,
        newAmountCents: latestAmountCents,
        pctChange: String((pctChange * 100).toFixed(3)),
        currency,
        triggeringTransactionId: latestTxn.id,
      });

      // Mark the boolean flag for quick UI access
      await sub.update({ priceChangeDetected: true });
      detected++;
      logger.info({ subscriptionId: sub.id, pctChange }, 'detectSubscriptionPriceChanges: detected price change');
    } catch (err) {
      logger.error({ subscriptionId: sub.id, err }, 'detectSubscriptionPriceChanges: error processing sub');
      skipped++;
    }
  }

  return { processed, detected, skipped };
}

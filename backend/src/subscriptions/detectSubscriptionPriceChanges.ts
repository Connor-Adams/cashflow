import { Op } from 'sequelize';
import { PlannedEvent, Transaction, SubscriptionPriceChange } from '../models';
import { serializeSubscription } from '../expectations/subscriptionMapper';
import { logger } from '../observability/logger';

/**
 * Compute the median of an array of numbers. Returns NaN for empty arrays.
 */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Scan all active subscriptions and detect price changes by comparing the most
 * recent charge amount against the median of prior charges in the last 90 days.
 * Inserts a SubscriptionPriceChange row (idempotent via unique partial index)
 * when the deviation exceeds 5%.
 *
 * Post-Expectation-fold: subscriptions are PlannedEvent rows with
 * kind='subscription'. Legacy status 'active' maps to {status:'planned',
 * statusUncertain:false}. Rows are serialized to the legacy Subscription DTO
 * (via serializeSubscription) so the detection math below reads merchantName,
 * householdId, currency, etc. unchanged. `sub.id` is now the planned_events.id,
 * which becomes the SubscriptionPriceChange.subscriptionId (the new canonical
 * identity — see routes/subscriptions.ts pendingMap join on row.id).
 */
export async function detectSubscriptionPriceChanges(): Promise<{
  detected: number;
  skipped: number;
}> {
  let detected = 0;
  let skipped = 0;

  const activeRows = await PlannedEvent.findAll({
    where: { kind: 'subscription', status: 'planned', statusUncertain: false },
  });
  const activeSubscriptions = activeRows.map((row) => serializeSubscription(row));

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  for (const sub of activeSubscriptions) {
    const merchantPattern = sub.merchantName.replace(/[%_\\]/g, '\\$&');

    // Fetch matching transactions in the last 90 days
    const txns = await Transaction.findAll({
      where: {
        householdId: sub.householdId,
        currency: sub.currency,
        merchantClean: { [Op.iLike]: `%${merchantPattern}%` },
        date: { [Op.gte]: since },
      },
      order: [['date', 'DESC']],
      attributes: ['id', 'amount', 'currency', 'date'],
      raw: true,
    });

    type TxnRow = { id: number; amount: unknown; currency: string; date: string };
    const rows = txns as unknown as TxnRow[];

    if (rows.length < 2) {
      skipped++;
      continue;
    }

    const latestRow = rows[0];
    const priorRows = rows.slice(1);

    const latestCurrency = latestRow.currency;
    if (latestCurrency !== sub.currency) {
      logger.warn(
        { subscriptionId: sub.id, latestCurrency, subCurrency: sub.currency },
        'subscription_price_change_currency_mismatch',
      );
      skipped++;
      continue;
    }

    // Convert to cents (amount is stored as a decimal string like "-9.99")
    const latestCents = Math.round(parseFloat(String(latestRow.amount)) * 100);
    const priorCents = priorRows.map((r) =>
      Math.round(parseFloat(String(r.amount)) * 100),
    );

    const baselineCents = median(priorCents);

    if (!Number.isFinite(baselineCents) || baselineCents === 0) {
      skipped++;
      continue;
    }

    const diff = Math.abs(latestCents - baselineCents);
    const ratio = diff / Math.abs(baselineCents);

    if (ratio < 0.05) {
      skipped++;
      continue;
    }

    // Check idempotency: is there already an unacknowledged row for this
    // (subscriptionId, newAmountCents) pair?
    const existing = await SubscriptionPriceChange.findOne({
      where: {
        subscriptionId: sub.id,
        newAmountCents: latestCents,
        acknowledgedAt: null,
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    const pctChange = ((latestCents - baselineCents) / Math.abs(baselineCents)) * 100;

    await SubscriptionPriceChange.create({
      subscriptionId: sub.id,
      householdId: sub.householdId,
      detectedOn: new Date().toISOString().slice(0, 10),
      previousAmountCents: Math.round(baselineCents),
      newAmountCents: latestCents,
      pctChange: pctChange.toFixed(3),
      currency: sub.currency,
      triggeringTransactionId: latestRow.id ?? null,
      acknowledgedAt: null,
      acknowledgedByUserId: null,
      createdAt: new Date(),
    });

    detected++;
  }

  return { detected, skipped };
}

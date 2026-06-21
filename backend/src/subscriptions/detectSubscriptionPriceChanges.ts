import { Op } from 'sequelize';
import { PlannedEvent, Transaction, sequelize } from '../models';
import { upsertInsight } from '../insights/runDetectors';
import type { DetectedInsight } from '../insights/detectors';
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

export type PriceChangeEvaluation = {
  latestCents: number;
  baselineCents: number;
  /** Signed fraction, e.g. 0.1 for +10%. */
  delta: number;
};

/**
 * Pure decision: given the latest charge amount and the prior charge amounts
 * (decimal strings like "-9.99" or numbers), decide whether this is a
 * detectable price *increase* (>= 5% above the 90-day median).
 *
 * Amounts are normalized to absolute cents (expenses are stored negative), so a
 * larger charge is a larger magnitude. Returns `null` when there is no usable
 * baseline (fewer than 2 prior charges / zero/NaN median) or when the change is
 * a drop or smaller than the 5% threshold.
 */
export function evaluatePriceChange(
  latestAmount: number | string,
  priorAmounts: Array<number | string>,
): PriceChangeEvaluation | null {
  if (priorAmounts.length < 1) return null;
  const latestCents = Math.abs(Math.round(parseFloat(String(latestAmount)) * 100));
  const priorCents = priorAmounts.map((a) =>
    Math.abs(Math.round(parseFloat(String(a)) * 100)),
  );
  const baselineCents = median(priorCents);
  if (!Number.isFinite(baselineCents) || baselineCents === 0) return null;
  const delta = (latestCents - baselineCents) / Math.abs(baselineCents);
  if (delta < 0.05) return null; // increase-only; <5% increase (incl. any drop) skipped
  return { latestCents, baselineCents, delta };
}

/**
 * Scan all active subscriptions and detect price *increases* by comparing the
 * most recent charge amount against the median of prior charges in the last 90
 * days. Emits a `subscription_price_increase` Insight (the Observation
 * primitive) via the shared `upsertInsight` helper when the increase is >= 5%.
 * The upsert is status-preserving (keyed by household + type + fingerprint), so
 * a dismissed/resolved Insight is never reopened on a re-run.
 *
 * Post-Expectation-fold: subscriptions are PlannedEvent rows with
 * kind='subscription'. Legacy status 'active' maps to {status:'planned',
 * statusUncertain:false}. Rows are serialized to the legacy Subscription DTO
 * (via serializeSubscription) so the detection math below reads merchantName,
 * householdId, currency, etc. unchanged. `sub.id` is the planned_events.id,
 * which becomes the Insight's entityId (entityType='expectation').
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

    // Fetch matching CHARGES in the last 90 days. Spend is stored negative;
    // refunds/credits arrive positive and must be excluded — the math below
    // takes Math.abs, so a refund row would read as a fake price increase.
    const txns = await Transaction.findAll({
      where: {
        householdId: sub.householdId,
        currency: sub.currency,
        merchantClean: { [Op.iLike]: `%${merchantPattern}%` },
        date: { [Op.gte]: since },
        amount: { [Op.lt]: 0 },
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

    const evaluation = evaluatePriceChange(
      String(latestRow.amount),
      priorRows.map((r) => String(r.amount)),
    );

    if (!evaluation) {
      skipped++;
      continue;
    }

    const { latestCents, baselineCents, delta } = evaluation;
    const pctChange = delta * 100;
    const finding: DetectedInsight = {
      type: 'subscription_price_increase' as const,
      severity: 'warning' as const,
      title: `${sub.merchantName} price increased`,
      description: `${sub.merchantName} is now ${(latestCents / 100).toFixed(2)} ${sub.currency}/${sub.cadence === 'weekly' ? 'wk' : 'mo'} (was ${(baselineCents / 100).toFixed(2)}, +${pctChange.toFixed(0)}%).`,
      entityType: 'expectation',
      entityId: sub.id,
      fingerprint: `subscription_price_increase:${sub.id}:${latestCents}`,
      metadata: {
        previousAmountCents: Math.round(baselineCents),
        newAmountCents: latestCents,
        pctChange: Number(pctChange.toFixed(3)),
        triggeringTransactionId: latestRow.id ?? null,
        currency: sub.currency,
      },
    };
    await sequelize.transaction((t) =>
      upsertInsight(sub.householdId, finding, { now: new Date(), userId: null }, t),
    );
    detected++;
  }

  return { detected, skipped };
}

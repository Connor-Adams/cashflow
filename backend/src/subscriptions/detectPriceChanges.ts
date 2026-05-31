/**
 * Price-change detection for subscriptions (issue #441).
 *
 * Compares each subscription's current amount against the latest
 * acknowledged SubscriptionPriceChange row. If the amount has changed
 * by more than PRICE_CHANGE_THRESHOLD_PCT, we create a new record and
 * set priceChangeDetected = true on the subscription.
 */
import { Op } from 'sequelize';
import { Subscription } from '../models/Subscription';
import { SubscriptionPriceChange } from '../models/SubscriptionPriceChange';

/** Minimum relative change to be reported (1% by default). */
const PRICE_CHANGE_THRESHOLD_PCT = 0.01;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function detectSubscriptionPriceChanges(
  householdId: number,
): Promise<{ detected: number; alreadyFlagged: number }> {
  const subs = await Subscription.findAll({
    where: { householdId, status: ['active', 'unknown'] },
  });

  let detected = 0;
  let alreadyFlagged = 0;

  for (const sub of subs) {
    const currentAmount = Number(sub.amount);
    if (!Number.isFinite(currentAmount) || currentAmount === 0) continue;

    // Find the most recent price-change record (regardless of ack state)
    // to determine the "baseline" the user last saw.
    const latest = await SubscriptionPriceChange.findOne({
      where: { subscriptionId: sub.id },
      order: [['detected_on', 'DESC']],
    });

    const baselineAmount = latest ? Number(latest.newAmount) : null;

    if (baselineAmount === null) {
      // No history yet — nothing to compare against.
      continue;
    }

    // Compute relative change.
    const relativeDelta = Math.abs(currentAmount - baselineAmount) / Math.abs(baselineAmount);
    if (relativeDelta < PRICE_CHANGE_THRESHOLD_PCT) continue;

    // Check if we already have an unacknowledged record for today.
    const today = todayIso();
    const existing = await SubscriptionPriceChange.findOne({
      where: {
        subscriptionId: sub.id,
        detectedOn: today,
      },
    });

    if (existing) {
      // Update the new_amount in case it changed again within the same day.
      if (Number(existing.newAmount) !== currentAmount) {
        await existing.update({ newAmount: String(currentAmount) });
      }
      alreadyFlagged += 1;
    } else {
      await SubscriptionPriceChange.create({
        subscriptionId: sub.id,
        householdId,
        previousAmount: String(baselineAmount),
        newAmount: String(currentAmount),
        currency: sub.currency,
        detectedOn: today,
        acknowledgedAt: null,
      });
      detected += 1;
    }

    // Ensure the subscription flag is set.
    if (!sub.priceChangeDetected) {
      await sub.update({ priceChangeDetected: true });
    }
  }

  return { detected, alreadyFlagged };
}

/**
 * Seed the price-change baseline for a subscription that has no history.
 * Called after the first detection run creates a subscription row so that
 * subsequent runs have a reference point.
 */
export async function seedPriceChangeBaseline(
  subscriptionId: number,
  householdId: number,
  amount: string,
  currency: string,
): Promise<void> {
  const exists = await SubscriptionPriceChange.findOne({
    where: { subscriptionId },
  });
  if (exists) return; // already seeded

  const today = todayIso();
  // Create a seeding record that is pre-acknowledged so it doesn't show up as
  // a change — it just establishes the amount baseline.
  await SubscriptionPriceChange.create({
    subscriptionId,
    householdId,
    previousAmount: amount,
    newAmount: amount,
    currency,
    detectedOn: today,
    acknowledgedAt: new Date(),
  });
}

/**
 * List unacknowledged price changes for a household.
 */
export async function listPendingPriceChanges(householdId: number) {
  return SubscriptionPriceChange.findAll({
    where: {
      householdId,
      acknowledgedAt: { [Op.is]: null as unknown as null },
    },
    order: [['detected_on', 'DESC']],
  });
}

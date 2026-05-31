/**
 * Nightly job: scan all active household subscriptions for price changes
 * (issue #441). Runs once per day; creates SubscriptionPriceChange rows
 * and sets priceChangeDetected on the parent Subscription when a change
 * exceeds the threshold.
 */
import { defineJob } from '../registry';
import * as env from '../../config/env';
import { Household } from '../../models';
import { detectSubscriptionPriceChanges } from '../../subscriptions/detectPriceChanges';

defineJob({
  name: 'subscription_price_check',
  cronDefault: env.subscriptionPriceCheckCron,
  enabledDefault: env.subscriptionPriceCheckEnabled,
  handler: async () => {
    const households = await Household.findAll({ attributes: ['id'] });
    let totalDetected = 0;
    let totalAlreadyFlagged = 0;
    for (const hh of households) {
      const result = await detectSubscriptionPriceChanges(hh.id);
      totalDetected += result.detected;
      totalAlreadyFlagged += result.alreadyFlagged;
    }
    return {
      households: households.length,
      detected: totalDetected,
      alreadyFlagged: totalAlreadyFlagged,
    };
  },
});

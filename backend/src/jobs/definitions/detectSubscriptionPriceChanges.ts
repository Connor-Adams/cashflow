import { defineJob } from '../registry';
import { detectSubscriptionPriceChanges } from '../../subscriptions/detectSubscriptionPriceChanges';
import * as env from '../../config/env';

defineJob({
  name: 'detect_subscription_price_changes',
  cronDefault: env.subscriptionPriceDetectCron,
  enabledDefault: env.subscriptionPriceDetectEnabled,
  handler: async () => {
    const result = await detectSubscriptionPriceChanges();
    return { summary: result };
  },
});

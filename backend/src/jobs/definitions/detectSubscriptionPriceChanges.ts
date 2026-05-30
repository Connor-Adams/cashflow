import { defineJob } from '../registry';
import { runDetectSubscriptionPriceChanges } from '../../services/detectSubscriptionPriceChanges';

defineJob({
  name: 'detect_subscription_price_changes',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => {
    const summary = await runDetectSubscriptionPriceChanges();
    return { summary };
  },
});

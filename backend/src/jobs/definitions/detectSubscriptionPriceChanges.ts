import { defineJob } from '../registry';
import { detectSubscriptionPriceChanges } from '../../services/detectSubscriptionPriceChanges';

defineJob({
  name: 'detect_subscription_price_changes',
  cronDefault: '0 3 * * *', // 3am nightly
  enabledDefault: true,
  handler: async () => {
    const result = await detectSubscriptionPriceChanges();
    return result;
  },
});

import { defineJob } from '../registry';
import { runQuoteSchedulerTick } from '../../integrations/yahoo/scheduler';
import * as env from '../../config/env';

defineJob({
  name: 'yahoo_quote_refresh',
  cronDefault: env.quoteTickCron,
  enabledDefault: env.quoteSchedulerEnabled,
  handler: async () => {
    const r = await runQuoteSchedulerTick();
    return { summary: { ...r } };
  },
});

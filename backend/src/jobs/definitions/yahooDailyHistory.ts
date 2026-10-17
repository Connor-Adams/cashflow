import { defineJob } from '../registry';
import { refreshHeldDailyPrices } from '../../portfolio/backfill';
import * as env from '../../config/env';

// security_daily_prices used to be filled only lazily, when someone opened a
// security's detail page, so today-change / 30d return went stale for every
// holding nobody looked at. 02:30 UTC is after every North American close
// and before the 03:00 daily_snapshot. Shares the Yahoo scheduler's kill
// switch (off under NODE_ENV=test).
defineJob({
  name: 'yahoo_daily_history_refresh',
  cronDefault: '30 2 * * *',
  enabledDefault: env.quoteSchedulerEnabled,
  handler: async () => {
    const r = await refreshHeldDailyPrices();
    return { summary: { ...r } };
  },
});

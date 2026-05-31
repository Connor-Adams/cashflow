import { defineJob } from '../registry';
import {
  autoMatchDividends,
  notifyUnmatchedDividends,
} from '../../portfolio/dividendMatcher';
import * as env from '../../config/env';

/**
 * Daily dividend payout reconciliation (#305). Runs after `daily_snapshot`
 * (03:00) at 03:30: auto-matches expected dividends to cash transactions, then
 * fires `dividend.unmatched` notifications for payouts still unmatched past the
 * grace window.
 */
defineJob({
  name: 'dividend_reconciliation',
  cronDefault: env.dividendMatchCron,
  enabledDefault: env.dividendMatchEnabled,
  handler: async () => {
    const match = await autoMatchDividends();
    const notify = await notifyUnmatchedDividends();
    return { summary: { ...match, ...notify } };
  },
});

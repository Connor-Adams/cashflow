import { defineJob } from '../registry';
import { backfillUsdCadHistory } from '../../fx/backfillUsdCadHistory';
import { logger } from '../../observability/logger';

defineJob({
  name: 'usdcad_backfill',
  cronDefault: '0 12 * * *', // daily noon UTC
  enabledDefault: true,
  handler: async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fiveYearsAgo = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 5);
      return d.toISOString().slice(0, 10);
    })();
    try {
      await backfillUsdCadHistory({ startDate: fiveYearsAgo, endDate: today });
      return { summary: { startDate: fiveYearsAgo, endDate: today, status: 'ok' } };
    } catch (err) {
      logger.error({ err }, 'usdcad_backfill_job_failed');
      throw err;
    }
  },
});

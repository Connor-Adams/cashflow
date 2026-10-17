/**
 * Scheduled insight-detector run.
 *
 * The eight detectors in `src/insights/detectors` previously ran only when a
 * user pressed the button behind POST /api/insights/run, so the insights page
 * showed whatever was found the last time somebody clicked. 05:00 UTC puts
 * this after detect_subscription_price_changes (02:00) so subscription price
 * hikes are already recorded when detectRecurringIncrease builds its skip-set.
 */
import { defineJob } from '../registry';
import { runAllHouseholdDetectors } from '../../insights/runAllHouseholdDetectors';
import * as env from '../../config/env';

defineJob({
  name: 'run_insight_detectors',
  cronDefault: env.insightDetectorsCron,
  enabledDefault: env.insightDetectorsEnabled,
  handler: async () => {
    const summary = await runAllHouseholdDetectors();
    return { summary: { ...summary } };
  },
});

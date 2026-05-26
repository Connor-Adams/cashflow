import { defineJob } from '../registry';
import { runDailySnapshotTick } from '../../portfolio/dailySnapshotScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'daily_snapshot',
  cronDefault: env.dailySnapshotCron,
  enabledDefault: env.dailySnapshotEnabled,
  handler: async () => {
    const r = await runDailySnapshotTick();
    return { summary: { ...r } };
  },
});

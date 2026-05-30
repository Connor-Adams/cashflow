import { defineJob } from '../registry';
import { pruneAllJobRuns } from '../runRetention';

defineJob({
  name: 'job_run_cleanup',
  cronDefault: '17 4 * * *',
  enabledDefault: true,
  handler: async () => {
    const summary = await pruneAllJobRuns();
    return { summary };
  },
});

import { defineJob } from '../registry';
import { runEnrichmentBackfillTick } from '../../import/enrichmentBackfillScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'enrichment_backfill',
  cronDefault: env.enrichmentBackfillCron,
  enabledDefault: env.enrichmentBackfillEnabled,
  handler: async () => {
    const r = await runEnrichmentBackfillTick();
    return { summary: { ...r } };
  },
});

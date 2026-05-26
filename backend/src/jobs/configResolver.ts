import { Job } from '../models';
import type { JobDefinition, ResolvedJobConfig } from './types';

export async function resolveJobConfig(
  def: JobDefinition,
): Promise<ResolvedJobConfig> {
  const row = await Job.findOne({ where: { name: def.name } });
  const enabled =
    row?.enabledOverride !== null && row?.enabledOverride !== undefined
      ? row.enabledOverride
      : def.enabledDefault;
  const cron =
    row?.cronOverride !== null && row?.cronOverride !== undefined
      ? row.cronOverride
      : def.cronDefault;
  return {
    enabled,
    cron,
    source: {
      enabled:
        row?.enabledOverride !== null && row?.enabledOverride !== undefined
          ? 'db'
          : 'env',
      cron:
        row?.cronOverride !== null && row?.cronOverride !== undefined
          ? 'db'
          : 'env',
    },
  };
}

import { Op } from 'sequelize';
import { JobRun } from '../models';
import { logger } from '../observability/logger';

export async function pruneJobRuns(jobName: string, keep = 100): Promise<number> {
  const rows = await JobRun.findAll({
    where: { jobName },
    order: [['startedAt', 'DESC'], ['id', 'DESC']],
    offset: keep,
    attributes: ['id'],
  });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  return JobRun.destroy({ where: { id: { [Op.in]: ids } } });
}

export async function pruneAllJobRuns(keep = 100): Promise<{ jobsScanned: number; deleted: number }> {
  const rows = await JobRun.findAll({
    attributes: ['jobName'],
    group: ['jobName'],
  });
  let deleted = 0;
  for (const row of rows) {
    try {
      deleted += await pruneJobRuns(row.jobName, keep);
    } catch (err) {
      logger.error({ err, name: row.jobName }, 'job_run_prune_failed');
    }
  }
  return { jobsScanned: rows.length, deleted };
}

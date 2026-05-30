import { Job } from '../models/Job';
import { ImportHistory } from '../models/ImportHistory';
import { UserEmailIntegration } from '../models/UserEmailIntegration';
import { HouseholdMember } from '../models/HouseholdMember';
import { Op } from 'sequelize';

function secondsSince(d: Date | null): number | null {
  return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000)) : null;
}

export async function buildFreshness(householdId: number) {
  const [jobs, imports, members] = await Promise.all([
    Job.findAll({ order: [['name', 'ASC']] }),
    ImportHistory.findAll({
      where: { householdId },
      order: [['startedAt', 'DESC']],
      limit: 20,
    }),
    HouseholdMember.findAll({ where: { householdId } }),
  ]);

  const userIds = members.map((m) => m.userId);
  const emailIntegrations =
    userIds.length > 0
      ? await UserEmailIntegration.findAll({
          where: { userId: { [Op.in]: userIds } },
        })
      : [];

  return {
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt,
      lastFinishedAt: j.lastFinishedAt,
      lastStatus: j.lastStatus,
      lastDurationMs: j.lastDurationMs,
      lastError: j.lastError,
      secondsSinceLastRun: secondsSince(j.lastRunAt),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      source: i.batchLabel,
      startedAt: i.startedAt,
      finishedAt: i.finishedAt,
      status: i.status,
      rowCount: i.rowCount,
      secondsSinceFinish: secondsSince(i.finishedAt),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: e.id,
      userId: e.userId,
      status: e.status,
      statusReason: e.statusReason,
      lastScanAt: e.lastScanAt,
      secondsSinceLastScan: secondsSince(e.lastScanAt),
    })),
    generatedAt: new Date().toISOString(),
  };
}

import { Op } from 'sequelize';
import { Job, ImportHistory, UserEmailIntegration, HouseholdMember } from '../models';

export interface FreshnessResult {
  jobs: Array<{
    name: string;
    lastRunAt: string | null;
    lastFinishedAt: string | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
    secondsSinceLastRun: number | null;
  }>;
  imports: Array<{
    id: number;
    fileName: string;
    status: string;
    rowCount: number | null;
    startedAt: string;
    finishedAt: string | null;
    secondsSinceFinish: number | null;
  }>;
  emailIntegrations: Array<{
    id: number;
    userId: number;
    provider: string;
    status: string;
    statusReason: string | null;
    lastScanAt: string | null;
    secondsSinceLastScan: number | null;
  }>;
  generatedAt: string;
}

function secondsSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export async function freshness(householdId: number): Promise<FreshnessResult> {
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const userIds = members.map((m) => m.userId);

  const [jobs, imports, emailIntegrations] = await Promise.all([
    Job.findAll({ order: [['name', 'ASC']] }),
    ImportHistory.findAll({
      where: { householdId },
      order: [['startedAt', 'DESC']],
      limit: 20,
    }),
    userIds.length > 0
      ? UserEmailIntegration.findAll({
          where: { userId: { [Op.in]: userIds } },
          order: [['id', 'ASC']],
        })
      : Promise.resolve([]),
  ]);

  return {
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastFinishedAt: j.lastFinishedAt?.toISOString() ?? null,
      lastStatus: j.lastStatus ?? null,
      lastDurationMs: j.lastDurationMs ?? null,
      lastError: j.lastError ?? null,
      secondsSinceLastRun: secondsSince(j.lastRunAt ?? null),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      fileName: i.fileName,
      status: i.status,
      rowCount: i.rowCount ?? null,
      startedAt: i.startedAt.toISOString(),
      finishedAt: i.finishedAt?.toISOString() ?? null,
      secondsSinceFinish: secondsSince(i.finishedAt ?? null),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: e.id,
      userId: e.userId,
      provider: e.provider,
      status: e.status,
      statusReason: e.statusReason,
      lastScanAt: e.lastScanAt?.toISOString() ?? null,
      secondsSinceLastScan: secondsSince(e.lastScanAt ?? null),
    })),
    generatedAt: new Date().toISOString(),
  };
}

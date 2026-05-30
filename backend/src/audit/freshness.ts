import { Op } from 'sequelize';
import { HouseholdMember, ImportHistory, Job, UserEmailIntegration } from '../models';

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
    source: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    status: string | null;
    rowCount: number | null;
    secondsSinceFinish: number | null;
  }>;
  emailIntegrations: Array<{
    id: number;
    userId: number;
    status: string | null;
    statusReason: string | null;
    lastScanAt: string | null;
    secondsSinceLastScan: number | null;
  }>;
  generatedAt: string;
}

function secondsSince(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export async function freshness(householdId: number): Promise<FreshnessResult> {
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const memberIds = members.map((m) => m.userId);

  const [jobs, imports, emailIntegrations] = await Promise.all([
    Job.findAll({ order: [['name', 'ASC']] }),
    ImportHistory.findAll({
      where: { householdId },
      order: [['startedAt', 'DESC']],
      limit: 20,
    }),
    memberIds.length > 0
      ? UserEmailIntegration.findAll({
          where: { userId: { [Op.in]: memberIds } },
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
      secondsSinceLastRun: secondsSince(j.lastRunAt),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      source: i.batchLabel ?? null,
      startedAt: i.startedAt?.toISOString() ?? null,
      finishedAt: i.finishedAt?.toISOString() ?? null,
      status: i.status ?? null,
      rowCount: i.rowCount ?? null,
      secondsSinceFinish: secondsSince(i.finishedAt),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: e.id,
      userId: e.userId,
      status: e.status ?? null,
      statusReason: e.statusReason ?? null,
      lastScanAt: e.lastScanAt?.toISOString() ?? null,
      secondsSinceLastScan: secondsSince(e.lastScanAt),
    })),
    generatedAt: new Date().toISOString(),
  };
}

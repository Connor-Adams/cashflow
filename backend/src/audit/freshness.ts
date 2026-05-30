import { Op } from 'sequelize';
import { Job, ImportHistory, HouseholdMember, UserEmailIntegration } from '../models/index';

function secondsSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export type FreshnessResult = {
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
};

export async function buildFreshness(householdId: number): Promise<FreshnessResult> {
  const [jobs, imports, members] = await Promise.all([
    Job.findAll({ order: [['name', 'ASC']] }),
    ImportHistory.findAll({
      where: { householdId },
      order: [['startedAt', 'DESC']],
      limit: 20,
    }),
    HouseholdMember.findAll({ where: { householdId }, attributes: ['userId'] }),
  ]);

  const memberIds = members.map((m) => m.userId);
  const emailIntegrations =
    memberIds.length > 0
      ? await UserEmailIntegration.findAll({ where: { userId: { [Op.in]: memberIds } } })
      : [];

  return {
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastFinishedAt: j.lastFinishedAt?.toISOString() ?? null,
      lastStatus: j.lastStatus,
      lastDurationMs: j.lastDurationMs,
      lastError: j.lastError,
      secondsSinceLastRun: secondsSince(j.lastRunAt),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      source: i.fileName,
      startedAt: i.startedAt?.toISOString() ?? null,
      finishedAt: i.finishedAt?.toISOString() ?? null,
      status: i.status,
      rowCount: i.rowCount,
      secondsSinceFinish: secondsSince(i.finishedAt),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: e.id,
      userId: e.userId,
      status: e.status,
      statusReason: e.statusReason,
      lastScanAt: e.lastScanAt?.toISOString() ?? null,
      secondsSinceLastScan: secondsSince(e.lastScanAt),
    })),
    generatedAt: new Date().toISOString(),
  };
}

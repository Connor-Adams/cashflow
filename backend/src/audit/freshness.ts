import { Op } from 'sequelize';
import { HouseholdMember, ImportHistory, Job, UserEmailIntegration } from '../models';

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

function secsSince(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.round((Date.now() - new Date(d).getTime()) / 1000);
}

export async function runFreshness(householdId: number): Promise<FreshnessResult> {
  const now = new Date().toISOString();

  const [jobs, importRows, members] = await Promise.all([
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
          order: [['id', 'ASC']],
        })
      : [];

  return {
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastFinishedAt: j.lastFinishedAt?.toISOString() ?? null,
      lastStatus: j.lastStatus ?? null,
      lastDurationMs: j.lastDurationMs ?? null,
      lastError: j.lastError ?? null,
      secondsSinceLastRun: secsSince(j.lastRunAt),
    })),
    imports: importRows.map((imp) => ({
      id: imp.id,
      source: imp.fileName ?? null,
      startedAt: imp.startedAt?.toISOString() ?? null,
      finishedAt: imp.finishedAt?.toISOString() ?? null,
      status: imp.status ?? null,
      rowCount: imp.rowCount ?? null,
      secondsSinceFinish: secsSince(imp.finishedAt),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: e.id,
      userId: e.userId,
      status: e.status ?? null,
      statusReason: e.statusReason ?? null,
      lastScanAt: e.lastScanAt?.toISOString() ?? null,
      secondsSinceLastScan: secsSince(e.lastScanAt),
    })),
    generatedAt: now,
  };
}

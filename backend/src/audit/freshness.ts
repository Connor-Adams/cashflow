import { Op } from 'sequelize';
import { HouseholdMember, ImportHistory, Job, UserEmailIntegration } from '../models';

function secondsSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export async function freshness(householdId: number) {
  // Jobs: global table, alphabetical
  const jobs = await Job.findAll({ order: [['name', 'ASC']] });

  // Imports: newest 20 for this household
  const imports = await ImportHistory.findAll({
    where: { householdId },
    order: [['startedAt', 'DESC']],
    limit: 20,
  });

  // Email integrations: per users in this household
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
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
    imports: imports.map((imp) => ({
      id: imp.id,
      source: imp.fileName ?? null,
      startedAt: imp.startedAt?.toISOString() ?? null,
      finishedAt: imp.finishedAt?.toISOString() ?? null,
      status: imp.status ?? null,
      rowCount: imp.rowCount ?? null,
      secondsSinceFinish: secondsSince(imp.finishedAt ?? null),
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

import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

export interface ClientErrorsResult {
  count: number;
  rows: Array<{
    id: number;
    level: string;
    event: string | null;
    message: string;
    path: string | null;
    requestId: string | null;
    createdAt: string;
  }>;
}

export async function queryClientErrors(opts: {
  householdId: number;
  since?: string;
  level?: string;
  limit?: number;
}): Promise<ClientErrorsResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const where: Record<string, unknown> = { householdId: opts.householdId };
  if (opts.since) {
    const d = new Date(opts.since);
    if (!Number.isNaN(d.getTime())) {
      where.createdAt = { [Op.gte]: d };
    }
  }
  if (opts.level) {
    where.level = opts.level;
  }

  const rows = await ClientErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });

  return {
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      level: r.level,
      event: r.event,
      message: r.message,
      path: r.path,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

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

export async function clientErrors(
  householdId: number,
  opts: { since?: string; level?: string; limit?: number } = {}
): Promise<ClientErrorsResult> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);

  const where: Record<string, unknown> = { householdId };
  if (opts.since) {
    const sinceDate = new Date(opts.since);
    if (!isNaN(sinceDate.getTime())) {
      where['createdAt'] = { [Op.gte]: sinceDate };
    }
  }
  if (opts.level === 'error' || opts.level === 'warn') {
    where['level'] = opts.level;
  }

  const rows = await ClientErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    attributes: ['id', 'level', 'event', 'message', 'path', 'requestId', 'createdAt'],
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

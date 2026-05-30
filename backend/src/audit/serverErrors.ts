import { Op } from 'sequelize';
import { ServerErrorEvent } from '../models';

export interface ServerErrorsResult {
  count: number;
  rows: Array<{
    id: number;
    method: string;
    path: string;
    status: number;
    message: string;
    stack: string | null;
    requestId: string | null;
    createdAt: string;
  }>;
}

export async function serverErrors(
  householdId: number,
  opts: { since?: string; limit?: number } = {}
): Promise<ServerErrorsResult> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);

  const where: Record<string, unknown> = { householdId };
  if (opts.since) {
    const sinceDate = new Date(opts.since);
    if (!isNaN(sinceDate.getTime())) {
      where['createdAt'] = { [Op.gte]: sinceDate };
    }
  }

  const rows = await ServerErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    attributes: ['id', 'method', 'path', 'status', 'message', 'stack', 'requestId', 'createdAt'],
  });

  return {
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      message: r.message,
      stack: r.stack,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

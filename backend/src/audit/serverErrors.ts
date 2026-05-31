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
    requestId: string | null;
    createdAt: string;
  }>;
}

export async function queryServerErrors(opts: {
  householdId: number;
  since?: string;
  limit?: number;
}): Promise<ServerErrorsResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const where: Record<string, unknown> = { householdId: opts.householdId };
  if (opts.since) {
    const d = new Date(opts.since);
    if (!Number.isNaN(d.getTime())) {
      where.createdAt = { [Op.gte]: d };
    }
  }

  const rows = await ServerErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });

  return {
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      message: r.message,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

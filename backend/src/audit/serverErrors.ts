import { Op } from 'sequelize';
import { ServerErrorEvent } from '../models';

const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 100;

export interface ServerErrorRow {
  id: number;
  method: string;
  path: string;
  status: number;
  message: string;
  stack: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface ServerErrorsResult {
  count: number;
  rows: ServerErrorRow[];
}

export async function getServerErrors(
  householdId: number,
  opts: { since?: string; limit?: number } = {},
): Promise<ServerErrorsResult> {
  const limit = Math.max(1, Math.min(LIMIT_MAX, opts.limit ?? LIMIT_DEFAULT));
  const where: Record<string, unknown> = { householdId };

  if (opts.since) {
    const sinceDate = new Date(opts.since);
    if (!Number.isNaN(sinceDate.getTime())) {
      where.createdAt = { [Op.gte]: sinceDate };
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
      stack: r.stack,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

import { Op } from 'sequelize';
import { ServerErrorEvent } from '../models';

export interface ServerErrorsQuery {
  since?: Date | null;
  limit?: number;
  status?: number | null;
}

export interface ServerErrorsResult {
  count: number;
  rows: Array<{
    id: number;
    method: string | null;
    path: string | null;
    status: number | null;
    message: string;
    requestId: string | null;
    createdAt: string;
  }>;
}

export async function serverErrors(
  householdId: number,
  q: ServerErrorsQuery,
): Promise<ServerErrorsResult> {
  const where: Record<string, unknown> = { householdId };
  if (q.since instanceof Date) where.createdAt = { [Op.gte]: q.since };
  if (q.status != null) where.status = q.status;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const { count, rows } = await ServerErrorEvent.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return {
    count,
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

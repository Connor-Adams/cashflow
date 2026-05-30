import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

export interface ClientErrorsQuery {
  since?: Date | null;
  limit?: number;
  level?: string | null;
}

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
  q: ClientErrorsQuery,
): Promise<ClientErrorsResult> {
  const where: Record<string, unknown> = { householdId };
  if (q.since instanceof Date) where.createdAt = { [Op.gte]: q.since };
  if (q.level) where.level = q.level;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const { count, rows } = await ClientErrorEvent.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return {
    count,
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

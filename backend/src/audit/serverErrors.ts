import { Op } from 'sequelize';
import { ServerErrorEvent } from '../models';

export async function buildServerErrors(householdId: number, opts: {
  since?: Date;
  limit?: number;
}) {
  const where: Record<string, unknown> = { householdId };
  if (opts.since) where.createdAt = { [Op.gte]: opts.since };
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

  const rows = await ServerErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return {
    count: rows.length,
    rows: rows.map(r => ({
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

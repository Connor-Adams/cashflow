import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

export async function buildClientErrors(householdId: number, opts: {
  since?: Date;
  level?: string;
  limit?: number;
}) {
  const where: Record<string, unknown> = { householdId };
  if (opts.since) where.createdAt = { [Op.gte]: opts.since };
  if (opts.level && (opts.level === 'error' || opts.level === 'warn')) where.level = opts.level;
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

  const rows = await ClientErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return {
    count: rows.length,
    rows: rows.map(r => ({
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

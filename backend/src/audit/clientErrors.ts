import { Op, WhereOptions } from 'sequelize';
import { ClientErrorEvent } from '../models/index';
import type { InferAttributes } from 'sequelize';

export type ClientErrorsResult = {
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
};

export async function buildClientErrors(
  householdId: number,
  opts: { since?: string; level?: string; limit?: number },
): Promise<ClientErrorsResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const where: WhereOptions<InferAttributes<ClientErrorEvent>> = { householdId };
  if (opts.since) {
    (where as Record<string, unknown>).createdAt = { [Op.gte]: new Date(opts.since) };
  }
  if (opts.level === 'error' || opts.level === 'warn') {
    (where as Record<string, unknown>).level = opts.level;
  }

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

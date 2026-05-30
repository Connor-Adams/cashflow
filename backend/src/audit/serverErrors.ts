import { Op, WhereOptions } from 'sequelize';
import { ServerErrorEvent } from '../models/index';
import type { InferAttributes } from 'sequelize';

export type ServerErrorsResult = {
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
};

export async function buildServerErrors(
  householdId: number | null,
  opts: { since?: string; limit?: number },
): Promise<ServerErrorsResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const where: WhereOptions<InferAttributes<ServerErrorEvent>> = { householdId };
  if (opts.since) {
    (where as Record<string, unknown>).createdAt = { [Op.gte]: new Date(opts.since) };
  }

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
      stack: r.stack,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

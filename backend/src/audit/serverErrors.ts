import { Op } from 'sequelize';
import { ServerErrorEvent } from '../models';

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

export async function runServerErrors(
  householdId: number,
  opts: { since?: string; limit?: number }
): Promise<ServerErrorsResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { householdId };

  if (opts.since) {
    const d = new Date(opts.since);
    if (!isNaN(d.getTime())) {
      where['createdAt'] = { [Op.gte]: d };
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
      stack: r.stack ?? null,
      requestId: r.requestId ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

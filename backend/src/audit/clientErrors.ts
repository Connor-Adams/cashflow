import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

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

export async function runClientErrors(
  householdId: number,
  opts: { since?: string; level?: string; limit?: number }
): Promise<ClientErrorsResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { householdId };

  if (opts.level === 'error' || opts.level === 'warn') {
    where['level'] = opts.level;
  }
  if (opts.since) {
    const d = new Date(opts.since);
    if (!isNaN(d.getTime())) {
      where['createdAt'] = { [Op.gte]: d };
    }
  }

  const rows = await ClientErrorEvent.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });

  return {
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      level: r.level,
      event: r.event ?? null,
      message: r.message,
      path: r.path ?? null,
      requestId: r.requestId ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

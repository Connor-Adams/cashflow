import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 100;

export interface ClientErrorRow {
  id: number;
  level: string;
  event: string | null;
  message: string;
  path: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface ClientErrorsResult {
  count: number;
  rows: ClientErrorRow[];
}

export async function getClientErrors(
  householdId: number,
  opts: { since?: string; level?: string; limit?: number } = {},
): Promise<ClientErrorsResult> {
  const limit = Math.max(1, Math.min(LIMIT_MAX, opts.limit ?? LIMIT_DEFAULT));
  const where: Record<string, unknown> = { householdId };

  if (opts.since) {
    const sinceDate = new Date(opts.since);
    if (!Number.isNaN(sinceDate.getTime())) {
      where.createdAt = { [Op.gte]: sinceDate };
    }
  }

  if (opts.level === 'error' || opts.level === 'warn') {
    where.level = opts.level;
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
      event: r.event,
      message: r.message,
      path: r.path,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

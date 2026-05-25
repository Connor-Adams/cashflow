/**
 * Daily call budget for the Alpha Vantage provider.
 *
 * Counts `ok` + `not_found` rows in `provider_job_log` since the start of the
 * current UTC day. `error` and `budget_exceeded` rows are excluded so transient
 * failures don't permanently reduce the working budget.
 */

import { Op } from 'sequelize';
import { ProviderJobLog, type ProviderJobStatus } from '../../models/ProviderJobLog';

export const ALPHA_VANTAGE_PROVIDER = 'alpha_vantage';

const BILLABLE_STATUSES: ProviderJobStatus[] = ['ok', 'not_found'];

function startOfUtcDay(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function callsUsedToday(now: Date = new Date()): Promise<number> {
  return ProviderJobLog.count({
    where: {
      provider: ALPHA_VANTAGE_PROVIDER,
      status: { [Op.in]: BILLABLE_STATUSES },
      fetchedAt: { [Op.gte]: startOfUtcDay(now) },
    },
  });
}

export interface BudgetCheck {
  ok: boolean;
  used: number;
  limit: number;
  remaining: number;
}

export async function checkBudget(
  limit: number,
  now: Date = new Date(),
): Promise<BudgetCheck> {
  const used = await callsUsedToday(now);
  return {
    ok: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

export interface RecordCallInput {
  function: string;
  symbol: string | null;
  status: ProviderJobStatus;
  httpStatus?: number | null;
  errorMessage?: string | null;
  fetchedAt?: Date;
}

export async function recordCall(input: RecordCallInput): Promise<void> {
  await ProviderJobLog.create({
    provider: ALPHA_VANTAGE_PROVIDER,
    function: input.function,
    symbol: input.symbol,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    errorMessage: input.errorMessage ?? null,
    fetchedAt: input.fetchedAt ?? new Date(),
  });
}

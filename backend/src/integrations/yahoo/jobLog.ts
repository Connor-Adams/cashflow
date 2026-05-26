/**
 * Diagnostic log of every Yahoo Finance call we make. Yahoo's public API
 * has no published quota or per-key budget, so we don't gate work on a
 * counter — we just record outcomes for debugging, rate-limit detection,
 * and the staleness-based scheduler picker.
 */
import { ProviderJobLog, type ProviderJobStatus } from '../../models/ProviderJobLog';
import { YAHOO_PROVIDER } from './client';

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
    provider: YAHOO_PROVIDER,
    function: input.function,
    symbol: input.symbol,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    errorMessage: input.errorMessage ?? null,
    fetchedAt: input.fetchedAt ?? new Date(),
  });
}

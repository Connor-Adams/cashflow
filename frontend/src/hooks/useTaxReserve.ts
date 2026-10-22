import { apiBase } from '../lib/runtimeConfig'
/**
 * Hooks backing the Tax Reserve tab (issue #223). Mirrors the vanilla
 * useEffect/useState pattern used by useTaxHygiene — no TanStack Query in
 * this codebase yet. One hook for settings, one for the summary rollup,
 * plus mutation helpers for the setting.
 *
 * The reserve is one CAD figure: the backend converts every transaction to
 * CAD at its own date, so there is a single (CAD) reserve percent.
 */
import { useCallback, useEffect, useState } from 'react';
import { deleteReq, getJson } from '@/lib/api';

export type Periodicity = 'monthly' | 'quarterly' | 'annual';

export const PERIODICITY_LABELS: Record<Periodicity, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

export interface ReserveSettingDto {
  currency: string;
  reservePercent: string;
  note: string | null;
  isDefault: boolean;
}

export interface ReserveSettingsResponse {
  /** One element: the household's CAD setting (or the synthesised default). */
  data: ReserveSettingDto[];
  currency: 'CAD';
  /** Legacy per-currency rows that no longer affect the reserve. */
  ignored: ReserveSettingDto[];
}

export function useTaxReserveSettings() {
  const [data, setData] = useState<ReserveSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJson<ReserveSettingsResponse>(
        '/api/tax/reserve/settings',
      );
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}

/**
 * Upsert the household's (CAD) reserve setting. Uses raw fetch because the
 * shared lib/api.ts doesn't expose a PUT helper yet — the rest of the app only
 * uses GET/POST/PATCH/DELETE. Adding `putJson` would touch every other
 * surface, so the local fetch is the smaller change for one route.
 */
export async function putReserveSetting(
  input: { reservePercent?: number; note?: string | null },
): Promise<ReserveSettingDto> {
  const base = apiBase();
  const r = await fetch(
    `${base}/api/tax/reserve/settings/CAD`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) {
    const text = await r.text();
    let message = r.statusText;
    try {
      const j = JSON.parse(text) as { error?: string };
      message = j.error ?? message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }
  const body = (await r.json()) as { data: ReserveSettingDto };
  return body.data;
}

/** Delete a setting row: CAD reverts to the default; any other currency clears a legacy row. */
export async function deleteReserveSetting(currency: string): Promise<void> {
  await deleteReq(
    `/api/tax/reserve/settings/${encodeURIComponent(currency)}`,
  );
}

// ---- Summary -----------------------------------------------------------

export interface ReserveSummaryRow {
  /** Always 'CAD'. */
  currency: string;
  period: string;
  /** Original currencies of the period's transactions, e.g. ['CAD', 'USD']. */
  sourceCurrencies: string[];
  components: {
    businessIncome: number;
    deductibleExpenses: number;
    hstGstCollected: number;
    hstGstPaid: number;
  };
  netBusinessIncome: number;
  netHstGst: number;
  reservePercent: number;
  reserveTarget: number;
}

export interface ReserveSummaryResponse {
  data: ReserveSummaryRow[];
  currency: 'CAD';
  reservePercent: number;
  /** Conversions on a substituted (stale or post-dated) FX rate, or currencies left out. */
  warnings: string[];
  scope: string;
  periodicity: Periodicity;
  disclaimer: string;
}

export interface ReserveSummaryFilters {
  from: string;
  to: string;
  periodicity: Periodicity;
  scope?: string;
}

function buildSummaryQuery(filters: ReserveSummaryFilters): string {
  const qs = new URLSearchParams();
  qs.set('periodicity', filters.periodicity);
  qs.set('from', filters.from);
  qs.set('to', filters.to);
  if (filters.scope) qs.set('scope', filters.scope);
  return qs.toString();
}

export function useTaxReserveSummary(filters: ReserveSummaryFilters) {
  const [data, setData] = useState<ReserveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJson<ReserveSummaryResponse>(
        `/api/tax/reserve/summary?${buildSummaryQuery(filters)}`,
      );
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filters.scope, filters.from, filters.to, filters.periodicity]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}

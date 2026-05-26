/**
 * Hooks backing the Tax Hygiene tab. Mirrors the rest-of-app pattern of
 * vanilla useEffect/useState fetchers (no TanStack Query in this codebase
 * yet). One hook per endpoint, plus a `usePatchTransactionTax` mutation
 * helper that returns the new metadata so the UI can update in place
 * without an extra round-trip.
 */
import { useCallback, useEffect, useState } from 'react';
import { getJson, patchJson, postJson } from '@/lib/api';

export type TaxScope = 'personal' | 'shared' | 'business' | 'all';

export const TAX_SCOPE_LABELS: Record<TaxScope, string> = {
  personal: 'Personal',
  shared: 'Shared',
  business: 'Business',
  all: 'All',
};

export interface TaxHygieneFilters {
  scope: TaxScope;
  from?: string;
  to?: string;
}

function buildQuery(filters: TaxHygieneFilters): string {
  const qs = new URLSearchParams();
  qs.set('scope', filters.scope);
  if (filters.from) qs.set('from', filters.from);
  if (filters.to) qs.set('to', filters.to);
  return qs.toString();
}

// ----- Summary -----------------------------------------------------------

export interface TaxSummaryRow {
  currency: string;
  gross: string;
  deductibleEstimate: string;
  hstGstEstimate: string;
  transactionCount: number;
  reviewedCount: number;
}

export interface TaxSummaryResponse {
  data: TaxSummaryRow[];
  scope: TaxScope;
}

export function useTaxSummary(filters: TaxHygieneFilters) {
  const [data, setData] = useState<TaxSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJson<TaxSummaryResponse>(
        `/api/business/tax-summary?${buildQuery(filters)}`,
      );
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filters.scope, filters.from, filters.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}

// ----- Missing receipts --------------------------------------------------

export interface MissingReceiptRow {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  accountName: string | null;
}

export interface MissingReceiptsResponse {
  data: MissingReceiptRow[];
  count: number;
}

export function useMissingReceipts(filters: TaxHygieneFilters) {
  const [data, setData] = useState<MissingReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJson<MissingReceiptsResponse>(
        `/api/business/missing-receipts?${buildQuery(filters)}`,
      );
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filters.scope, filters.from, filters.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}

// ----- Review queue ------------------------------------------------------

export interface ReviewQueueRow {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  accountName: string | null;
  taxTagId: number | null;
  deductiblePercent: string;
}

export interface ReviewQueueResponse {
  data: ReviewQueueRow[];
  count: number;
}

export function useReviewQueue(filters: TaxHygieneFilters) {
  const [data, setData] = useState<ReviewQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJson<ReviewQueueResponse>(
        `/api/business/review-queue?${buildQuery(filters)}`,
      );
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [filters.scope, filters.from, filters.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}

// ----- Tags --------------------------------------------------------------

export interface TaxTagDto {
  id: number;
  name: string;
  description: string | null;
}

export function useTaxTags() {
  const [tags, setTags] = useState<TaxTagDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await getJson<{ data: TaxTagDto[] }>('/api/tax-tags');
      setTags(d.data);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const create = useCallback(
    async (input: { name: string; description?: string | null }) => {
      await postJson('/api/tax-tags', input);
      await load();
    },
    [load],
  );
  return { tags, error, create, refresh: load };
}

// ----- PATCH mutation ---------------------------------------------------

export interface TransactionTaxMetadataDto {
  transactionId: number | null;
  taxTagId: number | null;
  taxTag: { id: number; name: string } | null;
  deductiblePercent: string;
  hstGstAmount: string | null;
  receiptRequired: boolean;
  reviewedForTax: boolean;
}

export interface TaxPatchInput {
  taxTagId?: number | null;
  deductiblePercent?: number | null;
  hstGstAmount?: number | null;
  receiptRequired?: boolean;
  reviewedForTax?: boolean;
}

export async function patchTransactionTax(
  transactionId: number,
  patch: TaxPatchInput,
): Promise<TransactionTaxMetadataDto> {
  const resp = await patchJson<{ data: TransactionTaxMetadataDto }>(
    `/api/transactions/${transactionId}/tax`,
    patch,
  );
  return resp.data;
}

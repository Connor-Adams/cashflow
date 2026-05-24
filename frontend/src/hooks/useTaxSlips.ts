import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '@/lib/api';

export type SlipDto = {
  id: number;
  entityId: number;
  year: number;
  slipType: 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
  issuer: string;
  boxValues: Record<string, number | string>;
};

export function useTaxSlips(year?: number) {
  const [slips, setSlips] = useState<SlipDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const path = year ? `/api/tax/slips?year=${year}` : '/api/tax/slips';
    try {
      const d = await getJson<{ slips: SlipDto[] }>(path);
      setSlips(d.slips);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const create = useCallback(async (input: Omit<SlipDto, 'id'>) => {
    await postJson('/api/tax/slips', input);
    await load();
  }, [load]);
  return { slips, error, create, refresh: load };
}

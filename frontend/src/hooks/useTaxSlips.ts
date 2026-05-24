import { useCallback, useEffect, useState } from 'react';

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
    const url = year ? `/api/tax/slips?year=${year}` : '/api/tax/slips';
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) { setError(r.statusText); return; }
    setSlips((await r.json()).slips);
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const create = useCallback(async (input: Omit<SlipDto, 'id'>) => {
    const r = await fetch('/api/tax/slips', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(r.statusText);
    await load();
  }, [load]);
  return { slips, error, create, refresh: load };
}

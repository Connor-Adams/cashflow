import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/api';

export type InstalmentDto = {
  id: number;
  entityId: number;
  year: number;
  quarter: number | null;
  amount: string;
  paidOn: string;
  notes: string | null;
};

export function useInstalments(year: number) {
  const [items, setItems] = useState<InstalmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getJson<InstalmentDto[] | { instalments: InstalmentDto[] }>(
        `/api/tax/personal/${year}/instalments`,
      );
      setItems(Array.isArray(d) ? d : d.instalments ?? []);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(
    async (input: Omit<InstalmentDto, 'id' | 'entityId' | 'year'>) => {
      await postJson(`/api/tax/personal/${year}/instalments`, input);
      await load();
    },
    [year, load],
  );

  return { items, error, add, refresh: load };
}

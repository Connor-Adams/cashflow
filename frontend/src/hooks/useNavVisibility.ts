import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

export type NavFeature = 'income' | 'planned' | 'goals' | 'scenarios' | 'vault' | 'budgets';

type NavStatus = Record<NavFeature, boolean>;

const EMPTY: NavStatus = {
  income: false,
  planned: false,
  goals: false,
  scenarios: false,
  vault: false,
  budgets: false,
};

export function useNavVisibility(): NavStatus {
  const [status, setStatus] = useState<NavStatus>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    getJson<NavStatus>('/api/nav/status')
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(EMPTY);
      });
    return () => { cancelled = true; };
  }, []);

  return status;
}

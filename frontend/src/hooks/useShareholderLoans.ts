import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '@/lib/api';

export type ShareholderLoanKind = 'advance' | 'repayment' | 'dividend_credit' | 'salary_credit';

export type ShareholderLoanDto = {
  id: number;
  entityId: number;
  date: string;
  kind: ShareholderLoanKind;
  amount: string;
  description: string | null;
};

type ShareholderLoansResponse = {
  shareholderLoans: ShareholderLoanDto[];
  balance: string;
};

export type NewShareholderLoan = {
  entityId: number;
  date: string;
  kind: ShareholderLoanKind;
  amount: string;
  description?: string | null;
};

export function useShareholderLoans() {
  const [loans, setLoans] = useState<ShareholderLoanDto[]>([]);
  const [balance, setBalance] = useState<string>('0.00');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getJson<ShareholderLoansResponse>('/api/tax/corp/shareholder-loans');
      setLoans(d.shareholderLoans ?? []);
      setBalance(d.balance ?? '0.00');
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = useCallback(
    async (input: NewShareholderLoan) => {
      await postJson('/api/tax/corp/shareholder-loans', input);
      await load();
    },
    [load],
  );

  return { loans, balance, error, add, refresh: load };
}

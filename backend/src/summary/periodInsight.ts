// backend/src/summary/periodInsight.ts
import { num } from '../util/numbers';

export type OwedBackRow = {
  id: number;
  currency: string;
  amount: string;
  partnerShareAmount?: string | null;
};

export type OwedBackTotals = {
  owedBack: number;
  reimbursable: number;
  partnerShare: number;
};

export function computeOwedBack(
  rows: OwedBackRow[],
  reimbursableByTxnId: Map<number, number>,
): Map<string, OwedBackTotals> {
  const out = new Map<string, OwedBackTotals>();
  for (const r of rows) {
    const acc =
      out.get(r.currency) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
    const reimb = reimbursableByTxnId.get(r.id);
    if (reimb != null && reimb > 0) {
      acc.reimbursable += reimb;
      acc.owedBack += reimb;
    } else {
      const ps = Math.abs(num(r.partnerShareAmount) ?? 0);
      if (ps > 0) {
        acc.partnerShare += ps;
        acc.owedBack += ps;
      }
    }
    out.set(r.currency, acc);
  }
  return out;
}

export function realCostOf(netSpend: number, owedBack: number): number {
  return netSpend - owedBack;
}

export function deltaPct(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

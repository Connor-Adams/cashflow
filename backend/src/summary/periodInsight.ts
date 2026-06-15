// backend/src/summary/periodInsight.ts
import { num } from '../util/numbers';
import { isNonCategorical } from './classifyTransactionFlow';

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

export type MoverRow = {
  currency: string;
  amount: string;
  finalCategory: string | null;
  merchantClean?: string | null;
  txnType?: string | null;
  accountType?: string | null;
};

export type CategoryMover = {
  category: string;
  currentRealCost: number;
  baselineRealCost: number;
  deltaAbs: number;
  deltaPct: number | null;
  driver: { topMerchant: string | null; txnCount: number };
};

function categorySpend(rows: MoverRow[], currency: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.currency !== currency) continue;
    if (isNonCategorical(r.txnType, r.accountType)) continue;
    const amt = num(r.amount) ?? 0;
    if (amt >= 0) continue; // spend only
    const cat = r.finalCategory ?? 'Uncategorized';
    m.set(cat, (m.get(cat) ?? 0) + Math.abs(amt));
  }
  return m;
}

function driverFor(
  rows: MoverRow[],
  currency: string,
  category: string,
): { topMerchant: string | null; txnCount: number } {
  const byMerchant = new Map<string, number>();
  let count = 0;
  for (const r of rows) {
    if (r.currency !== currency) continue;
    if (isNonCategorical(r.txnType, r.accountType)) continue;
    const amt = num(r.amount) ?? 0;
    if (amt >= 0) continue;
    if ((r.finalCategory ?? 'Uncategorized') !== category) continue;
    count += 1;
    const merch = r.merchantClean ?? 'Unknown';
    byMerchant.set(merch, (byMerchant.get(merch) ?? 0) + Math.abs(amt));
  }
  let top: string | null = null;
  let best = -Infinity;
  for (const [merch, total] of byMerchant) {
    if (total > best) {
      best = total;
      top = merch;
    }
  }
  return { topMerchant: top, txnCount: count };
}

export function topCategoryMovers(
  current: MoverRow[],
  baseline: MoverRow[],
  currency: string,
  limit: number,
  baselineDivisor = 1,
): CategoryMover[] {
  const cur = categorySpend(current, currency);
  const base = categorySpend(baseline, currency);
  const cats = new Set<string>([...cur.keys(), ...base.keys()]);
  const movers: CategoryMover[] = [];
  for (const cat of cats) {
    const c = cur.get(cat) ?? 0;
    const b = (base.get(cat) ?? 0) / baselineDivisor;
    movers.push({
      category: cat,
      currentRealCost: c,
      baselineRealCost: b,
      deltaAbs: c - b,
      deltaPct: deltaPct(c, b),
      driver: driverFor(current, currency, cat),
    });
  }
  movers.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));
  return movers.slice(0, limit);
}

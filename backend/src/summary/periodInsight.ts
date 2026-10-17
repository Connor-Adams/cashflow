// backend/src/summary/periodInsight.ts
import { num } from '../util/numbers';
import { classifyFlow, countsTowardNetSpend } from './classifyTransactionFlow';

export type OwedBackRow = {
  id: number;
  currency: string;
  amount: string;
  partnerShareAmount?: string | null;
  /** Flow-classification inputs — the same fields the dashboard headline
   *  classifies on, so partner share is only counted on rows that count
   *  toward netSpend. */
  txnType?: string | null;
  accountType?: string | null;
  merchantRaw?: string | null;
  merchantClean?: string | null;
  finalCategory?: string | null;
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
      // Partner share carries the row's sign (calculateShares splits the
      // signed amount): −50 on a −100 purchase, +50 on its +100 refund. Owed
      // back is the NEGATED share so a refund un-owes what the purchase owed —
      // a fully refunded shared purchase nets to 0, matching its netSpend.
      // Only rows that count toward headline netSpend (spend / credit) carry
      // an owed share: a transfer, statement payment, income or unsignaled
      // deposit isn't in netSpend, so subtracting its share from realCost
      // would understate it.
      const ps = num(r.partnerShareAmount) ?? 0;
      const amount = num(r.amount) ?? 0;
      if (ps !== 0) {
        const flow = classifyFlow({
          amount,
          txnType: r.txnType,
          accountType: r.accountType,
          merchantRaw: r.merchantRaw,
          merchantClean: r.merchantClean,
          category: r.finalCategory,
        });
        if (countsTowardNetSpend(flow)) {
          acc.partnerShare -= ps;
          acc.owedBack -= ps;
        }
      }
    }
    out.set(r.currency, acc);
  }
  return out;
}

export function realCostOf(netSpend: number, owedBack: number): number {
  return netSpend - owedBack;
}

export type PeerLendingRow = {
  currency: string;
  amount: string | number;
  counterpartyContactId?: number | null;
  finalCategory?: string | null;
};

export type PeerLendingTotals = { lent: number; received: number };

/**
 * Final-category values whose contact-linked transfers are NOT peer lending.
 * Rent and shared-household payments to a counterparty are recurring
 * obligations, not money owed back. Compared case-insensitively. Extend as new
 * non-loan categories surface.
 *
 * Lived in contacts/transferLedger.ts until the per-person loan ledger stopped
 * using it — that surface now decides loan vs not from
 * `transactions.counterparty_role` (see contacts/counterpartyRole.ts), which is
 * an explicit per-row tag rather than a guess from a spend category. This
 * category guess survives only here, for the dashboard's peer-lending split.
 */
export const NON_LOAN_LEDGER_CATEGORIES: ReadonlySet<string> = new Set([
  'rent',
  'household',
]);

/** True when a transfer's final category marks it as a non-loan flow (e.g.
 *  Rent). Null/empty categories are treated as lending. */
export function isNonLoanCategory(finalCategory: string | null | undefined): boolean {
  if (!finalCategory) return false;
  return NON_LOAN_LEDGER_CATEGORIES.has(finalCategory.trim().toLowerCase());
}

/**
 * Per-currency peer-lending split for one window: money LENT (amount<0) vs
 * RECEIVED back (amount>0) on contact-linked transfers. Skips rows with no
 * counterparty, transfers to/from partner contacts (shared-life money, not
 * loans), and non-loan categories (rent/household). Period-scoped: caller
 * passes only the window's rows.
 */
export function computePeerLending(
  rows: PeerLendingRow[],
  partnerContactIds: ReadonlySet<number>,
): Map<string, PeerLendingTotals> {
  const out = new Map<string, PeerLendingTotals>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null) continue;
    if (partnerContactIds.has(cid)) continue;
    if (isNonLoanCategory(r.finalCategory)) continue;
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n === 0) continue;
    const acc = out.get(r.currency) ?? { lent: 0, received: 0 };
    if (n < 0) acc.lent += -n;
    else acc.received += n;
    out.set(r.currency, acc);
  }
  return out;
}

export interface TransferRow {
  amount: string | number;
  currency: string;
}

/**
 * Final-category values whose linked transfers are NOT loans and must be
 * excluded from the per-person loan ledger (raw net + transfer list). Rent and
 * shared-household payments to a counterparty are recurring obligations, not
 * money owed back. Compared case-insensitively. Extend as new non-loan
 * categories surface.
 */
export const NON_LOAN_LEDGER_CATEGORIES: ReadonlySet<string> = new Set([
  'rent',
  'household',
]);

/** True when a transfer's final category marks it as a non-loan flow (e.g.
 *  Rent) that the loan ledger must ignore. Null/empty categories are loans. */
export function isNonLoanCategory(finalCategory: string | null | undefined): boolean {
  if (!finalCategory) return false;
  return NON_LOAN_LEDGER_CATEGORIES.has(finalCategory.trim().toLowerCase());
}

export interface TransferNet {
  currency: string;
  sent: string;
  received: string;
  net: string;
}

function toCents(n: number): number {
  return Math.round(n * 10_000);
}

/** Per-currency raw net flow: sent (money out, amount<0) minus received
 *  (money in, amount>0). Positive net = the person owes you. Fixed-4 strings,
 *  integer-cents math to avoid float drift, sorted by currency. */
export function computeTransferNet(rows: TransferRow[]): TransferNet[] {
  const sent = new Map<string, number>();
  const recv = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n === 0) continue;
    const m = n < 0 ? sent : recv;
    m.set(r.currency, (m.get(r.currency) ?? 0) + toCents(Math.abs(n)));
  }
  const currencies = new Set([...sent.keys(), ...recv.keys()]);
  return [...currencies].sort().map((currency) => {
    const s = sent.get(currency) ?? 0;
    const rc = recv.get(currency) ?? 0;
    return {
      currency,
      sent: (s / 10_000).toFixed(4),
      received: (rc / 10_000).toFixed(4),
      net: ((s - rc) / 10_000).toFixed(4),
    };
  });
}

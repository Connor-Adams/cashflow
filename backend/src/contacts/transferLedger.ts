export interface TransferRow {
  amount: string | number;
  currency: string;
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
 *  (money in, amount>0). Fixed-4 strings, integer-cents math to avoid float
 *  drift, sorted by currency.
 *
 *  This is a DESCRIPTIVE statistic — how much money crossed, and which way. It
 *  is NOT a debt: a positive net means more went out than came in, which is all
 *  it means. Rent split evenly and settled every month nets to whatever the
 *  last payment left behind, owing nobody anything. Claiming otherwise is the
 *  bug this module was demoted for; `computeLoanBalance` is the only function
 *  here allowed to answer "what do they owe me", and `formatNetFlowLabel` on
 *  the frontend words this one as "net out"/"net in" for that reason. */
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

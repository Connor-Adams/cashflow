import { resolveLedgerRole } from './counterpartyRole';

export interface BalanceInputRow {
  amount: string | number;
  currency: string;
  counterpartyRole: string | null;
}

export interface LoanBalance {
  currency: string;
  /** Total tagged as lent, absolute. */
  lent: string;
  /** Total tagged as repaid, absolute. */
  repaid: string;
  /** lent − repaid. Positive: they owe you. Negative: you owe them. */
  balance: string;
}

/** Scale matches computeTransferNet (transferLedger.ts) so both numbers round identically. */
const SCALE = 10_000;

function toUnits(n: number): number {
  return Math.round(n * SCALE);
}

/**
 * Signed per-currency loan balance, folded straight from tagged rows.
 *
 * There is deliberately no overpaid/unapplied state: a repayment exceeding
 * principal carries the balance through zero and the UI reads it as "you owe
 * them". A sign already expresses that; a holding pen would be a state machine
 * modelling arithmetic.
 *
 * Currencies never mix — no FX here, same as computeTransferNet.
 */
export function computeLoanBalance(
  rows: BalanceInputRow[],
  loanDefault: boolean,
): LoanBalance[] {
  const lent = new Map<string, number>();
  const repaid = new Map<string, number>();

  for (const r of rows) {
    const amount = Number(r.amount);
    const { effect } = resolveLedgerRole({
      role: r.counterpartyRole,
      amount,
      loanDefault,
    });
    if (effect === 'none') continue;
    const target = effect === 'loan' ? lent : repaid;
    target.set(r.currency, (target.get(r.currency) ?? 0) + toUnits(Math.abs(amount)));
  }

  const currencies = new Set([...lent.keys(), ...repaid.keys()]);
  return [...currencies].sort().map((currency) => {
    const l = lent.get(currency) ?? 0;
    const p = repaid.get(currency) ?? 0;
    return {
      currency,
      lent: (l / SCALE).toFixed(4),
      repaid: (p / SCALE).toFixed(4),
      balance: ((l - p) / SCALE).toFixed(4),
    };
  });
}

/*
 * There was a `mismatchedRowCount(rows, loanDefault)` here. It is deliberately
 * gone: its only caller was its own test, and it would have given a DIFFERENT
 * answer from the one the UI shows. The ledger route ships a per-row
 * `roleMismatch` and zeroes it for cancelled legs; this helper ran the
 * pre-cancellation set and counted them. A second, subtly-wrong path to a
 * number the route already computes is a drift hazard, not a convenience.
 * Direction-mismatch resolution stays covered by `counterpartyRole.test.ts`.
 */

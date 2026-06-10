import { Op, type Transaction as SequelizeTransaction } from 'sequelize';
import { InvestmentActivity } from '../models';

export type FuzzyMatchInput = {
  accountId: number;
  activityType: string;
  symbol: string | null;
  quantity: number | null;
  amount: number | null;
  currency: string;
  /** Date claimed by the activities-export row (settlement_date if populated, else transaction_date). */
  csvDate: string;
  /** Match window in calendar days around csvDate. Defaults to 5. */
  windowDays?: number;
  /**
   * Existing-row ids already consumed by earlier rows of the same commit
   * (matched as duplicates, or inserted by this commit and therefore visible
   * to this query inside the same SQL transaction). Each existing row may
   * absorb at most ONE incoming row — without this, two legitimate identical
   * activities within the window (recurring buys, equal staking rewards)
   * both match the same candidate and the second one is silently dropped.
   */
  excludeIds?: ReadonlySet<number>;
  t?: SequelizeTransaction;
};

export type FuzzyMatchOutcome =
  | { kind: 'no-match' }
  | {
      kind: 'single-match';
      existing: InvestmentActivity;
      /** True when the existing row had NULL settlement_date and CSV provides one. */
      backfillSettlement: boolean;
    }
  | { kind: 'multi-match'; candidates: InvestmentActivity[] };

/**
 * Shape of an existing row used for matching. The real Sequelize model has
 * many more fields; this is the minimal projection the matcher cares about.
 * Exposed for unit testing without a database.
 */
export type DedupCandidate = {
  id: number;
  quantity: string | null;
  amount: string | null;
  settlementDate: string | null;
  security?: { symbol: string | null } | null;
};

export type PureFuzzyOutcome<T extends DedupCandidate> =
  | { kind: 'no-match' }
  | { kind: 'single-match'; existing: T; backfillSettlement: boolean }
  | { kind: 'multi-match'; candidates: T[] };

/**
 * Normalize a numeric value to a fixed decimal string for comparison.
 * Returns null if input is null. Quantity is compared at 8 decimals even
 * though the column is now DECIMAL(28, 10): legacy rows inserted before the
 * widening migration (20260527130000) were truncated to 8dp by Postgres and
 * are never back-expanded, so 8dp remains the safe comparison floor across
 * the historical/new boundary. Amount stays at the column scale (4).
 */
function toFixedOrNull(v: number | null, scale: number): string | null {
  if (v == null) return null;
  return v.toFixed(scale);
}

/**
 * Apply the fuzzy-match predicate against an already-fetched candidate list.
 * Pure function — unit-testable without a database.
 */
export function pickFuzzyMatch<T extends DedupCandidate>(
  candidates: T[],
  input: Pick<FuzzyMatchInput, 'symbol' | 'quantity' | 'amount' | 'excludeIds'>,
): PureFuzzyOutcome<T> {
  const wantQty = toFixedOrNull(input.quantity, 8);
  const wantAmt = toFixedOrNull(input.amount, 4);
  const wantSym = input.symbol == null ? null : input.symbol.toUpperCase();

  const filtered = candidates.filter((c) => {
    if (input.excludeIds?.has(c.id)) return false;
    if (wantQty != null) {
      const got = c.quantity == null ? null : Number(c.quantity).toFixed(8);
      if (got !== wantQty) return false;
    } else if (c.quantity != null) {
      return false;
    }
    if (wantAmt != null) {
      const got = c.amount == null ? null : Number(c.amount).toFixed(4);
      if (got !== wantAmt) return false;
    } else if (c.amount != null) {
      return false;
    }
    if (wantSym != null) {
      const sym = c.security?.symbol;
      if (!sym || sym.toUpperCase() !== wantSym) return false;
    }
    return true;
  });

  if (filtered.length === 0) return { kind: 'no-match' };
  if (filtered.length === 1) {
    const existing = filtered[0]!;
    return {
      kind: 'single-match',
      existing,
      backfillSettlement: existing.settlementDate == null,
    };
  }
  return { kind: 'multi-match', candidates: filtered };
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Find an existing InvestmentActivity that represents the same logical event
 * as the incoming activities-export row, despite the two sources disagreeing
 * about which date to store.
 *
 * Why fuzzy:
 *   - Old per-account monthly-statement parser stores the "executed at" date
 *     (extracted by regex from the description) as `trade_date` and leaves
 *     `settlement_date` NULL.
 *   - Activities-export stores the settlement date as `transaction_date`
 *     (and again as `settlement_date` for trades).
 *   - These differ by T+1 to T+3 business days for stock trades; T+0 for
 *     most dividends; T-3 to T+3 for some ex-dividend vs pay-date drift.
 *
 * Match strategy:
 *   Identity tuple = (accountId, activityType, symbol, quantity, amount,
 *   currency). Window = ±5 calendar days on `trade_date`. Quantity compared
 *   at 8-decimal precision (DB column scale); amount at 4-decimal precision.
 *
 *   - 0 candidates → no-match (caller inserts)
 *   - 1 candidate  → single-match (caller backfills settlement_date if NULL
 *     and CSV has it)
 *   - 2+ candidates → multi-match (caller routes to review queue;
 *     never silent dup or silent skip)
 */
export async function findExistingInvestmentByFuzzyMatch(
  args: FuzzyMatchInput,
): Promise<FuzzyMatchOutcome> {
  const windowDays = args.windowDays ?? 5;
  const dateLo = shiftDate(args.csvDate, -windowDays);
  const dateHi = shiftDate(args.csvDate, windowDays);
  const wantCcy = args.currency.toUpperCase();

  const candidates = await InvestmentActivity.findAll({
    where: {
      accountId: args.accountId,
      activityType: args.activityType,
      currency: wantCcy,
      tradeDate: { [Op.between]: [dateLo, dateHi] },
    },
    include: args.symbol == null ? undefined : [{ association: 'security', required: false }],
    transaction: args.t,
  });

  const projected = candidates as unknown as (InvestmentActivity & DedupCandidate)[];

  return pickFuzzyMatch(projected, {
    symbol: args.symbol,
    quantity: args.quantity,
    amount: args.amount,
    excludeIds: args.excludeIds,
  });
}

/**
 * The ONE recurring-charge candidate loader.
 *
 * Every surface that runs `detectRecurring` over the transaction stream —
 * /api/recurring, subscription detection, money leaks, the cashflow forecast,
 * and the external /api/v1/recurring — must feed it the same candidates, or
 * the same household gets different "recurring" lists depending on where it
 * looks. Previously each held its own copy and /api/v1 had drifted to a SQL
 * `txnType NOT IN (payment, transfer, refund)` filter that skipped the
 * merchant-text classifier the others use.
 *
 * Candidate rule (what the four app surfaces agreed on):
 *  - charges only (amount < 0; refunds/credits/inbound payments are positive),
 *  - drop rows whose merchant text classifies as a payment/transfer
 *    (`classifyPositiveFlow(...) === 'payment'` — catches outbound transfers
 *    and bill-pay that land on the negative side),
 *  - merchant = trimmed merchantClean, else trimmed merchantRaw; blank → drop.
 */
import type { WhereOptions } from 'sequelize';
import { Transaction } from '../models';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';
import type { RecurringInputTxn } from '../routes/recurring';

/** Columns the candidate rule reads. Callers may select more. */
export const RECURRING_CANDIDATE_ATTRIBUTES = [
  'date',
  'currency',
  'amount',
  'merchantRaw',
  'merchantClean',
  'finalCategory',
] as const;

export type RecurringCandidateRow = {
  date: string;
  currency: string;
  amount: unknown;
  merchantRaw: string | null;
  merchantClean: string | null;
  finalCategory: string | null;
};

/** Pure filter: raw transaction rows → detectRecurring inputs. */
export function toRecurringCandidates(rows: readonly RecurringCandidateRow[]): RecurringInputTxn[] {
  const candidates: RecurringInputTxn[] = [];
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    if (amount >= 0) continue; // charges only
    if (
      classifyPositiveFlow({
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      }) === 'payment'
    ) {
      continue;
    }
    const merchant = (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
    if (!merchant) continue;
    candidates.push({
      merchant,
      amount,
      currency: row.currency,
      date: row.date,
      category: row.finalCategory,
    });
  }
  return candidates;
}

/**
 * Load candidates for `where` (the caller owns scope: household/visibility,
 * date window, optional currency/account filters).
 */
export async function loadRecurringCandidates(where: WhereOptions): Promise<RecurringInputTxn[]> {
  const rows = await Transaction.findAll({
    where,
    attributes: [...RECURRING_CANDIDATE_ATTRIBUTES],
    raw: true,
  });
  return toRecurringCandidates(rows as unknown as RecurringCandidateRow[]);
}

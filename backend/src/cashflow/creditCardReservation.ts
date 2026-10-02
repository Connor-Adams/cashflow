/**
 * Safe-to-spend credit-card reservation.
 *
 * Decides how much cash to reserve for a single credit card inside the
 * spending window. Reserves the *statement balance* (what is billed and due),
 * gated by the card's due day so a balance due next cycle isn't reserved this
 * window. Falls back to the full current balance when no statement data is
 * captured — still gated by the due day when it's known, and reserved in full
 * only when the due day is also unknown, so we never silently under-reserve.
 *
 * Payments made into the card after the statement was cut are netted off the
 * statement balance: the cash that paid them has already left the bank
 * accounts safe-to-spend counts, so reserving the full bill again would count
 * a paid card twice.
 */
import { classifyPositiveAmount } from '../summary/classifyTransactionFlow';

export type CreditCardReservationInput = {
  /** Magnitude of the full current running balance owed (positive), 0 if none. */
  currentBalanceOwed: number;
  /** Statement (billed) balance owed as a positive number, or null if uncaptured. */
  statementBalance: number | null;
  /** Day-of-month the payment is due, or null when unknown. */
  dueDay: number | null;
  /**
   * Sum of payments into the card dated after the statement date (positive).
   * Only applied against the statement balance; the no-statement fallback uses
   * the live running balance, which already nets them.
   */
  paymentsSinceStatement?: number;
};

/** One billing cycle plus slack: a statement older than this is stale. */
const STALE_STATEMENT_DAYS = 35;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True when some date in [startIso, endIso] (inclusive) has day-of-month === dueDay. */
function dueDayInWindow(dueDay: number, startIso: string, endIso: string): boolean {
  const [sy, sm, sd] = startIso.split('-').map((p) => parseInt(p, 10));
  const [ey, em, ed] = endIso.split('-').map((p) => parseInt(p, 10));
  let cur = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  while (cur <= end) {
    if (new Date(cur).getUTCDate() === dueDay) return true;
    cur += MS_PER_DAY;
  }
  return false;
}

export function creditCardReservation(
  card: CreditCardReservationInput,
  windowStartIso: string,
  windowEndIso: string,
): number {
  // No statement data captured — fall back to the full current balance, but
  // still gate by the due day when it's known so we don't reserve a balance
  // that isn't due until a later window.
  if (card.statementBalance == null) {
    // Nothing owed (or a credit balance) — reserve nothing.
    if (card.currentBalanceOwed <= 0) return 0;
    // No due day either — cannot gate; reserve the full balance (never under-reserve).
    if (card.dueDay == null) return card.currentBalanceOwed;
    // Due day known — reserve only when it actually falls inside the window.
    return dueDayInWindow(card.dueDay, windowStartIso, windowEndIso)
      ? card.currentBalanceOwed
      : 0;
  }
  // What is still unpaid of the bill: max(0, statement − payments since).
  const unpaid = card.statementBalance - Math.max(0, card.paymentsSinceStatement ?? 0);
  // Nothing billed, a credit balance, or already paid — reserve nothing.
  if (unpaid <= 0) return 0;
  // Statement balance known but no due day — reserve it (cannot gate by window).
  if (card.dueDay == null) return unpaid;
  // Reserve only when the due day actually falls inside the window.
  return dueDayInWindow(card.dueDay, windowStartIso, windowEndIso) ? unpaid : 0;
}

/**
 * True when a card-account row is a payment INTO the card: a positive amount
 * typed `payment` or `transfer` (the bank-side leg of a bill payment, as the
 * transfer-link stage pairs them), or an untyped inflow whose narrative reads as
 * a statement payment per the shared `classifyPositiveAmount` router. Refunds,
 * rewards and other credits are not payments.
 */
export function isCardPaymentInflow(row: {
  amount: number;
  txnType?: string | null;
  merchantRaw?: string | null;
  merchantClean?: string | null;
  category?: string | null;
}): boolean {
  if (!(row.amount > 0)) return false;
  if (row.txnType === 'transfer') return true;
  return (
    classifyPositiveAmount({ ...row, accountType: 'credit_card' }) === 'payment'
  );
}

/**
 * True when the stored statement is more than one billing cycle old relative
 * to `asOfIso` — a newer statement should exist but has not been imported, so
 * the reserved bill may be out of date. Null dates are never stale.
 */
export function isStatementStale(
  statementDateIso: string | null,
  asOfIso: string,
): boolean {
  if (statementDateIso == null) return false;
  const cutoff = new Date(
    Date.parse(`${asOfIso}T00:00:00Z`) - STALE_STATEMENT_DAYS * MS_PER_DAY,
  )
    .toISOString()
    .slice(0, 10);
  return statementDateIso < cutoff;
}

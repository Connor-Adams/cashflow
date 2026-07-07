/**
 * Safe-to-spend credit-card reservation.
 *
 * Decides how much cash to reserve for a single credit card inside the
 * spending window. Reserves the *statement balance* (what is billed and due),
 * gated by the card's due day so a balance due next cycle isn't reserved this
 * window. Falls back to the full current balance when no statement data is
 * captured — still gated by the due day when it's known, and reserved in full
 * only when the due day is also unknown, so we never silently under-reserve.
 */

export type CreditCardReservationInput = {
  /** Magnitude of the full current running balance owed (positive), 0 if none. */
  currentBalanceOwed: number;
  /** Statement (billed) balance owed as a positive number, or null if uncaptured. */
  statementBalance: number | null;
  /** Day-of-month the payment is due, or null when unknown. */
  dueDay: number | null;
};

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
  // Nothing billed (or a credit balance) — reserve nothing.
  if (card.statementBalance <= 0) return 0;
  // Statement balance known but no due day — reserve it (cannot gate by window).
  if (card.dueDay == null) return card.statementBalance;
  // Reserve only when the due day actually falls inside the window.
  return dueDayInWindow(card.dueDay, windowStartIso, windowEndIso)
    ? card.statementBalance
    : 0;
}

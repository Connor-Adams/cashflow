/**
 * Allocate line-of-credit interest to the people whose balances caused it.
 *
 * The method (see `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`):
 *
 *     their interest = their outstanding balance x the rate in force x days / 365
 *
 * per rate window, summed. Whatever is left of the window's printed applicable
 * interest is the account holder's own borrowing cost and is charged to nobody.
 *
 * This deliberately replaces the earlier pro-rata split of each interest charge.
 * Pro rata assumed the whole line funded loans to people; it doesn't, so it
 * quietly pushed the holder's own carrying cost onto the borrowers. Now that the
 * statement's Rate History gives us the actual rate per dated window, each
 * person's cost can be computed directly instead of inferred from a share.
 *
 * Simple interest, never compound. The statement is explicit that interest is
 * debited to the designated payment account rather than capitalised into the
 * line's principal, so there is nothing to compound. That holds only while the
 * interest is actually paid each month; if a payment is ever missed, revisit.
 *
 * Money is integer units of 1/10_000 of a currency unit throughout, the same
 * SCALE `computeLoanBalance` and `computeTransferNet` use, so the principal and
 * the interest on the same page round identically. Intermediate products are
 * BigInt: balance-days x a rate in basis-point-hundredths overflows float53 for
 * plausible inputs, and money must never accumulate in floats.
 */
import { resolveLedgerRole } from './counterpartyRole';

/** One row of the statement's Rate History table, as stored on `account_rate_periods`. */
export interface RateWindow {
  id: number;
  /** Inclusive first day, `YYYY-MM-DD`. */
  fromDate: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  toDate: string;
  /** Annual percentage, e.g. `8.9400` for 8.94%. DECIMAL(8,4): string on Postgres, number on SQLite. */
  effectiveRate: string | number;
  /** What RBC actually billed for this window. The hard upper bound on what we may allocate. */
  applicableInterest: string | number;
}

/** One contact-linked transaction, in the shape the ledger query returns. */
export interface LedgerRow {
  contactId: number;
  /** `YYYY-MM-DD` (a longer ISO timestamp is accepted; only the date part is read). */
  date: string;
  /** Signed. Negative is money leaving you, i.e. a loan out. */
  amount: string | number;
  currency: string;
  counterpartyRole: string | null;
  loanDefault: boolean;
}

export interface InterestAllocation {
  /** `null` for the unbilled tail from `accrueSinceLastWindow` — no statement window backs it. */
  rateWindowId: number | null;
  contactId: number;
  currency: string;
  /** Fixed(4), matching `LoanBalance`. */
  amount: string;
}

/** Matches computeLoanBalance / computeTransferNet so principal and interest round alike. */
const SCALE = 10_000;

/**
 * Divisor turning (balance-units x balance-days x rate-units) into interest-units.
 *
 *   rate-units are the annual percentage x 10_000 (DECIMAL(8,4)), so dividing by
 *   10_000 recovers the percentage and by a further 100 recovers the fraction;
 *   365 converts an annual rate to a daily one. 10_000 x 100 x 365.
 *
 * The balance's own 1/10_000 scale cancels: units in, units out.
 */
const RATE_DAY_DIVISOR = 365_000_000n;

const MS_PER_DAY = 86_400_000;

function toUnits(n: number): number {
  return Math.round(n * SCALE);
}

/** Epoch day number for a `YYYY-MM-DD` prefix. NaN when unparseable. */
function toEpochDay(iso: string): number {
  const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? Number.NaN : Math.round(ms / MS_PER_DAY);
}

/** Round a non-negative BigInt quotient to nearest, halves up. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * Fixed(4) rendering of a non-negative unit count, straight from the BigInt.
 *
 * Deliberately not `Number(units) / SCALE`: the round trip through float64 is
 * lossy above 2^53 units, and the whole point of carrying money as BigInt is
 * that it never touches a float.
 */
const SCALE_BIG = BigInt(SCALE);

function formatUnits(units: bigint): string {
  const whole = units / SCALE_BIG;
  const fraction = units % SCALE_BIG;
  return `${whole}.${fraction.toString().padStart(4, '0')}`;
}

interface Delta {
  /** Epoch day the balance changes on; the change is in force from this day inclusive. */
  day: number;
  /** Signed change in balance units. Positive: they owe you more. */
  units: number;
}

/**
 * Fold the ledger into per-contact, date-ordered balance deltas.
 *
 * Shared by `allocateWindowInterest` and `accrueSinceLastWindow` so the charged
 * and accrued figures agree about what counts as a loan: the role resolution is
 * `resolveLedgerRole`, not a local re-derivation, and if this drifted from
 * `computeLoanBalance` the principal and the interest on the same contact would
 * disagree about what a loan is.
 */
function buildDeltasByContact(
  rows: LedgerRow[],
  currency: string,
): { deltasByContact: Map<number, Delta[]>; contactIds: number[] } {
  const deltasByContact = new Map<number, Delta[]>();
  for (const row of rows) {
    if (row.currency !== currency) continue;
    const amount = Number(row.amount);
    const { effect } = resolveLedgerRole({
      role: row.counterpartyRole,
      amount,
      loanDefault: row.loanDefault,
    });
    if (effect === 'none') continue;
    const day = toEpochDay(row.date);
    if (Number.isNaN(day)) continue;
    const magnitude = toUnits(Math.abs(amount));
    const signed = effect === 'loan' ? magnitude : -magnitude;
    const list = deltasByContact.get(row.contactId);
    if (list) list.push({ day, units: signed });
    else deltasByContact.set(row.contactId, [{ day, units: signed }]);
  }
  for (const list of deltasByContact.values()) list.sort((a, b) => a.day - b.day);

  const contactIds = [...deltasByContact.keys()].sort((a, b) => a - b);
  return { deltasByContact, contactIds };
}

/**
 * Interest allocated per (rate window, contact), bounded by each window's printed
 * applicable interest.
 *
 * Only rows in `currency` participate — no FX, same as the rest of the ledger.
 * Only positive balances earn: you cannot charge interest to someone you owe, and
 * one overpaid contact must not subsidise another by contributing a negative.
 *
 * Output is sorted by (rateWindowId, contactId) and zero-amount pairs are dropped,
 * so a re-run over unchanged inputs is byte-identical and the persistence layer's
 * delete-then-write stays idempotent.
 */
export function allocateWindowInterest(
  windows: RateWindow[],
  rows: LedgerRow[],
  currency: string,
): InterestAllocation[] {
  const { deltasByContact, contactIds } = buildDeltasByContact(rows, currency);
  const out: InterestAllocation[] = [];

  for (const window of [...windows].sort((a, b) => a.id - b.id)) {
    const firstDay = toEpochDay(window.fromDate);
    const lastDay = toEpochDay(window.toDate);
    if (Number.isNaN(firstDay) || Number.isNaN(lastDay) || lastDay < firstDay) continue;

    const rateUnits = BigInt(Math.round(Number(window.effectiveRate) * SCALE));
    const capUnits = BigInt(Math.round(Number(window.applicableInterest) * SCALE));
    if (rateUnits <= 0n || capUnits <= 0n) continue;

    // Raw accrual per contact, before the bound is applied.
    const raw: { contactId: number; units: bigint }[] = [];
    let rawTotal = 0n;
    for (const contactId of contactIds) {
      const units = accrueWindow(deltasByContact.get(contactId) ?? [], firstDay, lastDay, rateUnits);
      if (units <= 0n) continue;
      raw.push({ contactId, units });
      rawTotal += units;
    }
    if (rawTotal <= 0n) continue;

    // The bound is the check, not padding: the sum for a window can never exceed
    // what RBC actually billed for it. A wrong rate, a double-counted balance or
    // a day-count off by one all show up here as an overshoot. Scaling keeps the
    // page honest; the overshoot itself is what a caller should be alarmed by.
    const final =
      rawTotal <= capUnits ? raw.map((r) => r.units) : scaleDownTo(raw.map((r) => r.units), rawTotal, capUnits);

    for (let i = 0; i < raw.length; i += 1) {
      if (final[i] <= 0n) continue;
      out.push({
        rateWindowId: window.id,
        contactId: raw[i].contactId,
        currency,
        amount: formatUnits(final[i]),
      });
    }
  }

  return out;
}

/**
 * Estimate interest accrued since the last billed window, at the current rate.
 *
 * `allocateWindowInterest` stops at the last statement — RBC has told us what it
 * billed there. Nothing has been billed for the days since, so this is the one
 * figure on the page not backed by a document; it must be labelled an estimate
 * wherever it is shown (see "Two figures, never merged" in the design doc).
 *
 * The tail runs from the day *after* `lastWindowEnd` through `asOf` inclusive —
 * `lastWindowEnd` itself already earned its day in the billed window, so
 * starting the count there would double-count it. `asOf` on or before
 * `lastWindowEnd` means there is no tail yet: empty, never negative days.
 *
 * Unlike `allocateWindowInterest`, there is no upper bound to scale to — nothing
 * has been billed for this period, so there is nothing to scale against. Balance
 * resolution goes through the same `buildDeltasByContact` (and so the same
 * `resolveLedgerRole`) as the charged figure, so the two never disagree about
 * what counts as a loan.
 */
export function accrueSinceLastWindow(args: {
  lastWindowEnd: string;
  asOf: string;
  currentRate: string | number;
  rows: LedgerRow[];
  currency: string;
}): InterestAllocation[] {
  const { lastWindowEnd, asOf, currentRate, rows, currency } = args;

  const lastWindowEndDay = toEpochDay(lastWindowEnd);
  const asOfDay = toEpochDay(asOf);
  if (Number.isNaN(lastWindowEndDay) || Number.isNaN(asOfDay)) return [];

  const firstDay = lastWindowEndDay + 1;
  const lastDay = asOfDay;
  if (lastDay < firstDay) return [];

  const rateUnits = BigInt(Math.round(Number(currentRate) * SCALE));
  if (rateUnits <= 0n) return [];

  const { deltasByContact, contactIds } = buildDeltasByContact(rows, currency);

  const out: InterestAllocation[] = [];
  for (const contactId of contactIds) {
    const units = accrueWindow(deltasByContact.get(contactId) ?? [], firstDay, lastDay, rateUnits);
    if (units <= 0n) continue;
    out.push({ rateWindowId: null, contactId, currency, amount: formatUnits(units) });
  }
  return out;
}

/**
 * One contact's accrual across one window.
 *
 * The balance is re-measured at every date that moves it rather than once for the
 * window, so a loan made mid-window earns only its remaining days and a repayment
 * mid-window stops earning from its own date. Both endpoints are inclusive: a
 * transaction dated on the window's last day earns exactly one day.
 *
 * Balance-days are summed first and the rate applied once, so the result rounds a
 * single time instead of once per segment.
 */
function accrueWindow(deltas: Delta[], firstDay: number, lastDay: number, rateUnits: bigint): bigint {
  let balance = 0;
  let index = 0;
  // Everything strictly before the window is already in force on day one.
  while (index < deltas.length && deltas[index].day < firstDay) {
    balance += deltas[index].units;
    index += 1;
  }

  let balanceDays = 0n;
  let segmentStart = firstDay;
  while (segmentStart <= lastDay) {
    // Absorb every delta landing on this segment's first day.
    while (index < deltas.length && deltas[index].day === segmentStart) {
      balance += deltas[index].units;
      index += 1;
    }
    // The segment runs until the next delta inside the window, or the window's end.
    const nextChange = index < deltas.length ? deltas[index].day : Number.POSITIVE_INFINITY;
    const segmentEnd = Math.min(lastDay, nextChange - 1);
    if (balance > 0) {
      balanceDays += BigInt(balance) * BigInt(segmentEnd - segmentStart + 1);
    }
    segmentStart = segmentEnd + 1;
  }

  if (balanceDays <= 0n) return 0n;
  return divRound(balanceDays * rateUnits, RATE_DAY_DIVISOR);
}

/**
 * Scale a set of raw accruals down so they sum to exactly `cap`.
 *
 * Floor each share, then hand the leftover units out by largest fractional
 * remainder (ties to the earlier entry, which is the lower contact id). Flooring
 * alone can never overshoot the bound; the remainder pass makes the total land on
 * the printed figure exactly rather than a hair under it, and is deterministic, so
 * a re-run produces the same bytes.
 */
function scaleDownTo(rawUnits: bigint[], rawTotal: bigint, cap: bigint): bigint[] {
  const scaled: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0n;

  for (let i = 0; i < rawUnits.length; i += 1) {
    const product = rawUnits[i] * cap;
    const share = product / rawTotal;
    scaled.push(share);
    assigned += share;
    remainders.push({ index: i, remainder: product % rawTotal });
  }

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  let leftover = cap - assigned;
  for (const { index } of remainders) {
    if (leftover <= 0n) break;
    scaled[index] += 1n;
    leftover -= 1n;
  }

  return scaled;
}

/**
 * Shared planned-occurrence derivation for the forecast subsystem (#404).
 *
 * Both GET /api/forecast (routes/forecast.ts) and safe-to-spend
 * (cashflow/safeToSpend.ts) need the SAME pipeline: pull in-window
 * PlannedEvent rows (ordinary `planned` + `subscription` kinds), synthesize an
 * RRULE for subscriptions that carry a `cadence` instead of a `recurrenceRule`,
 * then expand each row across the window via `expandRecurrence`. Before #404
 * that block was duplicated byte-for-byte in both files; the duplicate drifted
 * (e.g. the subscription fold had to be applied twice). This is the one copy.
 *
 * What stays OUT of here (intentional divergences — folding them would silently
 * change one consumer's numbers):
 *   - Recurring DETECTION (merchant-inferred charges + income) is forecast-only
 *     (routes/forecast.ts). Not an occurrence-gathering step.
 *   - Cash-balance computation: forecast 'opening cash' excludes only
 *     `investment`; safe-to-spend 'current cash' also excludes `credit_card` +
 *     `loan`. Each caller computes its own; we share only currency resolution.
 *   - The safe-to-spend deduction stack (goals, CC payments, buffer, toggles).
 */
import { Op, type WhereOptions } from 'sequelize';

import { PlannedEvent } from '../models/PlannedEvent';
import { Account } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import {
  expandRecurrence,
  cadenceToRecurrenceRule,
  type PlannedEventLike,
} from './expandRecurrence';

/** One expanded planned-event occurrence inside the requested window. */
export type PlannedOccurrence = {
  /** YYYY-MM-DD */
  date: string;
  /** The PlannedEvent this occurrence was expanded from. */
  row: PlannedEvent;
};

export type GatherPlannedOccurrencesParams = {
  householdId: number;
  /** 3-letter ISO currency the rows must match. */
  currency: string;
  /** Window start (inclusive), YYYY-MM-DD. */
  from: string;
  /** Window end (inclusive), YYYY-MM-DD. */
  to: string;
  /** Optional PlannedEvent.type filter (e.g. 'expense' for safe-to-spend). */
  typeFilter?: PlannedEvent['type'];
  /** Optional account scope (forecast supports ?accountId). */
  accountId?: number | null;
};

/**
 * The single source of truth for "which planned-event occurrences land in this
 * window". Queries currency-matched `planned`+`subscription` rows with
 * `status='planned'` and `expectedDate <= to` (the seed for a long-running
 * recurring row may predate the window), synthesizes RRULEs for subscriptions,
 * and expands each across the inclusive [from, to] window. Returns the flat
 * occurrence list paired with its owning row so callers can read amount/type/
 * direction/name as they need.
 */
export async function gatherPlannedOccurrences(
  params: GatherPlannedOccurrencesParams,
): Promise<PlannedOccurrence[]> {
  const where: WhereOptions = {
    householdId: params.householdId,
    kind: { [Op.in]: ['planned', 'subscription'] },
    currency: params.currency,
    status: 'planned',
    expectedDate: { [Op.lte]: params.to },
  };
  if (params.typeFilter !== undefined) {
    (where as Record<string, unknown>).type = params.typeFilter;
  }
  if (params.accountId !== undefined && params.accountId !== null) {
    (where as Record<string, unknown>).accountId = params.accountId;
  }

  const rows = await PlannedEvent.findAll({
    where,
    order: [['expectedDate', 'ASC']],
  });

  const out: PlannedOccurrence[] = [];
  for (const row of rows) {
    // Subscriptions encode recurrence as a `cadence` and anchor on
    // nextExpectedDate; synthesize an RRULE so they expand like any other
    // recurring event. Ordinary planned events keep their stored rule.
    const hasExplicitRule =
      row.recurrenceRule != null && row.recurrenceRule.trim() !== '';
    const recurrenceRule = hasExplicitRule
      ? row.recurrenceRule
      : row.kind === 'subscription'
        ? cadenceToRecurrenceRule(row.cadence)
        : null;
    const seedDate =
      row.kind === 'subscription' && row.nextExpectedDate
        ? row.nextExpectedDate
        : row.expectedDate;
    const eventLike: PlannedEventLike = {
      id: row.id,
      expectedDate: seedDate,
      recurrenceRule,
      status: row.status,
    };
    const occs = expandRecurrence(eventLike, params.from, params.to);
    for (const occ of occs) {
      out.push({ date: occ.date, row });
    }
  }
  return out;
}

/**
 * Pure tiebreak: pick the currency with the largest absolute summed balance.
 * Ties prefer CAD (Cashflow's primary currency). Empty map → null. Shared by
 * both the forecast route's currency pick and safe-to-spend's
 * `resolveForecastCurrency` so the algorithm lives in exactly one place. The
 * comparison is order-preserving regardless of unit scale (dollars vs cents),
 * so callers may pass whichever they already have.
 */
export function pickCurrencyByLargestAbsBalance(
  summed: Map<string, number>,
): string | null {
  let best: { currency: string; absAmount: number } | null = null;
  for (const [ccy, amt] of summed) {
    const abs = Math.abs(amt);
    if (!best || abs > best.absAmount || (ccy === 'CAD' && abs === best.absAmount)) {
      best = { currency: ccy, absAmount: abs };
    }
  }
  return best?.currency ?? null;
}

/**
 * Resolve which currency to compute against when the caller omits one: the
 * currency with the largest absolute cash balance across the household's
 * eligible accounts, CAD on ties, CAD when there's no cash on hand yet.
 *
 * `excludedTypes` lets each caller keep its own exclusion set — the forecast
 * route excludes only `investment`; safe-to-spend also excludes `credit_card`
 * and `loan`. Only the largest-abs/CAD-tiebreak *algorithm* is shared (via
 * `pickCurrencyByLargestAbsBalance`); the account set is the caller's choice.
 */
export async function resolveForecastCurrency(
  householdId: number,
  asOfDate: string,
  excludedTypes: ReadonlySet<string>,
): Promise<string> {
  const accounts = await Account.findAll({ where: { householdId } });
  const eligible = accounts.filter((a) => {
    if (excludedTypes.has(a.accountType)) return false;
    if (a.closedAt && a.closedAt <= asOfDate) return false;
    return true;
  });
  const summed = new Map<string, number>();
  for (const acc of eligible) {
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency, amount } of bal) {
      summed.set(currency, (summed.get(currency) ?? 0) + amount);
    }
  }
  return pickCurrencyByLargestAbsBalance(summed) ?? 'CAD';
}

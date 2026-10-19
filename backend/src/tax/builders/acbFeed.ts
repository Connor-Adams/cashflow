import { Op } from 'sequelize';
import { InvestmentActivity } from '../../models';
import { D, Decimal } from '../util/decimal';
import type { AcbActivity, AcbLotState, AcbRealizedEvent } from '../../portfolio/acb';

/**
 * The ACB feed and the 61-day identical-property window, shared by the personal
 * (T1) and corporate (T2) fact builders.
 *
 * Both loss-denial rules that apply to capital property look at the same window:
 *   - individuals: the s.54 "superficial loss" definition, (a) "during the period
 *     that begins 30 days before and ends 30 days after the disposition, the
 *     taxpayer or a person affiliated with the taxpayer acquires a property ...
 *     that is, or is identical to, the particular property", and (b) "at the end
 *     of that period ... owns or had a right to acquire the substituted property";
 *   - corporations, trusts and partnerships: s.40(3.3)(b) and (c), worded the
 *     same way. The superficial-loss definition excludes, at (h), "a disposition
 *     to which subsection 40(3.4) ... applies", so a corporation is under the
 *     stop-loss rule INSTEAD of the superficial-loss rule, never both.
 *
 * What the two rules then DO differs, and lives in each builder: a superficial
 * loss is nil (s.40(2)(g)(i)) and is added to the ACB of the substituted
 * property (s.53(1)(f)); a stop-loss is deemed nil (s.40(3.4)(a)) and suspended,
 * with no ACB adjustment (see corpStopLoss.ts).
 */

/** Days either side of a disposition in the identical-property window. */
export const LOSS_WINDOW_DAYS = 30;

/** 'YYYY-MM-DD' plus `days` (negative to subtract), at UTC midnight. */
export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Whole-day difference (a − b) between two 'YYYY-MM-DD' dates at UTC midnight. */
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round((da - db) / 86_400_000);
}

/** The 61-day window, same day included: 30 days before through 30 days after. */
export function lossWindow(dispositionDate: string): { start: string; end: string } {
  return {
    start: addDays(dispositionDate, -LOSS_WINDOW_DAYS),
    end: addDays(dispositionDate, LOSS_WINDOW_DAYS),
  };
}

/** A disposition that realized a loss on a non-zero quantity. */
export function isLossEvent(ev: AcbRealizedEvent): boolean {
  return ev.qtySold > 0 && D(ev.proceeds).minus(D(ev.costRemoved)).lessThan(0);
}

/**
 * Units held at the end of `date`: the last ACB timeline state at-or-before it.
 * The timeline is chronological; the feed runs 30 days past the period end, so a
 * window opened by a late-period disposition is fully covered.
 */
export function heldAt(timeline: AcbLotState[], date: string): number {
  let held = 0;
  for (const st of timeline) {
    if (st.asOf > date) break;
    held = st.quantity;
  }
  return held;
}

/**
 * The part of one loss disposition the identical-property window catches.
 *
 * Both rules ask whether the disposed property, "or [property] identical to"
 * it, was acquired in the window and still owned at its end. Each unit is its
 * own property, so with fungible units only as many of the disposed units can
 * be caught as were both acquired in the window and held at its end. That is
 * CRA's administrative proration for superficial losses (T.I. 2004-0073011E5):
 * min(S, P, B) / S × loss, where S = units sold, P = units acquired in the
 * window, B = units held at the window end. CRA has published no separate
 * formula for s.40(3.4); the corporate builder applies the same per-unit
 * matching because the statutory test is worded identically.
 *
 * Returns undefined when the event is not a loss or nothing is caught.
 */
export function computeDeniedPortion(
  realized: AcbRealizedEvent,
  acts: InvestmentActivity[],
  timeline: AcbLotState[],
): Decimal | undefined {
  const rawGain = D(realized.proceeds).minus(D(realized.costRemoved));
  if (!rawGain.lessThan(0) || realized.qtySold <= 0) return undefined;
  const { start, end } = lossWindow(realized.tradeDate);
  const acquiredInWindow = acts
    .filter(a =>
      (a.activityType === 'buy' || a.activityType === 'reinvestment')
      && (a.tradeDate as unknown as string) >= start
      && (a.tradeDate as unknown as string) <= end)
    .reduce((sum, a) => sum + (a.quantity != null ? Number(a.quantity) : 0), 0);
  const heldAtWindowEnd = heldAt(timeline, end);
  if (acquiredInWindow > 0 && heldAtWindowEnd > 0) {
    const deniedUnits = Math.min(realized.qtySold, acquiredInWindow, heldAtWindowEnd);
    return rawGain.negated().times(deniedUnits).dividedBy(realized.qtySold);
  }
  return undefined;
}

/** One security's slice of the ACB feed, converted to CAD and ready for computeAcb. */
export type SecurityAcbFeed = {
  securityId: number;
  /** The raw activity rows, for the window's acquisition count. */
  acts: InvestmentActivity[];
  acbInput: AcbActivity[];
};

/**
 * Load every activity on `accountIds` through `periodEnd` + 30 days, grouped by
 * security and converted to CAD leg by leg.
 *
 * ACB is a weighted-average running balance (s.47), so the walk needs the FULL
 * per-security history — a period-windowed feed makes prior-year buys (and
 * return_of_capital) invisible, collapsing ACB to ~0 and overstating gains as
 * near-$0-cost dispositions. The extra 30 days let the window see repurchases
 * after the period end for a disposition late in it. Callers keep only the
 * dispositions that settled DURING the period.
 *
 * CRA requires per-leg FX conversion: each buy/sell/fee leg converts at its own
 * trade-date rate, so the walk — and the CapGainEvent the engine treats as CAD —
 * is genuinely in CAD (proceeds at the sale-date rate, cost base accumulated at
 * acquisition-date rates).
 */
export async function loadAcbFeed(
  accountIds: number[],
  periodEnd: string,
  toCad: (amount: Decimal, currency: string, date: string) => Promise<Decimal>,
): Promise<SecurityAcbFeed[]> {
  const acbActivity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.lte]: addDays(periodEnd, LOSS_WINDOW_DAYS) },
        },
      })
    : [];

  const securityIds = Array.from(
    new Set(acbActivity.map((a) => a.securityId).filter((x): x is number => x != null)),
  );
  const feed: SecurityAcbFeed[] = [];
  for (const securityId of securityIds) {
    const acts = acbActivity.filter((a) => a.securityId === securityId);
    const acbInput: AcbActivity[] = [];
    for (const a of acts) {
      const currency = (a.currency as string | null) ?? 'CAD';
      const tradeDate = a.tradeDate as unknown as string;
      let amount = a.amount != null ? Number(a.amount) : null;
      let fees = a.fees != null ? Number(a.fees) : null;
      if (currency !== 'CAD') {
        if (amount != null) amount = (await toCad(D(amount), currency, tradeDate)).toNumber();
        if (fees != null) fees = (await toCad(D(fees), currency, tradeDate)).toNumber();
      }
      acbInput.push({
        id: a.id as number,
        activityType: a.activityType as string,
        tradeDate,
        quantity: a.quantity != null ? Number(a.quantity) : null,
        amount,
        currency: 'CAD',
        fees,
        splitRatio: a.splitRatio != null ? Number(a.splitRatio) : null,
        costBasisAllocationPct:
          a.costBasisAllocationPct != null ? Number(a.costBasisAllocationPct) : null,
        cashComponent: a.cashComponent != null ? Number(a.cashComponent) : null,
        recipientSecurityId: a.recipientSecurityId ?? null,
      });
    }
    feed.push({ securityId, acts, acbInput });
  }
  return feed;
}

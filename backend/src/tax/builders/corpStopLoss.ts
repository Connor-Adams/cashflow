import type { InvestmentActivity } from '../../models';
import type { AcbResult } from '../../portfolio/acb';
import { Decimal } from '../util/decimal';
import type { SuspendedCapitalLoss } from '../engine/types';
import {
  LOSS_WINDOW_DAYS,
  addDays,
  computeDeniedPortion,
  daysBetween,
  isLossEvent,
  lossWindow,
} from './acbFeed';

/**
 * The corporate stop-loss rule for capital property, ITA s.40(3.3) and (3.4).
 *
 * s.40(3.3): subsection (3.4) applies when
 *   (a) "a corporation, trust or partnership (... the 'transferor') disposes of a
 *       particular capital property" (other than prescribed-class depreciable
 *       property, and not in a disposition described in paragraphs (c) to (g) of
 *       the s.54 superficial-loss definition — deemed dispositions, option
 *       expiry, etc.);
 *   (b) "during the period that begins 30 days before and ends 30 days after the
 *       disposition, the transferor or a person affiliated with the transferor
 *       acquires a property (... the 'substituted property') that is, or is
 *       identical to, the particular property"; and
 *   (c) "at the end of the period, the transferor or a person affiliated with
 *       the transferor owns the substituted property".
 *
 * s.40(3.4): then
 *   (a) "the transferor's loss, if any, from the disposition is deemed to be
 *       nil", and
 *   (b) that loss "is deemed to be a loss of the transferor from a disposition
 *       of the particular property at the time that is immediately before the
 *       first time, after the disposition, (i) at which a 30-day period begins
 *       throughout which neither the transferor nor a person affiliated with the
 *       transferor owns (A) the substituted property, or (B) a property that is
 *       identical to the substituted property and that was acquired after the
 *       day that is 31 days before the period begins", or (ii)-(v) emigration /
 *       tax-exempt status (s.128.1, s.149(10)), a loss restriction event, a
 *       s.50 deemed disposition, or a winding-up.
 *
 * Unlike a superficial loss there is NO s.53(1)(f) addition to the substituted
 * property's ACB — the loss is parked and comes back whole, so the ACB walk is
 * left untouched.
 *
 * What is modelled, from this corporation's own investment ledger:
 *   - (3.3)(b)/(c): identical property = the same security. Acquisitions are
 *     buys and reinvestments; ownership at the window end is the ACB timeline's
 *     quantity. Partial repurchases suspend only the matched units (see
 *     computeDeniedPortion).
 *   - (3.4)(b)(i): the loss is recognized at the first date on or after the
 *     disposition where the corporation's position in the security is zero and
 *     no unit is acquired within the next 30 days. While ANY unit of the security
 *     is held the loss stays suspended — the ledger cannot tell which fungible
 *     unit is "the substituted property", and holding on defers rather than
 *     accelerates the loss.
 *
 * Not modelled (the builder raises a warning instead): holdings of affiliated
 * persons (s.251.1 — the controlling shareholder, their spouse, other
 * corporations they control), and the (3.4)(b)(ii)-(v) triggers.
 */

const EPS = 1e-9;

export type CorpStopLossResult = {
  /** Suspended amount per in-period disposition, keyed by activity id. */
  suspendedByActivity: Map<number, Decimal>;
  /** Losses whose s.40(3.4)(b)(i) recognition date falls in the period. */
  released: SuspendedCapitalLoss[];
  /** Every suspension relevant to the period (suspended in it, released in it, or still open at its end). */
  report: SuspendedCapitalLoss[];
  /** Number of in-period loss dispositions tested. */
  lossDispositionsTested: number;
  warnings: string[];
};

/**
 * First date on or after `from` at which the position is zero and stays zero
 * for 30 days — the start of the (3.4)(b)(i) 30-day period. Null when that has
 * not happened within the feed.
 */
function firstReleaseDate(timeline: AcbResult['timeline'], from: string): string | null {
  for (let i = 0; i < timeline.length; i += 1) {
    const st = timeline[i];
    if (st.asOf < from || st.quantity > EPS) continue;
    const next = timeline.slice(i + 1).find((s) => s.quantity > EPS);
    // A unit back within 30 days means this zero stretch is not a full
    // 30-day period; keep looking after it.
    if (next && daysBetween(next.asOf, st.asOf) <= LOSS_WINDOW_DAYS) continue;
    return st.asOf;
  }
  return null;
}

/**
 * Apply s.40(3.3)/(3.4) to one security's full-history ACB walk.
 *
 * Every loss disposition through `endDate` is tested, not just this period's:
 * a loss suspended years ago is recognized in whichever period its
 * (3.4)(b)(i) date falls, so the history has to be replayed to find it. That
 * keeps the rule stateless — nothing is persisted between returns.
 */
export function applyCorpStopLoss(args: {
  securityId: number;
  acts: InvestmentActivity[];
  acb: AcbResult;
  startDate: string;
  endDate: string;
  /** 'YYYY-MM-DD'; windows that close after it may still change. */
  today: string;
}): CorpStopLossResult {
  const { securityId, acts, acb, startDate, endDate, today } = args;
  const suspendedByActivity = new Map<number, Decimal>();
  const released: SuspendedCapitalLoss[] = [];
  const report: SuspendedCapitalLoss[] = [];
  const warnings: string[] = [];
  let lossDispositionsTested = 0;

  for (const ev of acb.realizedEvents) {
    if (ev.tradeDate > endDate || !isLossEvent(ev)) continue;
    const inPeriod = ev.tradeDate >= startDate;
    if (inPeriod) lossDispositionsTested += 1;

    const windowEnd = lossWindow(ev.tradeDate).end;
    if (inPeriod && windowEnd > today) {
      warnings.push(
        `The s.40(3.3) window for the ${ev.tradeDate} capital loss on security ${securityId} `
        + `runs to ${windowEnd}, after today; the loss's treatment can still change if identical `
        + 'property is bought before then.',
      );
    }

    const suspended = computeDeniedPortion(ev, acts, acb.timeline);
    if (!suspended) continue;
    if (inPeriod) suspendedByActivity.set(ev.activityId, suspended);

    // (3.4)(b)(i) — "the first time, after the disposition" — so the zero
    // stretch is searched from the disposition date on.
    const releasedOn = firstReleaseDate(acb.timeline, ev.tradeDate);
    // Recognized before this period: already on an earlier return.
    if (releasedOn != null && releasedOn < startDate) continue;
    const releasedInPeriod = releasedOn != null && releasedOn <= endDate;
    const item: SuspendedCapitalLoss = {
      securityId,
      dispositionDate: ev.tradeDate,
      amount: suspended,
      releasedOn: releasedInPeriod ? releasedOn : null,
    };
    report.push(item);
    if (releasedInPeriod) {
      released.push(item);
      const confirmedBy = addDays(releasedOn, LOSS_WINDOW_DAYS);
      if (confirmedBy > today) {
        warnings.push(
          `The suspended ${ev.tradeDate} loss on security ${securityId} is recognized on `
          + `${releasedOn} on the assumption that no identical property is bought by ${confirmedBy}; `
          + 'a repurchase before then keeps it suspended.',
        );
      }
    }
  }

  return { suspendedByActivity, released, report, lossDispositionsTested, warnings };
}

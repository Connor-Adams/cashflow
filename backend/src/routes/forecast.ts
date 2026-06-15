import { Router, type Request } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { PlannedEvent } from '../models/PlannedEvent';
import { Account, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { resolveHouseholdToday, type HasTimezone } from '../time/householdToday';
import { balanceAtDate } from '../networth/balanceAtDate';
import {
  expandRecurrence,
  cadenceToRecurrenceRule,
  type PlannedEventLike,
} from '../forecast/expandRecurrence';
import {
  buildForecast,
  type ForecastOccurrence,
} from '../forecast/buildForecast';
import {
  detectRecurringIncome,
  type IncomeInputTxn,
} from '../forecast/detectIncome';
import { detectRecurring, type RecurringInputTxn } from './recurring';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';
import { computeSafeToSpend } from '../cashflow/safeToSpend';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Defaults for an open-ended forecast. 7/30/90 are the AC-required range
// presets, so 90 is a sensible upper bound for the default window when the
// caller omits dateTo. dateFrom defaults to today so the chart starts at
// "now" — historical balance lives in net-worth, not here.
const DEFAULT_FORECAST_DAYS = 30;
const MAX_FORECAST_DAYS = 365;

// Match aggregate.ts: investment accounts are driven by portfolio value,
// not by transaction cash-flow. Excluding them keeps the forecast about
// money available to spend, not paper net worth.
const FORECAST_EXCLUDED_TYPES = new Set(['investment']);

// Recurring detector tuning for forecast use. We only project txns that
// looked recurring over the last 180 days (the detector default) with at
// least three occurrences. Anything weaker is too noisy to project forward.
const RECURRING_LOOKBACK_DAYS = 180;
const RECURRING_MIN_OCCURRENCES = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Forecast-window origin: "today" in the household's zone (not UTC). */
function todayIso(household: HasTimezone | null | undefined): string {
  return resolveHouseholdToday(household);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map((p) => parseInt(p, 10));
  const [ty, tm, td] = toIso.split('-').map((p) => parseInt(p, 10));
  const f = Date.UTC(fy, fm - 1, fd);
  const t = Date.UTC(ty, tm - 1, td);
  return Math.round((t - f) / MS_PER_DAY);
}

function parseRange(req: Request): { dateFrom: string; dateTo: string } | { error: string } {
  let dateFrom = todayIso(currentAuth(req).household);
  let dateTo = addDaysIso(dateFrom, DEFAULT_FORECAST_DAYS);
  if (req.query.dateFrom) {
    const raw = String(req.query.dateFrom);
    if (!ISO_DATE_RE.test(raw)) return { error: 'dateFrom must be YYYY-MM-DD' };
    dateFrom = raw;
  }
  if (req.query.dateTo) {
    const raw = String(req.query.dateTo);
    if (!ISO_DATE_RE.test(raw)) return { error: 'dateTo must be YYYY-MM-DD' };
    dateTo = raw;
  }
  if (dateTo < dateFrom) {
    return { error: 'dateTo must be on or after dateFrom' };
  }
  // Cap horizon to keep the response bounded.
  if (diffDays(dateFrom, dateTo) > MAX_FORECAST_DAYS) {
    return { error: `dateTo cannot be more than ${MAX_FORECAST_DAYS} days after dateFrom` };
  }
  return { dateFrom, dateTo };
}

/**
 * Map PlannedEventType → forecast direction. Income flows in; expense and
 * debt_payment flow out; transfer and settlement net out at the household
 * level (zero net cash impact unless one side is a real outflow, which we
 * surface via the underlying expense/income row instead); savings is a
 * household-level outflow (cash leaves the cashflow accounts and lands in
 * an investment / parked account).
 */
function directionOfPlannedEvent(
  type: PlannedEvent['type'],
): ForecastOccurrence['direction'] {
  switch (type) {
    case 'income':
      return 'in';
    case 'expense':
    case 'debt_payment':
    case 'savings':
      return 'out';
    case 'transfer':
    case 'settlement':
      return 'neutral';
  }
}

type SerializedOccurrence = {
  date: string;
  amount: number;
  direction: ForecastOccurrence['direction'];
  sourceType: ForecastOccurrence['sourceType'];
  sourceId: number;
  sourceName: string;
  accountId: number | null;
};

function serializeOccurrence(o: ForecastOccurrence): SerializedOccurrence {
  return {
    date: o.date,
    amount: o.amount,
    direction: o.direction,
    sourceType: o.sourceType,
    sourceId: o.sourceId,
    sourceName: o.sourceName,
    accountId: o.accountId,
  };
}

/**
 * GET /api/forecast — projected cashflow over a date range.
 *
 * Query parameters:
 *   - dateFrom (YYYY-MM-DD, default today)
 *   - dateTo (YYYY-MM-DD, default today + 30 days, capped at +365)
 *   - currency (3-letter ISO, default the household's most common cash
 *     currency, derived from accounts)
 *   - accountId (integer, optional — limit forecast to one account)
 *   - includeRecurring (default 'true' — set to 'false' to exclude inferred
 *     subscription-style recurring charges from /api/recurring detector)
 *
 * Response:
 *   {
 *     currency: 'CAD',
 *     dateFrom: '2026-06-01',
 *     dateTo: '2026-06-30',
 *     openingBalance: 5234.12,
 *     projectedClosingBalance: 5980.45,
 *     lowestProjectedBalance: 3120.45,
 *     lowestProjectedBalanceDate: '2026-06-15',
 *     dailyPoints: [{ date, balance }],
 *     events: [{ date, amount, direction, sourceType, sourceId, sourceName,
 *               accountId }]
 *   }
 */
router.get('/', async (req, res, next) => {
  try {
    const range = parseRange(req);
    if ('error' in range) {
      res.status(400).json({ error: range.error });
      return;
    }
    const { dateFrom, dateTo } = range;

    const includeRecurringRaw = String(req.query.includeRecurring ?? 'true').toLowerCase();
    const includeRecurring = includeRecurringRaw !== 'false' && includeRecurringRaw !== '0';

    let accountIdFilter: number | null = null;
    if (req.query.accountId !== undefined && req.query.accountId !== '') {
      const parsed = parseInt(String(req.query.accountId), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: 'accountId must be a positive integer' });
        return;
      }
      accountIdFilter = parsed;
    }

    let currencyFilter: string | null = null;
    if (req.query.currency !== undefined && req.query.currency !== '') {
      const raw = String(req.query.currency).trim().toUpperCase();
      if (raw.length !== 3) {
        res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
        return;
      }
      currencyFilter = raw;
    }

    // ----- 1. Resolve in-scope accounts ----------------------------------
    const accountWhere: WhereOptions = { ...householdWhere(req) };
    if (accountIdFilter !== null) {
      (accountWhere as Record<string, unknown>).id = accountIdFilter;
    }
    const allAccounts = await Account.findAll({ where: accountWhere });

    const eligible = allAccounts.filter((a) => {
      if (FORECAST_EXCLUDED_TYPES.has(a.accountType)) return false;
      // Closed accounts can't contribute to a future-looking forecast.
      if (a.closedAt && a.closedAt <= dateFrom) return false;
      return true;
    });

    if (accountIdFilter !== null && eligible.length === 0) {
      res.status(404).json({ error: 'Account not found or not eligible for forecast' });
      return;
    }

    // ----- 2. Pick the forecast currency ---------------------------------
    // If caller didn't specify, use the currency of the largest balance
    // among eligible accounts (computed in step 3). For now stage default
    // to CAD; we'll recompute below if no override was given.
    let forecastCurrency = currencyFilter ?? 'CAD';

    // ----- 3. Compute opening balance per currency across eligible accounts
    // We compute balances per-currency for each account (an account may hold
    // multiple currencies) then sum them, picking the requested currency.
    type CurrencyBalanceSum = Map<string, number>;
    const summed: CurrencyBalanceSum = new Map();
    for (const acc of eligible) {
      const balances = await balanceAtDate(acc, dateFrom);
      for (const { currency, amount } of balances) {
        summed.set(currency, (summed.get(currency) ?? 0) + amount);
      }
    }

    if (currencyFilter === null) {
      // Pick the currency with the largest absolute balance (most cash on
      // hand). Tie-breaker: prefer CAD when present.
      let best: { currency: string; absAmount: number } | null = null;
      for (const [ccy, amt] of summed) {
        const abs = Math.abs(amt);
        if (!best || abs > best.absAmount || (ccy === 'CAD' && abs === best.absAmount)) {
          best = { currency: ccy, absAmount: abs };
        }
      }
      if (best) forecastCurrency = best.currency;
    }

    const openingBalance = summed.get(forecastCurrency) ?? 0;

    // ----- 4. Gather PlannedEvent rows in the window (currency-matched) --
    // We pull events overlapping the window: expectedDate may sit before
    // dateFrom (recurring) but contribute future occurrences inside the
    // window. Pull all currency-matched planned-events with expectedDate
    // <= dateTo (so the seed for recurring events qualifies even if it
    // started long before the window).
    // Include both ordinary planned events and subscription-kind expectations.
    // Subscriptions carry a `cadence` instead of a recurrenceRule (synthesized
    // below); excluding them here was why tracked subscriptions never showed
    // up in the forecast.
    const eventWhere: WhereOptions = {
      ...householdWhere(req),
      kind: { [Op.in]: ['planned', 'subscription'] },
      currency: forecastCurrency,
      status: 'planned',
      expectedDate: { [Op.lte]: dateTo },
    };
    if (accountIdFilter !== null) {
      (eventWhere as Record<string, unknown>).accountId = accountIdFilter;
    }
    const plannedRows = await PlannedEvent.findAll({
      where: eventWhere,
      order: [['expectedDate', 'ASC']],
    });

    const allOccurrences: ForecastOccurrence[] = [];
    for (const row of plannedRows) {
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
      const occs = expandRecurrence(eventLike, dateFrom, dateTo);
      const amount = Number(row.amount);
      if (!Number.isFinite(amount)) continue;
      const direction = directionOfPlannedEvent(row.type);
      for (const occ of occs) {
        allOccurrences.push({
          date: occ.date,
          amount,
          direction,
          sourceType: 'planned_event',
          sourceId: row.id,
          sourceName: row.name,
          accountId: row.accountId,
        });
      }
    }

    // ----- 5. Optionally include detected recurring charges --------------
    // These come from the existing recurring detector — merchants that
    // historically charge weekly/monthly. We project each future occurrence
    // inside the window as an expense (negative direction). We dedupe
    // against PlannedEvent rows so a user who has already created a
    // planned event for "Netflix" doesn't get a duplicate from the detector.
    if (includeRecurring) {
      const txnSince = addDaysIso(dateFrom, -RECURRING_LOOKBACK_DAYS);
      const txnWhere: WhereOptions = {
        ...householdWhere(req),
        date: { [Op.gte]: txnSince, [Op.lt]: dateFrom },
        currency: forecastCurrency,
      };
      if (accountIdFilter !== null) {
        (txnWhere as Record<string, unknown>).accountId = accountIdFilter;
      }
      const txnRows = await Transaction.findAll({
        where: txnWhere,
        attributes: [
          'date',
          'currency',
          'amount',
          'merchantRaw',
          'merchantClean',
          'finalCategory',
          'txnType',
        ],
        raw: true,
      });

      type RawTxnRow = {
        date: string;
        currency: string;
        amount: unknown;
        merchantRaw: string | null;
        merchantClean: string | null;
        finalCategory: string | null;
        txnType: string | null;
      };

      const candidates: RecurringInputTxn[] = [];
      for (const row of txnRows as unknown as RawTxnRow[]) {
        const amount = num(row.amount);
        if (amount == null) continue;
        if (amount >= 0) continue; // charges only — same as /api/recurring
        if (
          classifyPositiveFlow({
            merchantRaw: row.merchantRaw,
            merchantClean: row.merchantClean,
            category: row.finalCategory,
          }) === 'payment'
        ) {
          continue;
        }
        const merchant =
          (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
        if (!merchant) continue;
        candidates.push({
          merchant,
          amount,
          currency: row.currency,
          date: row.date,
          category: row.finalCategory,
        });
      }

      const recurringItems = detectRecurring(candidates, {
        minOccurrences: RECURRING_MIN_OCCURRENCES,
      });

      // Dedupe set of planned-event names (lowercased) so we skip detector
      // hits that the user has already manually planned in this window.
      const plannedNameKeys = new Set(
        plannedRows.map((r) => r.name.trim().toLowerCase()),
      );

      // For each detected item, project occurrences forward using its
      // cadence and avgAmount. The detector emits `nextExpected` and a
      // `cadence` ('monthly'|'weekly') — expand on a true calendar schedule
      // (like the income path below): fixed 30-day steps drift across month
      // boundaries and add a spurious extra charge when the window length is
      // a multiple of 30 (e.g. a 90-day window saw 4 "monthly" charges).
      let recurringIdCounter = 1;
      for (const item of recurringItems) {
        if (plannedNameKeys.has(item.merchant.trim().toLowerCase())) continue;
        const rule = item.cadence === 'weekly' ? 'FREQ=WEEKLY' : 'FREQ=MONTHLY';
        const id = recurringIdCounter++;
        const occs = expandRecurrence(
          {
            id,
            expectedDate: item.nextExpected,
            recurrenceRule: rule,
            status: 'planned',
          },
          dateFrom,
          dateTo,
        );
        for (const occ of occs) {
          allOccurrences.push({
            date: occ.date,
            amount: item.avgAmount,
            direction: 'out',
            sourceType: 'recurring_detection',
            sourceId: id,
            sourceName: item.merchant,
            accountId: null,
          });
        }
      }

      // ----- 5b. Detect & project recurring INCOME ----------------------
      // The detector above only projects charges (money out). Income is
      // identified by an explicit txn_type='income' or a direct-deposit /
      // payroll description — NOT by merchant-blind recurrence, because real
      // payroll is often tagged like an internal transfer and we must not
      // count self-transfers as new money. Detected streams are projected
      // forward at their cadence and deduped against any income planned event
      // the user has already created.
      const incomeCandidates: IncomeInputTxn[] = [];
      for (const row of txnRows as unknown as RawTxnRow[]) {
        const inflow = num(row.amount);
        if (inflow == null || inflow <= 0) continue;
        const merchant =
          (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
        incomeCandidates.push({
          merchant: merchant || null,
          txnType: row.txnType ?? null,
          amount: inflow,
          currency: row.currency,
          date: row.date,
        });
      }

      const incomePlannedKeys = new Set(
        plannedRows
          .filter((r) => r.type === 'income')
          .map((r) => r.name.trim().toLowerCase()),
      );

      for (const item of detectRecurringIncome(incomeCandidates)) {
        if (incomePlannedKeys.has(item.source.trim().toLowerCase())) continue;
        const rule =
          item.cadence === 'weekly'
            ? 'FREQ=WEEKLY'
            : item.cadence === 'biweekly'
              ? 'FREQ=WEEKLY;INTERVAL=2'
              : 'FREQ=MONTHLY';
        const id = recurringIdCounter++;
        const occs = expandRecurrence(
          {
            id,
            expectedDate: item.nextExpected,
            recurrenceRule: rule,
            status: 'planned',
          },
          dateFrom,
          dateTo,
        );
        for (const occ of occs) {
          allOccurrences.push({
            date: occ.date,
            amount: item.avgAmount,
            direction: 'in',
            sourceType: 'recurring_detection',
            sourceId: id,
            sourceName: item.source,
            accountId: null,
          });
        }
      }
    }

    // ----- 6. Build the forecast -----------------------------------------
    const result = buildForecast({
      openingBalance,
      occurrences: allOccurrences,
      dateFrom,
      dateTo,
      currency: forecastCurrency,
    });

    // Sort events by date ASC for stable client rendering.
    const sortedEvents = [...allOccurrences].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );

    res.json({
      currency: forecastCurrency,
      dateFrom,
      dateTo,
      openingBalance: result.openingBalance,
      projectedClosingBalance: result.projectedClosingBalance,
      lowestProjectedBalance: result.lowestProjectedBalance,
      lowestProjectedBalanceDate: result.lowestProjectedBalanceDate,
      dailyPoints: result.dailyPoints,
      events: sortedEvents.map(serializeOccurrence),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/forecast/safe-to-spend — single "how much can I spend without
 * dipping into required funds" number, plus the full breakdown so the UI
 * can render the explanation without a follow-up call.
 *
 * Query parameters:
 *   - currency (3-letter ISO, optional — defaults to the household's
 *     largest cash currency)
 *   - asOfDate (YYYY-MM-DD, optional — defaults to today)
 *
 * Routed off the forecast router because the underlying math reuses the
 * forecast engine (planned events + recurrence expansion) and the UI
 * groups it with other forecast-derived numbers.
 */
router.get('/safe-to-spend', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const asOfDate = req.query.asOfDate
      ? String(req.query.asOfDate)
      : todayIso(household);
    if (!ISO_DATE_RE.test(asOfDate)) {
      res.status(400).json({ error: 'asOfDate must be YYYY-MM-DD' });
      return;
    }

    let currency: string | null = null;
    if (req.query.currency !== undefined && req.query.currency !== '') {
      const raw = String(req.query.currency).trim().toUpperCase();
      if (raw.length !== 3) {
        res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
        return;
      }
      currency = raw;
    }

    const result = await computeSafeToSpend({
      userId: user.id,
      householdId: household.id,
      currency,
      asOfDate,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;

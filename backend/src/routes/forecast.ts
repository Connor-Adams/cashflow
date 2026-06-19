import { Router, type Request } from 'express';
import { Account } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { resolveHouseholdToday, type HasTimezone } from '../time/householdToday';
import {
  buildForecast,
  type ForecastOccurrence,
} from '../forecast/buildForecast';
import { assembleForecast } from '../forecast/assembleForecast';
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

    // ----- 1. Validate accountId scope before assembling -----------------
    // The shared assembler resolves eligible accounts itself, but the route
    // contract is to 404 when a specific accountId resolves to nothing
    // eligible. Do that check up front against the same eligibility rules.
    if (accountIdFilter !== null) {
      const scoped = await Account.findAll({
        where: { ...householdWhere(req), id: accountIdFilter },
      });
      const eligible = scoped.filter((a) => {
        if (FORECAST_EXCLUDED_TYPES.has(a.accountType)) return false;
        if (a.closedAt && a.closedAt <= dateFrom) return false;
        return true;
      });
      if (eligible.length === 0) {
        res
          .status(404)
          .json({ error: 'Account not found or not eligible for forecast' });
        return;
      }
    }

    // ----- 2. Assemble the forecast (shared with goals #653) -------------
    // The occurrence-gathering + opening-balance + recurring-detection
    // pipeline lives in forecast/assembleForecast so the goals projection can
    // derive forecasted free cash from the exact same series.
    const assembled = await assembleForecast({
      householdId: currentAuth(req).household.id,
      dateFrom,
      dateTo,
      currency: currencyFilter,
      accountId: accountIdFilter,
      includeRecurring,
    });
    const forecastCurrency = assembled.currency;
    const allOccurrences = assembled.occurrences;

    // ----- 3. Build the forecast -----------------------------------------
    const result = buildForecast({
      openingBalance: assembled.openingBalance,
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

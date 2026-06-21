/**
 * Shared forecast assembly (issue #653).
 *
 * The GET /api/forecast route (routes/forecast.ts) builds the real cashflow
 * forecast from three sources: planned-event occurrences, detected recurring
 * charges, and detected recurring income — netted over a date window against an
 * opening cash balance. That assembly was previously inline in the route body.
 *
 * Issue #653 needs the SAME assembled occurrences so a goal can be validated
 * against *forecasted free cash* (real net inflow) instead of the goal's
 * self-reported `monthlyContribution`. Rather than duplicate the route body a
 * third time (financialScenarios.ts already carries an older copy — see the
 * follow-up note in that file), this module is the single source of truth: the
 * route is a thin wrapper over `assembleForecast`, and the goals route reuses it
 * to derive monthly free cash.
 *
 * Pure occurrence assembly lives here; `buildForecast` (the daily-series math)
 * is still applied by callers so each can present the result its own way.
 */
import { Op, type WhereOptions } from 'sequelize';

import { PlannedEvent } from '../models/PlannedEvent';
import { Account, Transaction } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
import { expandRecurrence } from './expandRecurrence';
import {
  gatherPlannedOccurrences,
  pickCurrencyByLargestAbsBalance,
} from './gatherOccurrences';
import { type ForecastOccurrence } from './buildForecast';
import { detectRecurringIncome, type IncomeInputTxn } from './detectIncome';
import { detectRecurring, type RecurringInputTxn } from '../routes/recurring';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Match the forecast route: investment accounts are driven by portfolio value,
// not transaction cash-flow, so they're excluded from "money available".
const FORECAST_EXCLUDED_TYPES = new Set(['investment']);

// Recurring detector tuning — only project txns that looked recurring over the
// last 180 days with at least three occurrences. Weaker signals are too noisy.
const RECURRING_LOOKBACK_DAYS = 180;
const RECURRING_MIN_OCCURRENCES = 3;

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Map PlannedEventType → forecast direction. Income flows in; expense,
 * debt_payment and savings flow out; transfer/settlement net out at the
 * household level.
 */
export function directionOfPlannedEvent(
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

export type AssembleForecastParams = {
  householdId: number;
  /** Window start (inclusive), YYYY-MM-DD. */
  dateFrom: string;
  /** Window end (inclusive), YYYY-MM-DD. */
  dateTo: string;
  /**
   * Forecast currency. When omitted, picked as the currency with the largest
   * absolute opening cash balance among eligible accounts (CAD on ties).
   */
  currency?: string | null;
  /** Optional account scope. */
  accountId?: number | null;
  /** Include detected recurring charges + income (default true). */
  includeRecurring?: boolean;
};

export type AssembledForecast = {
  currency: string;
  openingBalance: number;
  occurrences: ForecastOccurrence[];
};

/**
 * Resolve eligible accounts, opening balance and the full occurrence list for a
 * forecast window. This is the canonical assembly previously inline in
 * routes/forecast.ts; both that route and the goals projection consume it.
 */
export async function assembleForecast(
  params: AssembleForecastParams,
): Promise<AssembledForecast> {
  const { householdId, dateFrom, dateTo } = params;
  const accountIdFilter = params.accountId ?? null;
  const includeRecurring = params.includeRecurring ?? true;
  const currencyFilter = params.currency
    ? params.currency.trim().toUpperCase()
    : null;

  // ----- 1. Resolve in-scope accounts ------------------------------------
  const accountWhere: WhereOptions = { householdId };
  if (accountIdFilter !== null) {
    (accountWhere as Record<string, unknown>).id = accountIdFilter;
  }
  const allAccounts = await Account.findAll({ where: accountWhere });
  const eligible = allAccounts.filter((a) => {
    if (FORECAST_EXCLUDED_TYPES.has(a.accountType)) return false;
    if (a.closedAt && a.closedAt <= dateFrom) return false;
    return true;
  });

  // ----- 2. Opening balance per currency ---------------------------------
  const summed = new Map<string, number>();
  for (const acc of eligible) {
    const balances = await balanceAtDate(acc, dateFrom);
    for (const { currency, amount } of balances) {
      summed.set(currency, (summed.get(currency) ?? 0) + amount);
    }
  }

  let forecastCurrency = currencyFilter ?? 'CAD';
  if (currencyFilter === null) {
    const picked = pickCurrencyByLargestAbsBalance(summed);
    if (picked) forecastCurrency = picked;
  }
  const openingBalance = summed.get(forecastCurrency) ?? 0;

  // ----- 3. PlannedEvent occurrences -------------------------------------
  const plannedOccurrences = await gatherPlannedOccurrences({
    householdId,
    currency: forecastCurrency,
    from: dateFrom,
    to: dateTo,
    accountId: accountIdFilter,
  });

  const plannedRows = [
    ...new Map(plannedOccurrences.map((o) => [o.row.id, o.row])).values(),
  ];

  const allOccurrences: ForecastOccurrence[] = [];
  for (const { date, row } of plannedOccurrences) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    allOccurrences.push({
      date,
      amount,
      direction: directionOfPlannedEvent(row.type),
      sourceType: 'planned_event',
      sourceId: row.id,
      sourceName: row.name,
      accountId: row.accountId,
    });
  }

  // ----- 4. Detected recurring charges + income --------------------------
  if (includeRecurring) {
    const txnSince = addDaysIso(dateFrom, -RECURRING_LOOKBACK_DAYS);
    const txnWhere: WhereOptions = {
      householdId,
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

    const plannedNameKeys = new Set(
      plannedRows.map((r) => r.name.trim().toLowerCase()),
    );

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

    // Recurring income.
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

  return {
    currency: forecastCurrency,
    openingBalance,
    occurrences: allOccurrences,
  };
}

/**
 * Net free cash per month implied by a forecast's occurrences (issue #653).
 *
 * "Free cash" = total net inflow (in minus out, ignoring neutral transfers)
 * over the window, normalized to a per-month figure by dividing by the number
 * of (fractional) months the window spans. This is the real "money available
 * to fund goals" that replaces the self-reported monthlyContribution.
 *
 * Pure: takes the assembled occurrences + window so it's unit-testable without
 * a DB. Returns a JS number (may be negative).
 */
const DAYS_PER_MONTH = 30.4375; // mean Gregorian month length

export function monthlyFreeCashFromOccurrences(
  occurrences: ForecastOccurrence[],
  dateFrom: string,
  dateTo: string,
): number {
  let netUnits = 0;
  for (const occ of occurrences) {
    if (occ.direction === 'neutral') continue;
    if (occ.date < dateFrom || occ.date > dateTo) continue;
    const amount = Number(occ.amount);
    if (!Number.isFinite(amount)) continue;
    const units = Math.round(amount * 10000);
    netUnits += occ.direction === 'in' ? units : -units;
  }
  const net = netUnits / 10000;

  // Window length in days, inclusive of both endpoints (a single-day window is
  // 1 day, not 0). Floor the month divisor at one month so a sub-month window
  // doesn't inflate the monthly figure.
  const [fy, fm, fd] = dateFrom.split('-').map((p) => parseInt(p, 10));
  const [ty, tm, td] = dateTo.split('-').map((p) => parseInt(p, 10));
  const days =
    Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY) + 1;
  const months = Math.max(1, days / DAYS_PER_MONTH);
  return net / months;
}

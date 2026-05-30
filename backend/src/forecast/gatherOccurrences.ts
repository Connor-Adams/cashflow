/**
 * Shared forecast-occurrence assembly (extracted from routes/forecast.ts so
 * the scenario planner — issue #213 — can build the same base series the
 * /api/forecast endpoint does without duplicating the logic or coupling to
 * the HTTP handler).
 *
 * Given a request (for household scope) and a resolved date window, this
 * resolves eligible cash accounts, computes the opening balance per the
 * chosen currency, expands planned events, and optionally folds in detected
 * recurring charges — returning the inputs `buildForecast` consumes.
 */
import { Op, type WhereOptions } from 'sequelize';
import { type Request } from 'express';
import { PlannedEvent } from '../models/PlannedEvent';
import { Account, Transaction } from '../models';
import { householdWhere } from '../auth/scope';
import { expandRecurrence, type PlannedEventLike } from './expandRecurrence';
import { type ForecastOccurrence } from './buildForecast';
import { detectRecurring, type RecurringInputTxn } from '../routes/recurring';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';

// Investment accounts are driven by portfolio value, not cash-flow.
const FORECAST_EXCLUDED_TYPES = new Set(['investment']);

const RECURRING_LOOKBACK_DAYS = 180;
const RECURRING_MIN_OCCURRENCES = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Map PlannedEventType → forecast direction. Income flows in; expense and
 * debt_payment and savings flow out; transfer and settlement net to zero.
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

export type GatherOccurrencesOptions = {
  dateFrom: string;
  dateTo: string;
  /** When null, the currency with the largest absolute balance is chosen. */
  currency: string | null;
  accountId: number | null;
  includeRecurring: boolean;
  balanceAtDate: (
    account: InstanceType<typeof Account>,
    asOf: string,
  ) => Promise<Array<{ currency: string; amount: number }>>;
};

export type GatheredForecastInputs = {
  currency: string;
  openingBalance: number;
  occurrences: ForecastOccurrence[];
  /** True only when an accountId filter was supplied but matched no eligible account. */
  accountNotFound: boolean;
};

/**
 * Resolve opening balance + occurrences for the forecast / scenario engines.
 * `balanceAtDate` is injected to keep this module decoupled from the net-worth
 * package's exact import shape and to make targeted testing easier.
 */
export async function gatherForecastInputs(
  req: Request,
  opts: GatherOccurrencesOptions,
): Promise<GatheredForecastInputs> {
  const { dateFrom, dateTo, accountId: accountIdFilter, includeRecurring } = opts;

  // ----- 1. Resolve in-scope accounts -----------------------------------
  const accountWhere: WhereOptions = { ...householdWhere(req) };
  if (accountIdFilter !== null) {
    (accountWhere as Record<string, unknown>).id = accountIdFilter;
  }
  const allAccounts = await Account.findAll({ where: accountWhere });

  const eligible = allAccounts.filter((a) => {
    if (FORECAST_EXCLUDED_TYPES.has(a.accountType)) return false;
    if (a.closedAt && a.closedAt <= dateFrom) return false;
    return true;
  });

  if (accountIdFilter !== null && eligible.length === 0) {
    return { currency: opts.currency ?? 'CAD', openingBalance: 0, occurrences: [], accountNotFound: true };
  }

  // ----- 2/3. Opening balance per currency -------------------------------
  let forecastCurrency = opts.currency ?? 'CAD';
  const summed = new Map<string, number>();
  for (const acc of eligible) {
    const balances = await opts.balanceAtDate(acc, dateFrom);
    for (const { currency, amount } of balances) {
      summed.set(currency, (summed.get(currency) ?? 0) + amount);
    }
  }

  if (opts.currency === null) {
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

  // ----- 4. Planned events in the window (currency-matched) --------------
  const eventWhere: WhereOptions = {
    ...householdWhere(req),
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

  const occurrences: ForecastOccurrence[] = [];
  for (const row of plannedRows) {
    const eventLike: PlannedEventLike = {
      id: row.id,
      expectedDate: row.expectedDate,
      recurrenceRule: row.recurrenceRule,
      status: row.status,
    };
    const occs = expandRecurrence(eventLike, dateFrom, dateTo);
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const direction = directionOfPlannedEvent(row.type);
    for (const occ of occs) {
      occurrences.push({
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

  // ----- 5. Optionally include detected recurring charges ----------------
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
      attributes: ['date', 'currency', 'amount', 'merchantRaw', 'merchantClean', 'finalCategory'],
      raw: true,
    });

    type RawTxnRow = {
      date: string;
      currency: string;
      amount: unknown;
      merchantRaw: string | null;
      merchantClean: string | null;
      finalCategory: string | null;
    };

    const candidates: RecurringInputTxn[] = [];
    for (const row of txnRows as unknown as RawTxnRow[]) {
      const amount = num(row.amount);
      if (amount == null) continue;
      if (amount >= 0) continue;
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

    const recurringItems = detectRecurring(candidates, {
      minOccurrences: RECURRING_MIN_OCCURRENCES,
    });

    const plannedNameKeys = new Set(plannedRows.map((r) => r.name.trim().toLowerCase()));

    let recurringIdCounter = 1;
    for (const item of recurringItems) {
      if (plannedNameKeys.has(item.merchant.trim().toLowerCase())) continue;
      const stepDays = item.cadence === 'weekly' ? 7 : 30;
      let cursor = item.nextExpected;
      while (cursor < dateFrom) cursor = addDaysIso(cursor, stepDays);
      const id = recurringIdCounter++;
      while (cursor <= dateTo) {
        occurrences.push({
          date: cursor,
          amount: item.avgAmount,
          direction: 'out',
          sourceType: 'recurring_detection',
          sourceId: id,
          sourceName: item.merchant,
          accountId: null,
        });
        cursor = addDaysIso(cursor, stepDays);
      }
    }
  }

  return { currency: forecastCurrency, openingBalance, occurrences, accountNotFound: false };
}

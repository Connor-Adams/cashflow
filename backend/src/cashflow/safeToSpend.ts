/**
 * Safe-to-spend calculation (issue #199).
 *
 * Formula (single currency, household-scoped):
 *
 *   safe_to_spend =
 *     current_available_cash
 *     - upcoming_required_expenses        (planned-event outflows in the window)
 *     - required_savings_contributions    (sum of FinancialGoal required monthly)
 *     - expected_credit_card_payments     (sum of CC balances, sign-flipped)
 *     - minimum_buffer                    (user-configured floor)
 *
 * The math is split between a pure `composeSafeToSpend` (so tests can hit it
 * without a DB) and a thin orchestrator `computeSafeToSpend` that pulls the
 * inputs. Result always returns the full breakdown — the UI shows it on
 * click and we want clients to render without a follow-up request.
 */
import { Op } from 'sequelize';
import { Account, Entity, FinancialGoal, CashflowSettings } from '../models';
import { CASHFLOW_SETTINGS_DEFAULTS } from '../models/CashflowSettings';
import { balanceAtDate } from '../networth/balanceAtDate';
import { loadLiabilities, toDebtInputs } from '../debt/loadLiabilities';
import {
  composeSurplus,
  selectTopGoal,
  DEFAULT_ASSUMED_ANNUAL_RETURN_RATE,
  DEFAULT_SURPLUS_HORIZON_YEARS,
  type Surplus,
} from './surplus';
import {
  gatherPlannedOccurrences,
  resolveForecastCurrency,
} from '../forecast/gatherOccurrences';
import { projectGoal } from '../goals/projection';
import {
  detectRecurringIncome,
  projectRecurringIncome,
  type IncomeTxn,
} from './recurringIncome';
import { toUnits, fromUnits } from '../util/numbers';

/** History window scanned for recurring-income detection. */
const INCOME_LOOKBACK_DAYS = 180;

/** Transaction types that are positive but never count as recurring income. */
const INCOME_EXCLUDED_TXN_TYPES = new Set([
  'transfer',
  'payment',
  'refund',
  'reward',
  'investment',
  'dividend',
]);

/** Cash-bearing account types — match the forecast engine's exclusion list. */
const CASH_EXCLUDED_TYPES = new Set(['investment', 'credit_card', 'loan']);

/** Credit-card account types — used to size the expected-payments deduction. */
const CREDIT_CARD_TYPES = new Set(['credit_card']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Safe-to-spend is a PERSONAL liquidity figure: corporate-entity accounts hold
 * business money the user can't personally spend. Returns the set of `corp`-kind
 * tax-entity ids for the household so the cash/CC/currency steps can drop any
 * account tagged to one. Accounts with a null `entityId` are treated as personal
 * (the Account create-hook defaults new accounts to the personal entity).
 */
export async function getCorpEntityIds(
  householdId: number,
): Promise<Set<number>> {
  const corps = await Entity.findAll({
    where: { householdId, kind: 'corp' },
    attributes: ['id'],
  });
  return new Set(corps.map((e) => e.id));
}

/** True when an account belongs to a corporate tax entity (so: not personal). */
function isCorpAccount(
  account: Account,
  corpEntityIds: ReadonlySet<number>,
): boolean {
  return account.entityId != null && corpEntityIds.has(account.entityId);
}

export type SafeToSpendBreakdown = {
  currentCash: number;
  /** Recurring income projected to land inside the window — added back. */
  expectedIncome: number;
  upcomingRequiredExpenses: number;
  requiredSavingsContributions: number;
  expectedCreditCardPayments: number;
  minimumBuffer: number;
};

export type SafeToSpendResult = {
  currency: string;
  asOfDate: string;
  windowDays: number;
  windowEndDate: string;
  /** Final number (currentCash minus all deductions). May be negative. */
  value: number;
  /** True when value < 0 — convenience flag for the UI warning state. */
  isNegative: boolean;
  breakdown: SafeToSpendBreakdown;
  /** Mirror of the booleans applied to this calculation. */
  settings: {
    minimumCashBuffer: string;
    safeToSpendWindowDays: number;
    includeCreditCardBalance: boolean;
    includeGoalContributions: boolean;
  };
};

export type SafeToSpendSettingsLike = {
  minimumCashBuffer: string;
  safeToSpendWindowDays: number;
  includeCreditCardBalance: boolean;
  includeGoalContributions: boolean;
};

/**
 * Pure composer — no DB. Takes already-collected inputs, applies the
 * include-* toggles, sums, and rounds. Exported so unit tests can exercise
 * the math without touching sequelize.
 */
export function composeSafeToSpend(input: {
  currency: string;
  asOfDate: string;
  windowDays: number;
  windowEndDate: string;
  currentCash: number;
  expectedIncome?: number;
  upcomingRequiredExpenses: number;
  requiredSavingsContributions: number;
  expectedCreditCardPayments: number;
  minimumBuffer: number;
  settings: SafeToSpendSettingsLike;
}): SafeToSpendResult {
  const goalContrib = input.settings.includeGoalContributions
    ? input.requiredSavingsContributions
    : 0;
  const ccPayments = input.settings.includeCreditCardBalance
    ? input.expectedCreditCardPayments
    : 0;
  const expectedIncome =
    Number.isFinite(input.expectedIncome) && input.expectedIncome! > 0
      ? input.expectedIncome!
      : 0;

  const value = round2(
    input.currentCash +
      expectedIncome -
      input.upcomingRequiredExpenses -
      goalContrib -
      ccPayments -
      input.minimumBuffer,
  );

  return {
    currency: input.currency,
    asOfDate: input.asOfDate,
    windowDays: input.windowDays,
    windowEndDate: input.windowEndDate,
    value,
    isNegative: value < 0,
    breakdown: {
      currentCash: round2(input.currentCash),
      expectedIncome: round2(expectedIncome),
      upcomingRequiredExpenses: round2(input.upcomingRequiredExpenses),
      requiredSavingsContributions: round2(goalContrib),
      expectedCreditCardPayments: round2(ccPayments),
      minimumBuffer: round2(input.minimumBuffer),
    },
    settings: { ...input.settings },
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Nominal days per month used to prorate monthly amounts to the window. */
const DAYS_PER_MONTH = 30;

/**
 * Prorate a per-MONTH amount down to the safe-to-spend window. A 14-day
 * window reserves ~14/30 of the monthly figure, matching how upcoming
 * expenses only reflect their in-window occurrences — otherwise a short
 * window would still subtract a full month of goal contributions and
 * understate safe-to-spend. Exported for unit coverage. Non-positive
 * windows clamp to 0.
 */
export function proRateMonthlyToWindow(
  monthlyAmount: number,
  windowDays: number,
): number {
  if (!Number.isFinite(monthlyAmount) || !Number.isFinite(windowDays)) return 0;
  if (windowDays <= 0) return 0;
  return (monthlyAmount * windowDays) / DAYS_PER_MONTH;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolve which currency to compute against when the caller omits one.
 * Picks the currency with the largest absolute cash balance across the
 * household's eligible (non-investment, non-credit-card, non-loan) accounts.
 * Falls back to CAD when the household has no cash on hand yet.
 *
 * Delegates the largest-abs/CAD-tiebreak algorithm to the shared
 * `resolveForecastCurrency` (#404); the only safe-to-spend-specific input is
 * the cash exclusion set, which is wider than the forecast route's.
 */
export async function resolveDefaultCurrency(
  householdId: number,
  asOfDate: string,
): Promise<string> {
  const corpEntityIds = await getCorpEntityIds(householdId);
  return resolveForecastCurrency(
    householdId,
    asOfDate,
    CASH_EXCLUDED_TYPES,
    corpEntityIds,
  );
}

/**
 * Compute current cash for the given currency. Sums `balanceAtDate` over
 * the household's non-investment, non-credit-card accounts, filtered to
 * the requested currency.
 */
export async function getCurrentCash(
  householdId: number,
  currency: string,
  asOfDate: string,
  corpEntityIds: ReadonlySet<number> = new Set(),
): Promise<number> {
  const accounts = await Account.findAll({ where: { householdId } });
  let totalU = 0;
  for (const acc of accounts) {
    if (CASH_EXCLUDED_TYPES.has(acc.accountType)) continue;
    if (isCorpAccount(acc, corpEntityIds)) continue;
    if (acc.closedAt && acc.closedAt <= asOfDate) continue;
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency: ccy, amount } of bal) {
      if (ccy === currency) totalU += toUnits(amount);
    }
  }
  return fromUnits(totalU);
}

/**
 * Project recurring income (paychecks) expected to land inside
 * [asOfDate, windowEndDate], in the requested currency. Scans the last
 * `INCOME_LOOKBACK_DAYS` of personal cash-account inflows, detects
 * high-confidence recurring streams (see `recurringIncome.ts`), and sums the
 * occurrences that fall in the window. Corporate-entity accounts, non-income
 * positive types (transfers, refunds, card payments…), and other currencies
 * are excluded. Detection is conservative on purpose — over-counting income
 * would tell the user they can spend money they don't have.
 */
export async function getExpectedIncome(
  householdId: number,
  currency: string,
  asOfDate: string,
  windowEndDate: string,
  corpEntityIds: ReadonlySet<number> = new Set(),
): Promise<number> {
  const accounts = await Account.findAll({ where: { householdId } });
  const eligible = accounts.filter(
    (acc) =>
      !CASH_EXCLUDED_TYPES.has(acc.accountType) &&
      !isCorpAccount(acc, corpEntityIds) &&
      !(acc.closedAt && acc.closedAt <= asOfDate),
  );
  if (eligible.length === 0) return 0;

  const fromDate = addDaysIso(asOfDate, -INCOME_LOOKBACK_DAYS);
  const { Transaction } = await import('../models');
  const rows = await Transaction.findAll({
    where: {
      accountId: { [Op.in]: eligible.map((a) => a.id) },
      currency,
      date: { [Op.gt]: fromDate, [Op.lte]: asOfDate },
    },
    attributes: ['date', 'amount', 'txnType', 'merchantClean', 'merchantRaw'],
  });

  const txns: IncomeTxn[] = [];
  for (const r of rows) {
    const amount = Number(r.amount);
    if (!(amount > 0)) continue;
    if (r.txnType && INCOME_EXCLUDED_TXN_TYPES.has(r.txnType)) continue;
    const merchant = (r.merchantClean || r.merchantRaw || '').trim();
    if (!merchant) continue;
    txns.push({ date: r.date, amount, merchant });
  }

  const streams = detectRecurringIncome(txns, asOfDate);
  return projectRecurringIncome(streams, asOfDate, windowEndDate);
}

/**
 * Sum required expense planned-events (type=expense) inside
 * [asOfDate, windowEndDate], in the requested currency, scoped to the
 * household. `debt_payment` is handled separately by the credit-card branch
 * (`expectedCreditCardPayments`) so we don't double-count.
 *
 * Both ordinary planned events and subscription-kind expectations count.
 * Subscriptions carry a `cadence` + `nextExpectedDate` instead of a
 * recurrenceRule, so we synthesize a rule for them — mirrors the forecast
 * route (routes/forecast.ts), which fixed the same exclusion for the chart.
 *
 * The amount of each row is multiplied by the number of occurrences that
 * fall inside the window (per `expandRecurrence`) — a weekly subscription
 * within a 30-day window contributes ~4x its single-row amount.
 */
export async function getUpcomingRequiredExpenses(
  householdId: number,
  currency: string,
  asOfDate: string,
  windowEndDate: string,
): Promise<number> {
  // Shared occurrence pipeline (#404): the PlannedEvent query +
  // subscription-RRULE synth + expandRecurrence loop lives in one place.
  // Each expense row contributes amount × (its in-window occurrence count).
  const occurrences = await gatherPlannedOccurrences({
    householdId,
    currency,
    from: asOfDate,
    to: windowEndDate,
    typeFilter: 'expense',
  });
  let totalU = 0;
  for (const { row } of occurrences) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    totalU += toUnits(amount);
  }
  return fromUnits(totalU);
}

/**
 * Sum required monthly contributions from active financial goals in the
 * requested currency. For each goal we run `projectGoal` to derive
 * `requiredMonthlyContribution`, then fall back to the user-declared
 * `monthlyContribution` if the projection didn't compute one (e.g. no
 * targetDate). Goals without either are skipped — they're treated as
 * passive savings, not forced expenses.
 *
 * The summed monthly figure is prorated to `windowDays` so it lines up with
 * the window-scoped upcoming-expenses total — a 14-day window only reserves
 * ~14/30 of a month of contributions, not a whole month.
 */
export async function getRequiredSavingsContributions(
  householdId: number,
  currency: string,
  asOfDate: string,
  windowDays: number,
): Promise<number> {
  const rows = await FinancialGoal.findAll({
    where: { householdId, status: 'active', currency },
  });
  let totalU = 0;
  for (const row of rows) {
    const projection = projectGoal({
      targetAmount: String(row.targetAmount),
      currentAmount: String(row.currentAmount),
      targetDate: row.targetDate,
      monthlyContribution:
        row.monthlyContribution == null ? null : String(row.monthlyContribution),
      today: asOfDate,
    });
    const required = projection.requiredMonthlyContribution;
    if (required != null) {
      totalU += toUnits(Number(required));
      continue;
    }
    // No projection (no targetDate). Fall back to the user-declared
    // monthly contribution as the floor.
    if (row.monthlyContribution != null) {
      const n = Number(row.monthlyContribution);
      if (Number.isFinite(n) && n > 0) totalU += toUnits(n);
    }
  }
  return proRateMonthlyToWindow(fromUnits(totalU), windowDays);
}

/**
 * Sum credit-card balances (in the requested currency) as expected
 * payments. Credit-card account balances live as negative transaction
 * totals (charges) with positive payments — net negative balance means the
 * user owes that much. We sign-flip the negative running balance into a
 * positive "expected payment" amount; positive balances (credit on the
 * card) contribute 0 — we don't want to encourage spending the card credit.
 */
export async function getExpectedCreditCardPayments(
  householdId: number,
  currency: string,
  asOfDate: string,
  corpEntityIds: ReadonlySet<number> = new Set(),
): Promise<number> {
  const accounts = await Account.findAll({ where: { householdId } });
  let totalU = 0;
  for (const acc of accounts) {
    if (!CREDIT_CARD_TYPES.has(acc.accountType)) continue;
    if (isCorpAccount(acc, corpEntityIds)) continue;
    if (acc.closedAt && acc.closedAt <= asOfDate) continue;
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency: ccy, amount } of bal) {
      if (ccy !== currency) continue;
      if (amount < 0) totalU += toUnits(-amount);
    }
  }
  return fromUnits(totalU);
}

/** Lazy-load (or default) the user's settings row. */
export async function loadSettingsOrDefaults(
  userId: number,
): Promise<SafeToSpendSettingsLike> {
  const row = await CashflowSettings.findOne({ where: { userId } });
  if (!row) return { ...CASHFLOW_SETTINGS_DEFAULTS };
  return {
    minimumCashBuffer: String(row.minimumCashBuffer),
    safeToSpendWindowDays: row.safeToSpendWindowDays,
    includeCreditCardBalance: row.includeCreditCardBalance,
    includeGoalContributions: row.includeGoalContributions,
  };
}

/**
 * Top-level orchestrator. Pulls inputs from the DB and feeds them into
 * `composeSafeToSpend`. Currency may be omitted — `resolveDefaultCurrency`
 * picks the household's largest cash currency.
 */
export async function computeSafeToSpend(params: {
  userId: number;
  householdId: number;
  currency?: string | null;
  asOfDate: string;
}): Promise<SafeToSpendResult> {
  const settings = await loadSettingsOrDefaults(params.userId);

  const currency =
    params.currency ??
    (await resolveDefaultCurrency(params.householdId, params.asOfDate));

  const windowDays = settings.safeToSpendWindowDays;
  const windowEndDate = addDaysIso(params.asOfDate, windowDays);

  // Safe-to-spend is personal liquidity: drop corporate-entity accounts from
  // the cash + credit-card legs. Computed once and shared across both.
  const corpEntityIds = await getCorpEntityIds(params.householdId);

  const [
    currentCash,
    expectedIncome,
    upcomingRequiredExpenses,
    requiredSavingsContributions,
    expectedCreditCardPayments,
  ] = await Promise.all([
    getCurrentCash(params.householdId, currency, params.asOfDate, corpEntityIds),
    getExpectedIncome(
      params.householdId,
      currency,
      params.asOfDate,
      windowEndDate,
      corpEntityIds,
    ),
    getUpcomingRequiredExpenses(
      params.householdId,
      currency,
      params.asOfDate,
      windowEndDate,
    ),
    getRequiredSavingsContributions(
      params.householdId,
      currency,
      params.asOfDate,
      windowDays,
    ),
    getExpectedCreditCardPayments(
      params.householdId,
      currency,
      params.asOfDate,
      corpEntityIds,
    ),
  ]);

  return composeSafeToSpend({
    currency,
    asOfDate: params.asOfDate,
    windowDays,
    windowEndDate,
    currentCash,
    expectedIncome,
    upcomingRequiredExpenses,
    requiredSavingsContributions,
    expectedCreditCardPayments,
    minimumBuffer: Number(settings.minimumCashBuffer),
    settings,
  });
}

/**
 * Read the user's assumed annual return rate (#654), falling back to the
 * default when no settings row exists or the value is non-finite/out-of-range.
 * Returned as a decimal (0.05 == 5%).
 */
export async function loadAssumedAnnualReturnRate(
  userId: number,
): Promise<number> {
  const row = await CashflowSettings.findOne({ where: { userId } });
  const raw =
    row != null
      ? Number(row.assumedAnnualReturnRate)
      : Number(CASHFLOW_SETTINGS_DEFAULTS.assumedAnnualReturnRate);
  if (!Number.isFinite(raw)) return DEFAULT_ASSUMED_ANNUAL_RETURN_RATE;
  return raw;
}

/**
 * Surplus decision hub (#654). Given an already-computed safe-to-spend result,
 * derive the investable surplus, the top active goal in the same currency, and
 * the payoff-vs-invest comparison against the household's in-currency debts.
 *
 * DB-aware orchestrator: loads goals + liabilities + the assumed-return setting,
 * then defers to the pure `composeSurplus`. Records nothing and moves no money.
 */
export async function computeSurplus(params: {
  userId: number;
  householdId: number;
  asOfDate: string;
  result: SafeToSpendResult;
}): Promise<Surplus> {
  const currency = params.result.currency;

  const [goals, liabilities, assumedAnnualReturnRate] = await Promise.all([
    FinancialGoal.findAll({
      where: { householdId: params.householdId, status: 'active', currency },
    }),
    loadLiabilities(params.householdId, params.asOfDate),
    loadAssumedAnnualReturnRate(params.userId),
  ]);

  const topGoal = selectTopGoal(
    goals.map((g) => ({
      id: g.id,
      name: g.name,
      currency: g.currency,
      priority: g.priority,
      targetDate: g.targetDate,
    })),
  );

  // Scope debts to the surplus currency — other currencies don't contribute.
  const debts = toDebtInputs(liabilities.filter((l) => l.currency === currency));

  return composeSurplus({
    safeToSpendValue: params.result.value,
    buffer: params.result.breakdown.minimumBuffer,
    currency,
    topGoal,
    debts,
    assumedAnnualReturnRate,
    horizonYears: DEFAULT_SURPLUS_HORIZON_YEARS,
  });
}

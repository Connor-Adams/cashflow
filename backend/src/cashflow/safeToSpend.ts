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
import { Op, type WhereOptions } from 'sequelize';

import { Account, FinancialGoal, CashflowSettings } from '../models';
import { CASHFLOW_SETTINGS_DEFAULTS } from '../models/CashflowSettings';
import { PlannedEvent } from '../models/PlannedEvent';
import { balanceAtDate } from '../networth/balanceAtDate';
import {
  expandRecurrence,
  type PlannedEventLike,
} from '../forecast/expandRecurrence';
import { projectGoal } from '../goals/projection';

/** Cash-bearing account types — match the forecast engine's exclusion list. */
const CASH_EXCLUDED_TYPES = new Set(['investment', 'credit_card']);

/** Credit-card account types — used to size the expected-payments deduction. */
const CREDIT_CARD_TYPES = new Set(['credit_card']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SafeToSpendBreakdown = {
  currentCash: number;
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

  const value = round2(
    input.currentCash -
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

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolve which currency to compute against when the caller omits one.
 * Picks the currency with the largest absolute cash balance across the
 * household's eligible (non-investment, non-credit-card) accounts. Falls
 * back to CAD when the household has no cash on hand yet.
 */
export async function resolveDefaultCurrency(
  householdId: number,
  asOfDate: string,
): Promise<string> {
  const accounts = await Account.findAll({ where: { householdId } });
  const eligible = accounts.filter((a) => {
    if (CASH_EXCLUDED_TYPES.has(a.accountType)) return false;
    if (a.closedAt && a.closedAt <= asOfDate) return false;
    return true;
  });
  const totals = new Map<string, number>();
  for (const acc of eligible) {
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency, amount } of bal) {
      totals.set(currency, (totals.get(currency) ?? 0) + amount);
    }
  }
  let best: { currency: string; absAmount: number } | null = null;
  for (const [ccy, amt] of totals) {
    const abs = Math.abs(amt);
    // Prefer CAD on ties — Cashflow's primary currency.
    if (
      !best ||
      abs > best.absAmount ||
      (ccy === 'CAD' && abs === best.absAmount)
    ) {
      best = { currency: ccy, absAmount: abs };
    }
  }
  return best?.currency ?? 'CAD';
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
): Promise<number> {
  const accounts = await Account.findAll({ where: { householdId } });
  let total = 0;
  for (const acc of accounts) {
    if (CASH_EXCLUDED_TYPES.has(acc.accountType)) continue;
    if (acc.closedAt && acc.closedAt <= asOfDate) continue;
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency: ccy, amount } of bal) {
      if (ccy === currency) total += amount;
    }
  }
  return total;
}

/**
 * Sum required expense planned-events (type=expense) inside
 * [asOfDate, windowEndDate], in the requested currency, scoped to the
 * household. `debt_payment` is handled separately by the credit-card branch
 * (`expectedCreditCardPayments`) so we don't double-count.
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
  const where: WhereOptions = {
    householdId,
    currency,
    status: 'planned',
    expectedDate: { [Op.lte]: windowEndDate },
    type: 'expense',
  };
  const rows = await PlannedEvent.findAll({ where });
  let total = 0;
  for (const row of rows) {
    const eventLike: PlannedEventLike = {
      id: row.id,
      expectedDate: row.expectedDate,
      recurrenceRule: row.recurrenceRule,
      status: row.status,
    };
    const occs = expandRecurrence(eventLike, asOfDate, windowEndDate);
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    total += amount * occs.length;
  }
  return total;
}

/**
 * Sum required monthly contributions from active financial goals in the
 * requested currency. For each goal we run `projectGoal` to derive
 * `requiredMonthlyContribution`, then fall back to the user-declared
 * `monthlyContribution` if the projection didn't compute one (e.g. no
 * targetDate). Goals without either are skipped — they're treated as
 * passive savings, not forced expenses.
 */
export async function getRequiredSavingsContributions(
  householdId: number,
  currency: string,
  asOfDate: string,
): Promise<number> {
  const rows = await FinancialGoal.findAll({
    where: { householdId, status: 'active', currency },
  });
  let total = 0;
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
      total += Number(required);
      continue;
    }
    // No projection (no targetDate). Fall back to the user-declared
    // monthly contribution as the floor.
    if (row.monthlyContribution != null) {
      const n = Number(row.monthlyContribution);
      if (Number.isFinite(n) && n > 0) total += n;
    }
  }
  return total;
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
): Promise<number> {
  const accounts = await Account.findAll({ where: { householdId } });
  let total = 0;
  for (const acc of accounts) {
    if (!CREDIT_CARD_TYPES.has(acc.accountType)) continue;
    if (acc.closedAt && acc.closedAt <= asOfDate) continue;
    const bal = await balanceAtDate(acc, asOfDate);
    for (const { currency: ccy, amount } of bal) {
      if (ccy !== currency) continue;
      if (amount < 0) total += -amount;
    }
  }
  return total;
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

  const [
    currentCash,
    upcomingRequiredExpenses,
    requiredSavingsContributions,
    expectedCreditCardPayments,
  ] = await Promise.all([
    getCurrentCash(params.householdId, currency, params.asOfDate),
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
    ),
    getExpectedCreditCardPayments(
      params.householdId,
      currency,
      params.asOfDate,
    ),
  ]);

  return composeSafeToSpend({
    currency,
    asOfDate: params.asOfDate,
    windowDays,
    windowEndDate,
    currentCash,
    upcomingRequiredExpenses,
    requiredSavingsContributions,
    expectedCreditCardPayments,
    minimumBuffer: Number(settings.minimumCashBuffer),
    settings,
  });
}

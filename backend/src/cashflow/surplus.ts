/**
 * Safe-to-spend surplus decision hub (issue #654).
 *
 * Safe-to-spend (`safeToSpend.ts`) is already net of the configured
 * `minimumCashBuffer`, so anything `value >= 0` is genuinely spendable beyond
 * that floor. This module turns that final number into an *actionable*
 * surplus: how much is investable, the top goal it could accelerate, and a
 * static "pay down debt vs. invest it" comparison. It records nothing and
 * moves no money — it advises; the user acts elsewhere.
 *
 * Everything here is pure (no DB, no I/O) so the math is unit-testable in
 * isolation. The route (`routes/forecast.ts`) collects the goal + debt inputs
 * from the DB and feeds them in.
 */
import {
  computeOpportunityCost,
  MIN_ANNUAL_RETURN_RATE,
  MAX_ANNUAL_RETURN_RATE,
} from './opportunityCost';
import { comparePayoff, type PayoffDebtInput } from '../debt/payoffPlan';

/** Default assumed annual return when no `assumedAnnualReturnRate` is set. */
export const DEFAULT_ASSUMED_ANNUAL_RETURN_RATE = 0.05;
/** Default invest horizon for the payoff-vs-invest comparison, in years. */
export const DEFAULT_SURPLUS_HORIZON_YEARS = 10;

export type SurplusTopGoal = {
  id: number;
  name: string;
  currency: string;
};

export type SurplusRecommendation = 'payoff' | 'invest' | 'tie';

export type SurplusPayoffVsInvest = {
  /** Interest avoided by throwing the surplus at debt (from comparePayoff). */
  interestSaved: number;
  /** Growth from investing the surplus one-time over the horizon. */
  investGain: number;
  assumedAnnualReturnRate: number;
  horizonYears: number;
  recommendation: SurplusRecommendation;
};

export type Surplus = {
  /** max(0, safeToSpend.value). */
  amount: number;
  /** The buffer already deducted from safe-to-spend (breakdown.minimumBuffer). */
  buffer: number;
  topGoal: SurplusTopGoal | null;
  payoffVsInvest: SurplusPayoffVsInvest | null;
};

export type ComposeSurplusInput = {
  /** Final safe-to-spend number (already net of the buffer). May be negative. */
  safeToSpendValue: number;
  /** The minimum-buffer line from the safe-to-spend breakdown. */
  buffer: number;
  /** Currency the surplus, goal, and debts are all scoped to. */
  currency: string;
  /** Top active goal in `currency`, already selected by the caller, or null. */
  topGoal: SurplusTopGoal | null;
  /** Debts in `currency` (owed > 0), already filtered by the caller. */
  debts: PayoffDebtInput[];
  /** Assumed annual return as a decimal (0.05 == 5%). */
  assumedAnnualReturnRate: number;
  /** Invest horizon in years. */
  horizonYears: number;
};

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Pure composer for the surplus block. No DB. Given the safe-to-spend value,
 * the buffer, the pre-selected top goal, and the in-currency debts, produce
 * the surplus amount and (when applicable) the payoff-vs-invest comparison.
 */
export function composeSurplus(input: ComposeSurplusInput): Surplus {
  const amount = round2(Math.max(0, input.safeToSpendValue));
  const buffer = round2(input.buffer);

  let payoffVsInvest: SurplusPayoffVsInvest | null = null;
  // Only meaningful when there's actually surplus to deploy AND debt to weigh
  // it against. No surplus → nothing to compare; no debt → no payoff side.
  if (amount > 0 && input.debts.length > 0) {
    const rate = clampRate(input.assumedAnnualReturnRate);
    const horizonYears = input.horizonYears;

    // Interest avoided by throwing the surplus at the debts, straight from
    // the existing payoff engine: comparePayoff(debts, surplus).interestSaved.
    const interestSaved = comparePayoff(input.debts, amount).interestSaved;

    const investGain = computeOpportunityCost({
      mode: 'one-time',
      amount,
      horizonYears,
      annualReturnRate: rate,
    }).gain;

    let recommendation: SurplusRecommendation = 'tie';
    if (interestSaved > investGain) recommendation = 'payoff';
    else if (investGain > interestSaved) recommendation = 'invest';

    payoffVsInvest = {
      interestSaved: round2(interestSaved),
      investGain: round2(investGain),
      assumedAnnualReturnRate: rate,
      horizonYears,
      recommendation,
    };
  }

  return {
    amount,
    buffer,
    topGoal: input.topGoal,
    payoffVsInvest,
  };
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_ASSUMED_ANNUAL_RETURN_RATE;
  if (rate < MIN_ANNUAL_RETURN_RATE) return MIN_ANNUAL_RETURN_RATE;
  if (rate > MAX_ANNUAL_RETURN_RATE) return MAX_ANNUAL_RETURN_RATE;
  return rate;
}

/**
 * Select the top active goal for the surplus CTA: highest `priority`, ties
 * broken by the nearest `targetDate` (a goal with a date beats one without;
 * earlier date wins). Goals are assumed already filtered to active + the
 * surplus currency by the caller. Returns null when the list is empty.
 */
export function selectTopGoal<
  T extends { id: number; name: string; currency: string; priority: number; targetDate: string | null },
>(goals: T[]): SurplusTopGoal | null {
  if (goals.length === 0) return null;
  const sorted = [...goals].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Nearest targetDate next; a present date beats a null date.
    if (a.targetDate && b.targetDate) {
      if (a.targetDate !== b.targetDate) return a.targetDate < b.targetDate ? -1 : 1;
    } else if (a.targetDate && !b.targetDate) {
      return -1;
    } else if (!a.targetDate && b.targetDate) {
      return 1;
    }
    return a.id - b.id;
  });
  const top = sorted[0];
  return { id: top.id, name: top.name, currency: top.currency };
}

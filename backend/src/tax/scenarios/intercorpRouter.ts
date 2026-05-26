import type { Decimal } from '../util/decimal';
import type { IncomeItem } from '../engine/types';

export interface IntercorpDistribution {
  payerCorpScenarioId: number;
  payerCorpEntityId: number;
  receiverCorpEntityId: number;
  eligible: Decimal;
  nonEligible: Decimal;
  capital: Decimal;
}

export interface IntercorpDistributionInputs {
  distributions: IntercorpDistribution[];
  /** Set of corp entity IDs that have a scenario in this plan; receivers not in this set warn. */
  corpEntityIdsInPlan: Set<number>;
}

export interface CorpReceivedDivs {
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  /** Capital divs are tax-free; tracked separately for UI display only. */
  capitalDividends: IncomeItem[];
}

export interface IntercorpRouterWarning {
  severity: 'warning' | 'error';
  payerCorpScenarioId: number;
  receiverCorpEntityId: number;
  message: string;
}

export interface IntercorpRouterOutput {
  byReceiverEntityId: Record<number, CorpReceivedDivs>;
  warnings: IntercorpRouterWarning[];
}

export function intercorpRouter(inputs: IntercorpDistributionInputs): IntercorpRouterOutput {
  const byReceiverEntityId: Record<number, CorpReceivedDivs> = {};
  const warnings: IntercorpRouterWarning[] = [];

  function init(receiverId: number): CorpReceivedDivs {
    if (!byReceiverEntityId[receiverId]) {
      byReceiverEntityId[receiverId] = { eligibleDividends: [], nonEligibleDividends: [], capitalDividends: [] };
    }
    return byReceiverEntityId[receiverId];
  }

  for (const dist of inputs.distributions) {
    if (!inputs.corpEntityIdsInPlan.has(dist.receiverCorpEntityId)) {
      warnings.push({
        severity: 'warning',
        payerCorpScenarioId: dist.payerCorpScenarioId,
        receiverCorpEntityId: dist.receiverCorpEntityId,
        message: `receiver corp entity ${dist.receiverCorpEntityId} has no scenario in this plan — intercorp dividend ignored`,
      });
      continue;
    }
    if (dist.payerCorpEntityId === dist.receiverCorpEntityId) {
      warnings.push({
        severity: 'error',
        payerCorpScenarioId: dist.payerCorpScenarioId,
        receiverCorpEntityId: dist.receiverCorpEntityId,
        message: `corp ${dist.payerCorpEntityId} cannot pay intercorp dividend to itself`,
      });
      continue;
    }
    const target = init(dist.receiverCorpEntityId);
    if (dist.eligible.greaterThan(0)) {
      target.eligibleDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:eligible`,
        amount: dist.eligible,
        cadAmount: dist.eligible,
      });
    }
    if (dist.nonEligible.greaterThan(0)) {
      target.nonEligibleDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:nonEligible`,
        amount: dist.nonEligible,
        cadAmount: dist.nonEligible,
      });
    }
    if (dist.capital.greaterThan(0)) {
      target.capitalDividends.push({
        source: `intercorpRouter:from-corp-${dist.payerCorpEntityId}:capital`,
        amount: dist.capital,
        cadAmount: dist.capital,
      });
    }
  }

  return { byReceiverEntityId, warnings };
}

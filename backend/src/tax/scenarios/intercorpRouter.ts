import { D, type Decimal } from '../util/decimal';
import type { IncomeItem } from '../engine/types';

export interface IntercorpDistribution {
  payerCorpScenarioId: number;
  payerCorpEntityId: number;
  receiverCorpEntityId: number;
  eligible: Decimal;
  nonEligible: Decimal;
  capital: Decimal;
  /**
   * P11b T6: receiver's ownership % of payer (0..100). Drives GRIP designation
   * on intercorp eligible dividends: receiver's GRIP grows by
   *   eligible × ownershipPercent / 100
   * Default 100 when not supplied (sole-shareholder holdco — the common case).
   */
  ownershipPercent: Decimal;
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
  /**
   * P11b T6: total GRIP designation flowing to the receiver across all payers.
   *   gripBoost = Σ (eligible × ownershipPercent / 100)
   * `computeHouseholdPlan` injects this onto receiver corp facts as
   * `openingGripBoost`; the engine adds it to GRIP ending in `buildT2`.
   */
  gripBoost: Decimal;
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
      byReceiverEntityId[receiverId] = {
        eligibleDividends: [],
        nonEligibleDividends: [],
        capitalDividends: [],
        gripBoost: D('0'),
      };
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
      // P11b T6: GRIP designation flows with the eligible portion. Real-world
      // an Opco only designates as eligible from its own GRIP — assumption here
      // matches that practice: any intercorp eligible div is GRIP-designated
      // and grows receiver's GRIP by (eligible × ownership%/100).
      target.gripBoost = target.gripBoost.plus(
        dist.eligible.times(dist.ownershipPercent).dividedBy(100),
      );
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

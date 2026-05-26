import { D, type Decimal } from '../util/decimal';

export interface OwnerCompPlan {
  corpScenarioId: number;
  shareholderEntityId: number;
  salary: Decimal;
  bonus: Decimal;
  eligibleDividend: Decimal;
  nonEligibleDividend: Decimal;
  capitalDividend: Decimal;
}

export interface CorpReturnSummary {
  corpScenarioId: number;
  gripEnding: Decimal;
  cdaEnding: Decimal;
  retainedEarningsAfter: Decimal;
}

export interface CorpDistributionInputs {
  corpReturns: CorpReturnSummary[];
  ownerCompPlans: OwnerCompPlan[];
}

export interface PersonalAdditions {
  employmentIncome: Decimal;
  eligibleDividends: Decimal;
  nonEligibleDividends: Decimal;
  capitalDividendsReceived: Decimal;
  cppEnrolled: boolean;
}

export interface IntegrationWarning {
  severity: 'warning' | 'error';
  shareholderEntityId: number | null;
  corpScenarioId: number | null;
  message: string;
}

export interface IntegrationRouterOutput {
  byShareholder: Record<number, PersonalAdditions>;
  warnings: IntegrationWarning[];
}

/**
 * Pure router: takes corp scenario outputs + per-shareholder owner-comp plans,
 * returns per-shareholder additions (employment, dividends w/ gross-up applied
 * later at engine, capital dividends as tax-free) plus validation warnings
 * (GRIP / CDA cap breaches).
 *
 * No IO, no async, no DB. Safe to call from any context.
 */
export function integrationRouter(inputs: CorpDistributionInputs): IntegrationRouterOutput {
  const byShareholder: Record<number, PersonalAdditions> = {};
  const warnings: IntegrationWarning[] = [];

  function bump(shareholderId: number, patch: Partial<PersonalAdditions>): void {
    const existing = byShareholder[shareholderId] ?? {
      employmentIncome: D('0'),
      eligibleDividends: D('0'),
      nonEligibleDividends: D('0'),
      capitalDividendsReceived: D('0'),
      cppEnrolled: false,
    };
    byShareholder[shareholderId] = {
      employmentIncome: existing.employmentIncome.plus(patch.employmentIncome ?? D('0')),
      eligibleDividends: existing.eligibleDividends.plus(patch.eligibleDividends ?? D('0')),
      nonEligibleDividends: existing.nonEligibleDividends.plus(patch.nonEligibleDividends ?? D('0')),
      capitalDividendsReceived: existing.capitalDividendsReceived.plus(
        patch.capitalDividendsReceived ?? D('0'),
      ),
      cppEnrolled: existing.cppEnrolled || (patch.cppEnrolled ?? false),
    };
  }

  // Aggregate per-corp totals to enforce overall caps (GRIP, CDA) below.
  const eligibleDivByCorp: Record<number, Decimal> = {};
  const capDivByCorp: Record<number, Decimal> = {};

  for (const plan of inputs.ownerCompPlans) {
    const salaryPlusBonus = plan.salary.plus(plan.bonus);
    if (salaryPlusBonus.greaterThan(0)) {
      bump(plan.shareholderEntityId, {
        employmentIncome: salaryPlusBonus,
        cppEnrolled: true,
      });
    }
    if (plan.eligibleDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { eligibleDividends: plan.eligibleDividend });
      eligibleDivByCorp[plan.corpScenarioId] = (
        eligibleDivByCorp[plan.corpScenarioId] ?? D('0')
      ).plus(plan.eligibleDividend);
    }
    if (plan.nonEligibleDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { nonEligibleDividends: plan.nonEligibleDividend });
    }
    if (plan.capitalDividend.greaterThan(0)) {
      bump(plan.shareholderEntityId, { capitalDividendsReceived: plan.capitalDividend });
      capDivByCorp[plan.corpScenarioId] = (
        capDivByCorp[plan.corpScenarioId] ?? D('0')
      ).plus(plan.capitalDividend);
    }
  }

  // Cap checks per corp: eligible-div total vs GRIP, capital-div total vs CDA.
  for (const corp of inputs.corpReturns) {
    const eligTotal = eligibleDivByCorp[corp.corpScenarioId] ?? D('0');
    if (eligTotal.greaterThan(corp.gripEnding)) {
      warnings.push({
        severity: 'warning',
        shareholderEntityId: null,
        corpScenarioId: corp.corpScenarioId,
        message: `Eligible dividends paid (${eligTotal.toFixed(2)}) exceed GRIP balance (${corp.gripEnding.toFixed(2)}). Excess would be reclassified non-eligible at filing.`,
      });
    }
    const capTotal = capDivByCorp[corp.corpScenarioId] ?? D('0');
    if (capTotal.greaterThan(corp.cdaEnding)) {
      warnings.push({
        severity: 'warning',
        shareholderEntityId: null,
        corpScenarioId: corp.corpScenarioId,
        message: `Capital dividends paid (${capTotal.toFixed(2)}) exceed CDA balance (${corp.cdaEnding.toFixed(2)}). Excess loses CDA tax-free treatment.`,
      });
    }
  }

  return { byShareholder, warnings };
}

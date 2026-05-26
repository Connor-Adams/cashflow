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

function emptyAdditions(): PersonalAdditions {
  return {
    employmentIncome: D('0'),
    eligibleDividends: D('0'),
    nonEligibleDividends: D('0'),
    capitalDividendsReceived: D('0'),
    cppEnrolled: false,
  };
}

function addAdditions(
  base: PersonalAdditions,
  patch: Partial<PersonalAdditions>,
): PersonalAdditions {
  return {
    employmentIncome: base.employmentIncome.plus(patch.employmentIncome ?? D('0')),
    eligibleDividends: base.eligibleDividends.plus(patch.eligibleDividends ?? D('0')),
    nonEligibleDividends: base.nonEligibleDividends.plus(patch.nonEligibleDividends ?? D('0')),
    capitalDividendsReceived: base.capitalDividendsReceived.plus(
      patch.capitalDividendsReceived ?? D('0'),
    ),
    cppEnrolled: base.cppEnrolled || (patch.cppEnrolled ?? false),
  };
}

interface RoutedShareholderState {
  byShareholder: Record<number, PersonalAdditions>;
  eligibleDivByCorp: Record<number, Decimal>;
  capDivByCorp: Record<number, Decimal>;
}

// Sum each plan's owner-comp components into per-shareholder additions, plus
// per-corp running totals used downstream for GRIP / CDA cap checks.
function routeOwnerCompPlans(plans: OwnerCompPlan[]): RoutedShareholderState {
  const byShareholder: Record<number, PersonalAdditions> = {};
  const eligibleDivByCorp: Record<number, Decimal> = {};
  const capDivByCorp: Record<number, Decimal> = {};

  const bump = (shareholderId: number, patch: Partial<PersonalAdditions>) => {
    byShareholder[shareholderId] = addAdditions(
      byShareholder[shareholderId] ?? emptyAdditions(),
      patch,
    );
  };

  for (const plan of plans) {
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

  return { byShareholder, eligibleDivByCorp, capDivByCorp };
}

// Compare per-corp eligible / capital dividend totals against the GRIP / CDA
// balances on the corp's return summary. Excess emits a soft warning — the
// engine still computes the result, but downstream review surfaces the breach.
function checkDividendCaps(
  corpReturns: CorpReturnSummary[],
  eligibleDivByCorp: Record<number, Decimal>,
  capDivByCorp: Record<number, Decimal>,
): IntegrationWarning[] {
  const warnings: IntegrationWarning[] = [];
  for (const corp of corpReturns) {
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
  return warnings;
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
  const { byShareholder, eligibleDivByCorp, capDivByCorp } = routeOwnerCompPlans(
    inputs.ownerCompPlans,
  );
  const warnings = checkDividendCaps(inputs.corpReturns, eligibleDivByCorp, capDivByCorp);
  return { byShareholder, warnings };
}

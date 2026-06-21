// backend/src/tax/scenarios/projectCorpFactsFromPrevYear.ts
import { D } from '../util/decimal';
import { Scenario } from '../../models';
import { computeCorpScenario } from './computeCorpScenario';
import { resolveCorpScenario } from './resolveCorpScenario';
import { setCorpProjector } from './projectionPorts';
import { rollCorpCarryforwards } from '../services/rollCorpCarryforwards';
import type { CorpTaxYearFacts, IncomeItem } from '../engine/types';

/**
 * Build a CorpTaxYearFacts shell for a projection_root corp scenario.
 *
 * Algorithm:
 *   1. Validate scenario is kind='projection_root' with a parentId.
 *   2. Load parent scenario; require same entityId; require parent.year + 1 === this.year.
 *      (Per P8a convention, year corresponds to the calendar fiscal year.)
 *   3. Resolve parent facts + compute parent return (uses cache if available).
 *   4. Run rollCorpCarryforwards to upsert year-N carryforward rows
 *      (grip, cda, erdtoh, nerdtoh).
 *   5. Build year-N+1 facts: empty dividendsPaid/salaryPaid/capitalGainEvents
 *      (no actuals for the future), carryforwards loaded from rolled rows
 *      plus loss carryforwards untouched from parent, and income arrays
 *      seeded from prior year × (1 + inflation).
 */
export async function projectCorpFactsFromPrevYear(
  scenarioId: number,
): Promise<CorpTaxYearFacts> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);
  if (scenario.kind !== 'projection_root') {
    throw new Error(`projectCorpFactsFromPrevYear requires kind='projection_root', got '${scenario.kind}'`);
  }
  if (scenario.parentId === null) {
    throw new Error(`projection_root scenario id=${scenarioId} must have a parent`);
  }

  const parent = await Scenario.findByPk(scenario.parentId);
  if (!parent) throw new Error(`parent scenario id=${scenario.parentId} not found`);
  if (parent.entityId !== scenario.entityId) {
    throw new Error(`projection_root entity mismatch: parent=${parent.entityId}, child=${scenario.entityId}`);
  }
  if (parent.year + 1 !== scenario.year) {
    throw new Error(`projection_root year ${scenario.year} must be parent year (${parent.year}) + 1`);
  }

  const parentFacts = await resolveCorpScenario(parent.id);
  const parentReturn = await computeCorpScenario(parent.id);

  // computeCorpScenario serialises Decimal totals to strings via JSON.stringify,
  // but rollCorpCarryforwards calls .toFixed() directly on totals.{gripEnding,
  // cdaEnding,erdtohEnding,nerdtohEnding} — re-hydrate those fields as Decimal.
  const serialisedTotals = parentReturn.totals as Record<string, unknown>;
  const hydratedTotals = {
    ...serialisedTotals,
    gripEnding: D(String(serialisedTotals.gripEnding ?? '0')),
    cdaEnding: D(String(serialisedTotals.cdaEnding ?? '0')),
    erdtohEnding: D(String(serialisedTotals.erdtohEnding ?? '0')),
    nerdtohEnding: D(String(serialisedTotals.nerdtohEnding ?? '0')),
  };

  // Roll corp carryforwards so the DB has year-N balances (grip/cda/erdtoh/nerdtoh)
  // queryable as asOfYear = N. buildCorpFacts queries asOfYear = startYear - 1
  // (i.e. N for the N+1 fiscal year starting in calendar year N+1).
  await rollCorpCarryforwards(
    parent.entityId,
    parent.year,
    {
      fiscalYear: parentFacts.fiscalYear,
      lines: parentReturn.lines as never,
      totals: hydratedTotals as never,
      warnings: parentReturn.warnings,
    } as never,
  );

  // Inflation multiplier
  const assumptions = scenario.assumptions as { inflation?: number };
  const inflationMult = D('1').plus(D(String(assumptions.inflation ?? 0)));

  function scaleItems(items: IncomeItem[], tag: string): IncomeItem[] {
    return items.map((item) => ({
      source: `projection:${tag}:${item.source}`,
      amount: item.amount.times(inflationMult),
      cadAmount: item.cadAmount.times(inflationMult),
    }));
  }

  // Load freshly-rolled carryforwards via a lean direct query — buildCorpFacts
  // would also query transactions/activity for the future year (which doesn't
  // exist yet) so we inline the carryforward read.
  const { Carryforward } = await import('../../models');
  const cfRows = await Carryforward.findAll({
    where: { entityId: scenario.entityId, asOfYear: parent.year },
  });
  const carryforwards = {
    grip: D(cfRows.find((c) => c.kind === 'grip')?.amount ?? '0'),
    cda: D(cfRows.find((c) => c.kind === 'cda')?.amount ?? '0'),
    erdtoh: D(cfRows.find((c) => c.kind === 'erdtoh')?.amount ?? '0'),
    nerdtoh: D(cfRows.find((c) => c.kind === 'nerdtoh')?.amount ?? '0'),
    // Loss carryforwards aren't rolled by rollCorpCarryforwards yet (P9 scope is
    // grip/cda/RDTOH only); preserve prior facts' balances so they don't vanish.
    nonCapLoss: D(cfRows.find((c) => c.kind === 'non_cap_loss')?.amount ?? parentFacts.carryforwards.nonCapLoss.toString()),
    netCapitalLoss: D(cfRows.find((c) => c.kind === 'cap_loss')?.amount ?? parentFacts.carryforwards.netCapitalLoss.toString()),
  };

  return {
    fiscalYear: {
      startDate: `${scenario.year}-01-01`,
      endDate: `${scenario.year}-12-31`,
    },
    jurisdiction: parentFacts.jurisdiction,
    activeBusinessIncome: scaleItems(parentFacts.activeBusinessIncome, 'active'),
    investmentIncome: {
      interest: scaleItems(parentFacts.investmentIncome.interest, 'interest'),
      eligibleDividends: scaleItems(parentFacts.investmentIncome.eligibleDividends, 'eligible-div'),
      nonEligibleDividends: scaleItems(parentFacts.investmentIncome.nonEligibleDividends, 'non-elig-div'),
      rentNet: scaleItems(parentFacts.investmentIncome.rentNet, 'rent-net'),
    },
    capitalGainEvents: [], // realisation events; not projected forward by default
    dividendsPaid: [],     // future declarations don't exist
    salaryPaid: D('0'),    // future T4 box 14 doesn't exist
    carryforwards,
  };
}

// Register the corp projector so resolveCorpScenario can dispatch projection_root
// roots through the port without importing this module (which imports
// resolveCorpScenario; importing back would re-form the cycle).
setCorpProjector(projectCorpFactsFromPrevYear);

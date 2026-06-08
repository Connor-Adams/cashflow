// backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts
import { D } from '../util/decimal';
import { Scenario } from '../../models';
import { computeScenario } from './computeScenario';
import { resolveScenario } from './resolveScenario';
import { rollPersonalCarryforwards } from '../services/rollPersonalCarryforwards';
import { ratesFor } from '../engine/brackets';
import type { TaxYearFacts, IncomeItem, RrspContrib } from '../engine/types';

/**
 * Build a TaxYearFacts shell for a projection_root scenario.
 *
 * Algorithm:
 *   1. Validate scenario is kind='projection_root' with a parentId.
 *   2. Load parent scenario; require same entityId; require parent.year + 1 === this.year.
 *   3. Compute parent year (uses cache if available); resolve its facts.
 *   4. Run rollPersonalCarryforwards to upsert year-N carryforward rows.
 *   5. Build year-N+1 facts: empty actuals (no txns/slips for the future),
 *      carryforwards loaded from the rolled rows, income arrays seeded
 *      from prior year × (1 + inflation).
 */
export async function projectPersonalFactsFromPrevYear(
  scenarioId: number,
): Promise<TaxYearFacts> {
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) throw new Error(`scenario id=${scenarioId} not found`);
  if (scenario.kind !== 'projection_root') {
    throw new Error(`projectPersonalFactsFromPrevYear requires kind='projection_root', got '${scenario.kind}'`);
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

  const parentFacts = await resolveScenario(parent.id);
  const parentReturn = await computeScenario(parent.id);
  const rates = ratesFor(parent.year);

  // Roll carryforwards so the DB has year-N balances queryable as asOfYear = N.
  // The buildPersonalFacts path queries asOfYear = year - 1 (i.e. N for the N+1 facts).
  await rollPersonalCarryforwards(
    parent.entityId,
    parent.year,
    {
      // computeScenario returns serialised totals/lines; rollPersonalCarryforwards
      // needs a TaxReturn-shape struct. Reconstruct only the fields it reads.
      year: parent.year,
      lines: parentReturn.lines as never,
      totals: {
        ...(parentReturn.totals as Record<string, unknown>),
      } as never,
      warnings: parentReturn.warnings,
    } as never,
    parentFacts,
    rates,
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
  function scaleRrsp(items: RrspContrib[]): RrspContrib[] {
    return items.map((item) => ({
      source: `projection:${item.source}`,
      amount: item.amount.times(inflationMult),
      date: item.date,
    }));
  }

  // Load freshly-rolled carryforwards via the standard builder path is overkill
  // (it would query txns/activity for next year which don't exist). Inline a
  // lean query — it just needs the carryforward shape.
  const { Carryforward, InstalmentPayment } = await import('../../models');
  const cfRows = await Carryforward.findAll({
    where: { entityId: scenario.entityId, asOfYear: parent.year },
  });
  const instRows = await InstalmentPayment.findAll({
    where: { entityId: scenario.entityId, year: scenario.year },
  });
  const carryforwards = {
    netCapitalLoss: D(cfRows.find(c => c.kind === 'cap_loss')?.amount ?? '0'),
    rrspRoom: D(cfRows.find(c => c.kind === 'rrsp_room')?.amount ?? '0'),
    nonCapLoss: D(cfRows.find(c => c.kind === 'non_cap_loss')?.amount ?? '0'),
    instalmentsPaid: instRows.length > 0
      ? instRows.reduce((sum, r) => sum.plus(D(r.amount as unknown as string)), D('0'))
      : D(cfRows.find(c => c.kind === 'instalments_paid')?.amount ?? '0'),
    fhsaLifetimeContributions: D(cfRows.find(c => c.kind === 'fhsa_lifetime_contribs')?.amount ?? '0'),
  };

  return {
    year: scenario.year,
    jurisdiction: parentFacts.jurisdiction,
    employmentIncome: scaleItems(parentFacts.employmentIncome, 'employment'),
    selfEmploymentIncome: scaleItems(parentFacts.selfEmploymentIncome, 'self-emp'),
    selfEmploymentExpenses: scaleItems(parentFacts.selfEmploymentExpenses, 'self-emp-exp'),
    interestIncome: scaleItems(parentFacts.interestIncome, 'interest'),
    eligibleDividends: scaleItems(parentFacts.eligibleDividends, 'eligible-div'),
    nonEligibleDividends: scaleItems(parentFacts.nonEligibleDividends, 'non-elig-div'),
    capitalGainEvents: [], // capital gains are realisation events; do not project forward by default
    rrspContribs: scaleRrsp(parentFacts.rrspContribs),
    fhsaContribs: scaleRrsp(parentFacts.fhsaContribs),
    donations: scaleItems(parentFacts.donations, 'donations'),
    slips: [], // future slips don't exist
    carryforwards,
    ageAtYearEnd: parentFacts.ageAtYearEnd + 1,
  };
}

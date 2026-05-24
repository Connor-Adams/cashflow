import { D } from '../util/decimal';
import { Entity, Carryforward } from '../../models';
import type { CorpFiscalYear, CorpTaxYearFacts } from '../engine/types';

/**
 * Build minimal CorpTaxYearFacts for a given entity + fiscal year.
 *
 * The scenario engine needs this as a baseline to layer OwnerComp on top of.
 * Income items (ABI, investment income, dividends paid, capital gains) come from
 * DB carryforwards and are otherwise empty — the caller (scenario route / tests)
 * is expected to supply real ABI/investment items either directly or by enriching
 * the returned facts before passing to buildT2/runScenario.
 *
 * Carryforwards (GRIP, CDA, ERDTOH, NERDTOH, non-cap loss, net-cap loss) are
 * loaded from the Carryforward table for asOfYear = fiscalYear.endDate year - 1.
 */
export async function buildCorpFacts(
  entityId: number,
  fiscalYear: CorpFiscalYear,
): Promise<CorpTaxYearFacts> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'corp') throw new Error(`Entity ${entityId} is not a corp entity`);

  // Load carryforwards from year prior to fiscal-year end
  const endYear = Number(fiscalYear.endDate.slice(0, 4));
  const priorYear = endYear - 1;

  const cfRows = await Carryforward.findAll({ where: { entityId, asOfYear: priorYear } });
  const cf = (kind: string) => D(cfRows.find((c) => c.kind === kind)?.amount ?? 0);

  return {
    fiscalYear,
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: {
      interest: [],
      eligibleDividends: [],
      nonEligibleDividends: [],
      rentNet: [],
    },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: {
      grip: cf('grip'),
      cda: cf('cda'),
      erdtoh: cf('erdtoh'),
      nerdtoh: cf('nerdtoh'),
      nonCapLoss: cf('non_cap_loss'),
      netCapitalLoss: cf('net_cap_loss'),
    },
  };
}

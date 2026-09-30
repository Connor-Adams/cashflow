import { Op } from 'sequelize';
import { Entity, Transaction } from '../../models';
import { createCadConverter } from '../completeness/cadConverter';
import { D } from '../util/decimal';
import { buildT1 } from '../engine/t1';
import { addNonEligibleDividend } from '../completeness/estimateTaxImpact';
import { projectRemainder, type MonthlyActivity, type RemainderProjection } from './projectRemainder';
import type { RateTable, TaxYearFacts } from '../engine/types';

export interface ForwardView {
  year: number;
  /** Always true. Stated so the figure can never be mistaken for a filed number. */
  isProjection: true;
  draws: RemainderProjection;
  /** Total payable on the return as it stands. */
  currentTotalPayable: string;
  /** Total payable if the projected remainder is drawn as it has been so far. */
  projectedTotalPayable: string;
  /** The difference — what the rest of the year is expected to add. */
  projectedAdditionalTax: string;
}

/**
 * "The year at the current run rate": actuals to date plus a projection of what is
 * left, priced through the engine.
 *
 * Derived rather than persisted. Making this a fourth `ScenarioKind` — the earlier
 * design — would need a new union value in three files, a third `resolveScenario`
 * branch, a cache exemption and a creation guard rejecting parentage, all of it to
 * stop a run-rate figure being cached on facts. That problem exists only because it
 * would be a Scenario. Per the primitives rule, derived means a computation.
 *
 * The remainder is priced as a non-eligible dividend because that is what every
 * classified draw in prod resolves to for a CCPC paying out of small-business-rate
 * income, and it is re-run through the engine rather than multiplied by a rate: the
 * marginal band moves as the year fills in.
 */
export async function buildForwardView(
  { entityId, year, facts, rates, now = new Date() }: {
    entityId: number;
    year: number;
    facts: TaxYearFacts;
    rates: RateTable;
    now?: Date;
  },
): Promise<ForwardView> {
  const months = await loadMonthlyDrawActivity(entityId, year, createCadConverter());
  // Only elapsed months can be covered or uncovered. In a future year nothing has
  // elapsed, so there is nothing to project from and nothing to report as missing.
  const asOfMonth = asOfMonthWithin(year, now);
  const draws = projectRemainder({ months, asOfMonth, year });

  const currentTotalPayable = buildT1(facts, rates).totals.totalPayable;
  const projectedTotalPayable = draws.projectedRemainder.greaterThan(0)
    ? buildT1(addNonEligibleDividend(draws.projectedRemainder)(facts), rates).totals.totalPayable
    : currentTotalPayable;

  return {
    year,
    isProjection: true,
    draws,
    currentTotalPayable: currentTotalPayable.toFixed(2),
    projectedTotalPayable: projectedTotalPayable.toFixed(2),
    projectedAdditionalTax: projectedTotalPayable.minus(currentTotalPayable).toFixed(2),
  };
}

/** 1-12 for the current year, 12 for a past year, 0 for a year not yet begun. */
function asOfMonthWithin(year: number, now: Date): number {
  const nowYear = now.getUTCFullYear();
  if (year < nowYear) return 12;
  if (year > nowYear) return 0;
  return now.getUTCMonth() + 1;
}

/**
 * Per-month draw totals and transaction counts for the entity's year.
 *
 * Draws are personal legs linked to a corp-entity counterpart — the same structural
 * shape the classification queue uses — and are counted whether or not they have been
 * classified. Counting only classified rows would project low for exactly the taxpayer
 * whose queue is behind, which is the situation this plan exists to fix.
 *
 * `transactionCount` counts EVERY transaction, because that is what distinguishes an
 * unimported month from a month with no draws taken.
 */
async function loadMonthlyDrawActivity(
  entityId: number,
  year: number,
  toCadMemo: (a: ReturnType<typeof D>, c: string, d: string) => Promise<ReturnType<typeof D>>,
): Promise<MonthlyActivity[]> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`buildForwardView: entity ${entityId} not found`);

  const corps = await Entity.findAll({
    where: { householdId: entity.householdId, kind: 'corp' },
    attributes: ['id'],
  });
  const corpEntityIds = new Set(corps.map((c) => c.id));

  const txns = await Transaction.findAll({
    where: { entityId, date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
    attributes: ['id', 'date', 'amount', 'currency', 'txnType', 'linkedTransactionId'],
  });

  const linkedIds = txns
    .map((t) => t.linkedTransactionId)
    .filter((x): x is number => x != null);
  const counterparts = linkedIds.length
    ? await Transaction.findAll({
      where: { id: { [Op.in]: linkedIds } },
      attributes: ['id', 'entityId'],
    })
    : [];
  const counterpartEntity = new Map(counterparts.map((c) => [c.id, c.entityId ?? null]));

  const byMonth = new Map<number, MonthlyActivity>();
  for (const t of txns) {
    const month = Number(String(t.date).slice(5, 7));
    const entry = byMonth.get(month)
      ?? { month, transactionCount: 0, draws: D('0') };
    entry.transactionCount += 1;
    const counterpart = t.linkedTransactionId != null
      ? counterpartEntity.get(t.linkedTransactionId) ?? null
      : null;
    const isDraw = (t as unknown as { txnType?: string | null }).txnType === 'transfer'
      && counterpart !== null
      && corpEntityIds.has(counterpart);
    if (isDraw) {
      // 2026 holds 30 USD transfers. A run rate summed across currencies would be a
      // meaningless average, and it feeds a tax estimate.
      const cad = await toCadMemo(D(String(t.amount)), t.currency ?? 'CAD', String(t.date));
      entry.draws = entry.draws.plus(cad);
    }
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.month - b.month);
}

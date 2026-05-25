import { D, Decimal, maxZero, sumD } from '../util/decimal';
import { Carryforward } from '../../models';
import type { TaxReturn, TaxYearFacts, RateTable } from '../engine/types';

export type RollResult = {
  written: Array<{ kind: string; amount: Decimal }>;
};

/**
 * Roll forward personal carryforwards from year N to year N+1.
 * Reads computed TaxReturn + facts; upserts Carryforward rows for asOfYear = year.
 * (Carryforward `asOfYear` = N means "balances at end of year N", consumed by year N+1's facts.)
 */
export async function rollPersonalCarryforwards(
  entityId: number,
  year: number,
  _ret: TaxReturn,
  facts: TaxYearFacts,
  r: RateTable,
): Promise<RollResult> {
  // Net capital loss carried = prior balance + new losses - amounts applied.
  // Approximate from facts: if sum(proceeds - acb - outlays) < 0, the includable
  // portion (grossLoss * inclusionRate) is added to the carry; otherwise it absorbs the carry.
  const grossGains = sumD(facts.capitalGainEvents.map(e =>
    e.proceeds.minus(e.acb).minus(e.outlays)
  ));
  const includableThisYear = grossGains.times(r.capitalGainsInclusion);
  let netCapLoss = facts.carryforwards.netCapitalLoss;
  if (includableThisYear.lessThan(0)) {
    netCapLoss = netCapLoss.plus(includableThisYear.negated());
  } else {
    netCapLoss = maxZero(netCapLoss.minus(includableThisYear));
  }

  // Non-cap loss: Phase 4 PR 1 — preserve prior balance only.
  // Auto-detection of new non-cap losses is deferred to a future phase when the
  // full taxable-income picture is available through the engine.
  const nonCapLoss = facts.carryforwards.nonCapLoss;

  // RRSP room: prior balance + 18% × earned income (ignoring pension adjustment in Phase 4 PR 1)
  // capped at annual limit; minus contributions made this year.
  const earnedIncome = sumD(facts.employmentIncome.map(i => i.cadAmount))
    .plus(sumD(facts.selfEmploymentIncome.map(i => i.cadAmount)))
    .minus(sumD(facts.selfEmploymentExpenses.map(i => i.cadAmount)));
  const newRoom = Decimal.min(maxZero(earnedIncome).times('0.18'), r.rrspAnnualLimit);
  const contribsUsed = sumD(facts.rrspContribs.map(c => c.amount));
  const rrspRoom = maxZero(facts.carryforwards.rrspRoom.plus(newRoom).minus(contribsUsed));

  // FHSA room: roll annual limit less any contribs this year.
  // Phase 4 PR 1 simplification: does not track lifetime accumulation.
  // Phase 2 PR 1 adds fhsaAnnualLimit to RateTable; probe via `as any` since this
  // branch is from main pre-Phase-2 merge, so the field may not yet exist at runtime.
  const fhsaAnnualLimit = (r as any).fhsaAnnualLimit ?? D('8000');
  const fhsaUsed = D('0'); // facts.fhsaContribs not in TaxYearFacts on this branch yet
  const fhsaRoom = maxZero(fhsaAnnualLimit.minus(fhsaUsed));

  const writes: Array<{ kind: string; amount: Decimal }> = [
    { kind: 'cap_loss', amount: netCapLoss },
    { kind: 'non_cap_loss', amount: nonCapLoss },
    { kind: 'rrsp_room', amount: rrspRoom },
    { kind: 'fhsa_room', amount: fhsaRoom },
  ];

  for (const w of writes) {
    await Carryforward.upsert({
      entityId,
      kind: w.kind,
      asOfYear: year,
      amount: w.amount.toFixed(4),
    } as any);
  }

  return { written: writes };
}

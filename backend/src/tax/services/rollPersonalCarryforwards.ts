import { Decimal, maxZero, sumD } from '../util/decimal';
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

  // RRSP room: prior balance + 18% x earned income, capped at annual limit,
  // minus contributions made this year.
  // LIMITATION: pension adjustment (PA) from T4 box 52 is not subtracted from new
  // room because TaxYearFacts does not carry a pensionAdjustment field yet. When
  // PA support is added, the formula should be:
  //   newRoom = min(maxZero(earnedIncome) * 0.18, rrspAnnualLimit) - PA
  const earnedIncome = sumD(facts.employmentIncome.map(i => i.cadAmount))
    .plus(sumD(facts.selfEmploymentIncome.map(i => i.cadAmount)))
    .minus(sumD(facts.selfEmploymentExpenses.map(i => i.cadAmount)));
  const newRoom = Decimal.min(maxZero(earnedIncome).times('0.18'), r.rrspAnnualLimit);
  const contribsUsed = sumD(facts.rrspContribs.map(c => c.amount));
  const rrspRoom = maxZero(facts.carryforwards.rrspRoom.plus(newRoom).minus(contribsUsed));

  // FHSA room: annual limit capped by $40k lifetime limit.
  // Track cumulative contributions so room goes to zero once lifetime cap is hit.
  const fhsaAnnualLimit = r.fhsaAnnualLimit;
  const fhsaLifetimeLimit = r.fhsaLifetimeLimit;
  const fhsaUsed = sumD(facts.fhsaContribs.map(c => c.amount));
  const priorLifetimeContribs = facts.carryforwards.fhsaLifetimeContributions;
  const newLifetimeContribs = priorLifetimeContribs.plus(fhsaUsed);
  const lifetimeRemaining = maxZero(fhsaLifetimeLimit.minus(newLifetimeContribs));
  const fhsaRoom = Decimal.min(fhsaAnnualLimit, lifetimeRemaining);

  const writes: Array<{ kind: string; amount: Decimal }> = [
    { kind: 'cap_loss', amount: netCapLoss },
    { kind: 'non_cap_loss', amount: nonCapLoss },
    { kind: 'rrsp_room', amount: rrspRoom },
    { kind: 'fhsa_room', amount: fhsaRoom },
    { kind: 'fhsa_lifetime_contribs', amount: newLifetimeContribs },
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

import { D, Decimal, maxZero, sumD } from '../util/decimal';
import { Carryforward } from '../../models';
import { taxableCapitalGains } from '../engine/capital-gains';
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
  ret: TaxReturn,
  facts: TaxYearFacts,
  r: RateTable,
): Promise<RollResult> {
  // Net capital loss carried = prior balance + new includable losses − amounts
  // applied against gains. Delegate to the engine so the roll matches buildT1
  // exactly: superficial-loss-denied amounts are added back (a denied loss
  // adjusts the repurchased shares' ACB, never the carry) and the tiered
  // post-June-2024 inclusion rate is honoured.
  const netCapLoss = taxableCapitalGains(
    facts.capitalGainEvents,
    r,
    facts.carryforwards.netCapitalLoss,
  ).carryforwardRemaining;

  // Non-cap loss: subtract the amount buildT1 applied on L26000 this year
  // (applied = min(netIncome, carry)) so the same loss can't deduct again in
  // year N+1. ret.totals.netIncome is a Decimal on the live-engine path but a
  // JSON-serialised string on the projection path — coerce defensively.
  // Auto-detection of NEW non-cap losses (e.g. an SE loss exceeding income) is
  // still deferred until the engine surfaces the full loss picture.
  const netIncome = maxZero(D(String(ret.totals?.netIncome ?? 0)));
  const nonCapLossApplied = Decimal.min(netIncome, facts.carryforwards.nonCapLoss);
  const nonCapLoss = maxZero(facts.carryforwards.nonCapLoss.minus(nonCapLossApplied));

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

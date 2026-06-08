import { D, Decimal, maxZero } from '../util/decimal';
import type { CapGainEvent, RateTable } from './types';

export type CapGainsResult = {
  gross: Decimal;
  inclusionRate: Decimal;
  taxable: Decimal;
  carryforwardRemaining: Decimal;
};

/**
 * Tiered inclusion (personal T1): since June 25 2024, gains above $250K use
 * the higher rate (66.67%). Gains up to $250K stay at 50%.
 * When `capitalGainsInclusionHigh` / `capitalGainsInclusionThreshold` are absent
 * from the rate table, falls back to flat inclusion (pre-2024 years).
 */
export function taxableCapitalGains(
  events: CapGainEvent[],
  r: RateTable,
  netCapLossCarryforward: Decimal
): CapGainsResult {
  const gross = events.reduce<Decimal>(
    (acc, e) => {
      const rawGain = e.proceeds.minus(e.acb).minus(e.outlays);
      const denied = e.superficialLossDenied ?? D('0');
      const adjusted = rawGain.lessThan(0)
        ? rawGain.plus(denied)
        : rawGain;
      return acc.plus(adjusted);
    },
    D('0')
  );
  const includable = computePersonalInclusion(gross, r);
  if (includable.lessThanOrEqualTo(0)) {
    return {
      gross,
      inclusionRate: r.capitalGainsInclusion,
      taxable: D('0'),
      carryforwardRemaining: netCapLossCarryforward.plus(includable.negated()),
    };
  }
  const applied = Decimal.min(includable, netCapLossCarryforward);
  return {
    gross,
    inclusionRate: r.capitalGainsInclusion,
    taxable: maxZero(includable.minus(applied)),
    carryforwardRemaining: netCapLossCarryforward.minus(applied),
  };
}

function computePersonalInclusion(gross: Decimal, r: RateTable): Decimal {
  const highRate = r.capitalGainsInclusionHigh;
  const threshold = r.capitalGainsInclusionThreshold;
  if (!highRate || !threshold || gross.lessThanOrEqualTo(threshold)) {
    return gross.times(r.capitalGainsInclusion);
  }
  const lowPortion = threshold.times(r.capitalGainsInclusion);
  const highPortion = gross.minus(threshold).times(highRate);
  return lowPortion.plus(highPortion);
}

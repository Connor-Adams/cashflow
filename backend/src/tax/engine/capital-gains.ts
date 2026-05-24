import { D, Decimal, maxZero } from '../util/decimal';
import type { CapGainEvent, RateTable } from './types';

export type CapGainsResult = {
  gross: Decimal;
  inclusionRate: Decimal;
  taxable: Decimal;
  carryforwardRemaining: Decimal;
};

export function taxableCapitalGains(
  events: CapGainEvent[],
  r: RateTable,
  netCapLossCarryforward: Decimal
): CapGainsResult {
  const gross = events.reduce<Decimal>(
    (acc, e) => acc.plus(e.proceeds.minus(e.acb).minus(e.outlays)),
    D('0')
  );
  const includable = gross.times(r.capitalGainsInclusion);
  if (includable.lessThanOrEqualTo(0)) {
    // Loss year: roll the loss into carryforward (50%-included absorbed).
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

import { Carryforward } from '../../models';
import type { CorpTaxReturn } from '../engine/types';

export type CorpRollResult = {
  written: Array<{ kind: string; amount: string }>;
};

/**
 * Roll forward corp carryforwards from fiscal year ending in N to year N+1.
 * Reads CorpTaxReturn.totals (ending balances after dividend refund + additions).
 */
export async function rollCorpCarryforwards(
  entityId: number,
  asOfYear: number,  // typically: fiscalYear.endDate.slice(0, 4) - 0 (year of fiscal year end)
  ret: CorpTaxReturn,
): Promise<CorpRollResult> {
  const writes = [
    { kind: 'grip', amount: ret.totals.gripEnding.toFixed(4) },
    { kind: 'cda', amount: ret.totals.cdaEnding.toFixed(4) },
    { kind: 'erdtoh', amount: ret.totals.erdtohEnding.toFixed(4) },
    { kind: 'nerdtoh', amount: ret.totals.nerdtohEnding.toFixed(4) },
  ];

  for (const w of writes) {
    await Carryforward.upsert({
      entityId,
      kind: w.kind,
      asOfYear,
      amount: w.amount,
    } as any);
  }

  return { written: writes };
}

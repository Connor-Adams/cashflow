import { D, type Decimal } from '../util/decimal';

export interface SpouseRouterPersonalInput {
  scenarioId: number;
  entityId: number;
  spouseEntityId: number | null;
  pensionSplitTransferOut: Decimal; // 0 if no split set
}

export interface SpouseRouterOutput {
  /** Per-personal-entity income shifts to apply BEFORE computing T1. */
  byEntityId: Record<
    number,
    {
      /** Positive amount added to the entity's employment/pension income. */
      pensionSplitTransferIn: Decimal;
      /** Positive amount subtracted from the entity's employment/pension income. */
      pensionSplitTransferOut: Decimal;
    }
  >;
  warnings: Array<{
    severity: 'warning';
    entityId: number;
    message: string;
  }>;
}

export function spouseRouter(inputs: SpouseRouterPersonalInput[]): SpouseRouterOutput {
  const byEntityId: SpouseRouterOutput['byEntityId'] = {};
  const warnings: SpouseRouterOutput['warnings'] = [];

  function bump(
    entityId: number,
    patch: Partial<{ pensionSplitTransferIn: Decimal; pensionSplitTransferOut: Decimal }>,
  ) {
    const existing = byEntityId[entityId] ?? {
      pensionSplitTransferIn: D('0'),
      pensionSplitTransferOut: D('0'),
    };
    byEntityId[entityId] = {
      pensionSplitTransferIn: existing.pensionSplitTransferIn.plus(
        patch.pensionSplitTransferIn ?? D('0'),
      ),
      pensionSplitTransferOut: existing.pensionSplitTransferOut.plus(
        patch.pensionSplitTransferOut ?? D('0'),
      ),
    };
  }

  for (const input of inputs) {
    if (input.pensionSplitTransferOut.lessThanOrEqualTo(0)) continue;
    if (input.spouseEntityId === null) {
      warnings.push({
        severity: 'warning',
        entityId: input.entityId,
        message: `pensionSplit.transferAmount set on entity ${input.entityId} but no spouse linked — split ignored`,
      });
      continue;
    }
    // Verify the spouse is also in this input set (paired scenario)
    const spousePresent = inputs.some((i) => i.entityId === input.spouseEntityId);
    if (!spousePresent) {
      warnings.push({
        severity: 'warning',
        entityId: input.entityId,
        message: `spouse entity ${input.spouseEntityId} has no scenario in this plan — split ignored`,
      });
      continue;
    }
    bump(input.entityId, { pensionSplitTransferOut: input.pensionSplitTransferOut });
    bump(input.spouseEntityId, { pensionSplitTransferIn: input.pensionSplitTransferOut });
  }

  return { byEntityId, warnings };
}

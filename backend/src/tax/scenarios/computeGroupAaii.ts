import { computeAaii } from '../engine/aaii';
import type { CorpTaxYearFacts, RateTable } from '../engine/types';
import { D, type Decimal } from '../util/decimal';
import type { Entity } from '../../models';

/**
 * P11b T2 — Group AAII rollup helper.
 *
 * Sums per-corp AAII across all corps that share an `associatedGroupId` on
 * their backing {@link Entity}. Used by `computeHouseholdPlan` to feed the
 * group-wide AAII into the SBD grind (s.125(5.1)) so associated corps share
 * the single $50k AAII threshold, not one each.
 *
 * Corps whose entity has a null `associatedGroupId` are skipped (they don't
 * participate in any group); entities not found in `entityById` are also
 * skipped.
 *
 * Returns a `Map<string, Decimal>` keyed by `associatedGroupId`.
 */
export function computeGroupAaii(
  corpFactsByEntityId: Map<number, CorpTaxYearFacts>,
  entityById: Map<number, Entity>,
  rateTable: RateTable,
): Map<string, Decimal> {
  const byGroup = new Map<string, Decimal>();
  for (const [entityId, facts] of corpFactsByEntityId) {
    const entity = entityById.get(entityId);
    const groupId = entity?.associatedGroupId;
    if (!groupId) continue;
    const aaii = computeAaii(facts, rateTable);
    const cur = byGroup.get(groupId) ?? D('0');
    byGroup.set(groupId, cur.plus(aaii));
  }
  return byGroup;
}

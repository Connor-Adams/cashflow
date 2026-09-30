import { Entity } from '../../models';
import { loadCorpPerimeterInputs } from '../builders/loadCorpPerimeterInputs';
import { partitionCorpPerimeter, type PerimeterTxn } from '../builders/corpPerimeter';

/**
 * Corp outbound transfers in the year whose matching leg was never imported.
 *
 * The one place the personal-entity report reads CORP rows, and the reach is the
 * point: a draw that left the corporation and never arrived is invisible from the
 * personal side, because there is no personal row to notice the absence of.
 *
 * Runs the real perimeter split rather than re-deriving its predicate. Both obvious
 * re-derivations are wrong — `corpPerimeter.ts` documents why — and the inputs matter
 * as much as the rule: the link-target set is built from FULL entity history (a
 * transfer initiated in December and settled in January looks external on both sides
 * of a year boundary otherwise), brokerage cash movements are matched 1:1 within a
 * ±3-day window, and the 1a cash mirrors are excluded. Hence
 * `loadCorpPerimeterInputs`, shared with `buildCorpFacts`.
 *
 * Calendar-year window, matching `resolveCorpScenario`, which builds every corp
 * scenario's fiscal year as the calendar year. An off-calendar year end would need
 * this to take the range explicitly.
 */
export async function loadUnimportedOutboundTransfers(
  householdId: number,
  year: number,
): Promise<PerimeterTxn[]> {
  const corps = await Entity.findAll({
    where: { householdId, kind: 'corp' },
    attributes: ['id'],
  });
  if (corps.length === 0) return [];

  const fiscalYear = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
  const out: PerimeterTxn[] = [];
  for (const corp of corps) {
    const inputs = await loadCorpPerimeterInputs(corp.id, fiscalYear);
    const perimeter = partitionCorpPerimeter(inputs.perimeterInput, inputs.perimeterOptions);
    out.push(...perimeter.unimportedOutboundTransfers);
  }
  return out;
}

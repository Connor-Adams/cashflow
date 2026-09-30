import { Op } from 'sequelize';
import { Entity, Transaction } from '../../models';
import { loadCorpPerimeterInputs } from '../builders/loadCorpPerimeterInputs';
import { partitionCorpPerimeter } from '../builders/corpPerimeter';
import { D } from '../util/decimal';
import type { CadConverter, OutboundTransferRow } from './types';

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
  toCadMemo: CadConverter,
): Promise<OutboundTransferRow[]> {
  const corps = await Entity.findAll({
    where: { householdId, kind: 'corp' },
    attributes: ['id'],
  });
  if (corps.length === 0) return [];

  const fiscalYear = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };

  /**
   * Link sources from the WHOLE household, not just the corp entity.
   *
   * `loadCorpPerimeterInputs` builds `linkTargetIds` from the corp entity's own rows,
   * which is right for `buildCorpFacts` — there a misfiling is conservative, the row
   * simply is not deducted. Here it is not: `linkedTransactionId` is one-directional,
   * and the shape the classification queue depends on is *personal leg points at corp
   * leg*. A corp leg that a personal leg points at therefore has no pointer of its own
   * and is absent from a corp-scoped set, so it reached the unimported branch and
   * raised a blocker for money whose other half is imported and linked — while the same
   * dollars were also reported, and priced, as an unclassified draw.
   *
   * Latent rather than academic: part 4 step 2 backfills the 2026-01-10 corp leg and
   * links it to personal txn 12139, which would have created exactly this false blocker.
   */
  const householdPointers = await Transaction.findAll({
    where: { householdId, linkedTransactionId: { [Op.ne]: null } },
    attributes: ['linkedTransactionId'],
  });

  const out: OutboundTransferRow[] = [];
  for (const corp of corps) {
    const inputs = await loadCorpPerimeterInputs(corp.id, fiscalYear);
    const linkTargetIds = new Set(inputs.perimeterOptions.linkTargetIds);
    for (const p of householdPointers) linkTargetIds.add(p.linkedTransactionId as number);
    const perimeter = partitionCorpPerimeter(
      inputs.perimeterInput,
      { ...inputs.perimeterOptions, linkTargetIds },
    );
    for (const t of perimeter.unimportedOutboundTransfers) {
      // `PerimeterTxn.amount` is in the account's own currency — the corp's Wise USD
      // account is that file's own worked example — and this figure is a blocker's
      // headline number.
      const cadAmount = await toCadMemo(D(t.amount), t.currency, t.date);
      out.push({ id: t.id, date: t.date, cadAmount });
    }
  }
  return out;
}

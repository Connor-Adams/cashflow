import { isTaxTreatment } from '@cashflow/shared';
import {
  inheritedTaxTreatment,
  type CatTaxNode,
} from '../../categories/inheritedTaxTreatment';

export interface TaxTreatmentMaps {
  /**
   * Id-keyed, so a nested category inherits its parent's treatment. `CatTaxNode`
   * is reused rather than redeclared: its `taxTreatment` is non-nullable because
   * `Category.taxTreatment` defaults to `'none'`, and a local lookalike typing it
   * nullable would not be assignable.
   */
  catById: Map<number, CatTaxNode>;
  /** Name-keyed legacy map, for rows with no `finalCategoryId`. */
  catTreatment: Map<string, string>;
}

export interface TaxTreatmentRow {
  taxTreatmentOverride: string | null;
  finalCategoryId: number | null;
  finalCategory: string | null;
}

/**
 * How a transaction gets a tax treatment. Four routes, in precedence order:
 *
 *   1. the per-transaction `taxTreatmentOverride`
 *   2. the category's treatment, inherited from ancestors when the category's own
 *      is `none` — resolved by id to honour the hierarchy and dodge same-named
 *      category collisions
 *   3. the legacy name map, for rows with no `finalCategoryId`
 *   4. the `finalCategory` string itself when it is a tax-treatment keyword, which
 *      keeps pre-category snake_case values like `employment_income` working
 *
 * Returns `'none'` when no route classifies the row.
 *
 * The return is a plain string, not a `TaxTreatment`: route 3 yields whatever the
 * category's `taxTreatment` column holds and nothing validates it against
 * `TAX_TREATMENTS` on the way through. Route 4 does validate, which is why
 * `finalCategory: 'donation'` resolves to `'none'` while `'donations'` resolves.
 * Preserved as-is — this extraction changes no behaviour.
 *
 * Extracted from `buildPersonalFacts` so the duplicate detector can ask "is this
 * row classified?" with the SAME ladder rather than a lookalike. The distinction
 * matters: testing `taxTreatmentOverride` alone — the obvious shortcut — treats a
 * row classified through route 2, 3 or 4 as untouched, and the detector would
 * report an already-categorised row as safe to merge away.
 */
export function resolveTaxTreatment(
  row: TaxTreatmentRow,
  { catById, catTreatment }: TaxTreatmentMaps,
): string {
  let treatment =
    row.taxTreatmentOverride ??
    (row.finalCategoryId != null
      ? inheritedTaxTreatment(catById, row.finalCategoryId)
      : catTreatment.get(row.finalCategory ?? '')) ??
    'none';
  if (treatment === 'none' && row.finalCategory && isTaxTreatment(row.finalCategory)) {
    treatment = row.finalCategory;
  }
  return treatment;
}

/** True when any route classifies the row for tax. */
export function isTaxClassified(row: TaxTreatmentRow, maps: TaxTreatmentMaps): boolean {
  return resolveTaxTreatment(row, maps) !== 'none';
}

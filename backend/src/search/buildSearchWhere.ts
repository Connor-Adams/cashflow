/**
 * buildSearchWhere — turns a SearchIntent into a Sequelize where clause for
 * Transaction.findAll/count.
 *
 * Pure function (intent + visibilityWhere → where). Receipt presence is
 * NOT solved here — it's expressed as `_hasReceipt` on the returned object
 * so the route can branch into a JOIN (Sequelize subQueries are awkward
 * for "has any" filters). The route's `where` strips the `_hasReceipt`
 * marker before passing to findAll/count.
 *
 * Why pure: testability and reuse — the same builder powers /search,
 * potential CSV exports, and any future "search results count" widget.
 *
 * Visibility: the caller passes in `visibilityWhere` (typically
 * `visibleTransactionWhere(req)`). This builder NEVER touches household
 * scope by itself — that's the route's job.
 */

import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import type { SearchIntent } from './parseSearchQuery';

/** Receipt-presence marker stripped before passing to Sequelize. */
export interface SearchWhereOutput {
  /** Sequelize where ready for Transaction.findAll/count. */
  where: WhereOptions;
  /** When 'has', the route should INNER-JOIN receipts. When 'none', the
   * route should LEFT JOIN and filter receipts.id IS NULL. When undefined,
   * no receipt filter. */
  hasReceipt?: 'has' | 'none';
}

export function buildSearchWhere(
  intent: SearchIntent,
  visibilityWhere: WhereOptions,
): SearchWhereOutput {
  const where: Record<string, unknown> = { ...(visibilityWhere as Record<string, unknown>) };

  if (intent.merchant) {
    where.merchantClean = { [Op.like]: `%${intent.merchant}%` };
  }

  if (intent.category) {
    where.finalCategory = intent.category;
  }

  if (intent.amount) {
    // Cast amount to absolute value? No — the column stores signed amount
    // (negative = spend), and a user typing `amount:>100` typically means
    // "the absolute amount is over 100". We compare on the absolute value
    // via Sequelize literal so refunds and spends match symmetrically.
    // Note: in Sequelize, `Op.gt` etc. compare the column directly. Since
    // most spends are negative we use the magnitude semantic: a user query
    // `amount:>100` → |amount| > 100. Implemented as two-sided where: the
    // column is < -value OR > value.
    const a = intent.amount;
    const conditions: Array<Record<string | symbol, unknown>> = [];
    if (a.op !== undefined && a.value !== undefined) {
      const v = a.value;
      switch (a.op) {
        case '=':
          conditions.push({ [Op.or]: [{ [Op.eq]: v }, { [Op.eq]: -v }] });
          break;
        case '>':
          // |x| > v ⇔ x > v OR x < -v
          conditions.push({ [Op.or]: [{ [Op.gt]: v }, { [Op.lt]: -v }] });
          break;
        case '<':
          // |x| < v ⇔ -v < x AND x < v
          conditions.push({ [Op.and]: [{ [Op.gt]: -v }, { [Op.lt]: v }] });
          break;
        case '>=':
          conditions.push({ [Op.or]: [{ [Op.gte]: v }, { [Op.lte]: -v }] });
          break;
        case '<=':
          conditions.push({ [Op.and]: [{ [Op.gte]: -v }, { [Op.lte]: v }] });
          break;
      }
    } else if (a.min !== undefined || a.max !== undefined) {
      // Range form: min ≤ |x| ≤ max
      const min = a.min;
      const max = a.max;
      const positiveBound: Record<symbol, number> = {};
      const negativeBound: Record<symbol, number> = {};
      if (min !== undefined) {
        positiveBound[Op.gte] = min;
        negativeBound[Op.lte] = -min;
      }
      if (max !== undefined) {
        positiveBound[Op.lte] = max;
        negativeBound[Op.gte] = -max;
      }
      conditions.push({ [Op.or]: [positiveBound, negativeBound] });
    }
    if (conditions.length > 0) {
      where.amount = conditions.length === 1 ? conditions[0] : { [Op.and]: conditions };
    }
  }

  if (intent.dateFrom || intent.dateTo) {
    const dateCond: Record<symbol, string> = {};
    if (intent.dateFrom) dateCond[Op.gte] = intent.dateFrom;
    if (intent.dateTo) dateCond[Op.lte] = intent.dateTo;
    where.date = dateCond;
  }

  if (intent.review === 'yes') where.reviewFlag = true;
  if (intent.review === 'no') where.reviewFlag = false;

  if (intent.recurring === 'yes') where.isRecurring = true;
  if (intent.recurring === 'no') where.isRecurring = false;

  if (intent.scope === 'business') {
    where.finalBusiness = true;
  } else if (intent.scope === 'personal') {
    where.finalBusiness = false;
  } else if (intent.scope === 'partner') {
    // Partner-touched lanes: my-split is anything except 'me'-only.
    where.finalSplitType = { [Op.in]: ['partner', 'shared'] };
  } else if (intent.scope === 'recurring') {
    where.isRecurring = true;
  }

  if (intent.freeText) {
    // OR-match across merchantClean, notes, finalCategory.
    const like = { [Op.like]: `%${intent.freeText}%` };
    where[Op.or as unknown as string] = [
      { merchantClean: like },
      { notes: like },
      { finalCategory: like },
    ];
  }

  return { where: where as WhereOptions, hasReceipt: intent.hasReceipt };
}

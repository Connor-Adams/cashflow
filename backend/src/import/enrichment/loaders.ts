import { QueryTypes } from 'sequelize';
import { sequelize, Account, ExternalOrder, ExternalOrderItem } from '../../models';
import type { ExternalOrderItem as ExternalOrderItemType } from '../../models/ExternalOrderItem';
import type { LinkItemsCandidateOrder } from './linkItemsStage';
import type { RecurringHistoryRow } from './detectRecurringStage';
import type { RelationshipCandidate } from './detectRelationshipsStage';

export async function loadAmazonOrdersCache(householdId: number | null): Promise<LinkItemsCandidateOrder[]> {
  const orders = await ExternalOrder.findAll({
    where: householdId != null ? { householdId, vendor: 'amazon' } : { vendor: 'amazon' },
    include: [{ model: ExternalOrderItem, as: 'items' }],
  });
  return orders.map((o) => ({
    id: o.id,
    total: Number(o.total ?? 0),
    orderDate: o.orderDate ?? '',
    shipmentDate: o.shipmentDate,
    paymentLast4: o.paymentLast4,
    items: ((o as unknown as { items?: ExternalOrderItemType[] }).items ?? []).map((it) => ({
      id: it.id,
      title: it.title,
      totalPrice: it.totalPrice,
      inferredCategory: it.inferredCategory,
      businessUsePercent: it.businessUsePercent,
    })),
  }));
}

export async function loadHouseholdAccountIds(accountId: number, householdId: number | null): Promise<number[]> {
  const rows = await Account.findAll({
    where: householdId != null ? { householdId } : { id: accountId },
    attributes: ['id'],
  });
  const ids = rows.map((r) => r.id);
  if (!ids.includes(accountId)) ids.push(accountId);
  return ids;
}

export async function loadRecurringHistory(
  householdId: number | null,
  merchantClean: string,
  beforeDate: string,
): Promise<RecurringHistoryRow[]> {
  if (!merchantClean) return [];
  const rows = await sequelize.query<{ date: string; amount: number; finalCategory: string | null }>(
    `SELECT date, CAST(amount AS REAL) AS amount, final_category AS "finalCategory"
       FROM transactions
       WHERE (? IS NULL OR household_id = ?)
         AND LOWER(merchant_clean) = LOWER(?)
         AND date < ?
       ORDER BY date DESC LIMIT 12`,
    {
      replacements: [householdId, householdId, merchantClean, beforeDate],
      type: QueryTypes.SELECT,
    },
  );
  return rows.map((r) => ({ date: r.date, amount: Number(r.amount), finalCategory: r.finalCategory }));
}

export async function loadRelationshipCandidates(
  householdId: number | null,
  householdAccountIds: number[],
  merchantClean: string,
  date: string,
  refundWindowDays: number,
): Promise<RelationshipCandidate[]> {
  if (householdAccountIds.length === 0) return [];
  const placeholders = householdAccountIds.map(() => '?').join(',');
  const rows = await sequelize.query<{
    id: number;
    accountId: number;
    amount: number;
    date: string;
    merchantClean: string;
    finalCategory: string | null;
    finalBusiness: number;
  }>(
    `SELECT id, account_id AS "accountId", CAST(amount AS REAL) AS amount, date,
            merchant_clean AS "merchantClean", final_category AS "finalCategory",
            final_business AS "finalBusiness"
       FROM transactions
       WHERE account_id IN (${placeholders})
         AND ABS(julianday(?) - julianday(date)) <= ?
         AND (merchant_clean = ? OR (? IS NULL OR household_id = ?))`,
    {
      replacements: [...householdAccountIds, date, refundWindowDays, merchantClean, householdId, householdId],
      type: QueryTypes.SELECT,
    },
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    amount: Number(r.amount),
    date: r.date,
    merchantClean: r.merchantClean,
    finalCategory: r.finalCategory,
    finalBusiness: Boolean(r.finalBusiness),
  }));
}

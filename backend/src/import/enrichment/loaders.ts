import { QueryTypes, type Transaction as SequelizeTransaction } from 'sequelize';
import { sequelize, Account, ExternalOrder, ExternalOrderItem, HouseholdMember, User, Contact } from '../../models';
import type { ExternalOrderItem as ExternalOrderItemType } from '../../models/ExternalOrderItem';
import type { LinkItemsCandidateOrder } from './linkItemsStage';
import type { RecurringHistoryRow } from './detectRecurringStage';
import type { RelationshipCandidate } from './detectRelationshipsStage';

/**
 * Loads all external orders (any vendor) so the link-items stage can match
 * by vendor inside the pipeline. Previously Amazon-only; now generalised so
 * Apple/Google receipts work too.
 */
export async function loadExternalOrdersCache(householdId: number | null): Promise<LinkItemsCandidateOrder[]> {
  const orders = await ExternalOrder.findAll({
    where: householdId != null ? { householdId } : undefined,
    include: [{ model: ExternalOrderItem, as: 'items' }],
  });
  return orders.map((o) => ({
    id: o.id,
    vendor: o.vendor,
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

/** Backward-compat alias used by older call sites. Prefer loadExternalOrdersCache. */
export const loadAmazonOrdersCache = loadExternalOrdersCache;

export async function loadHouseholdAccountIds(accountId: number, householdId: number | null): Promise<number[]> {
  const rows = await Account.findAll({
    where: householdId != null ? { householdId } : { id: accountId },
    attributes: ['id'],
  });
  const ids = rows.map((r) => r.id);
  if (!ids.includes(accountId)) ids.push(accountId);
  return ids;
}

/**
 * Owner-side names for a household: the display names of its member Users PLUS
 * the names of any partner Contacts (contacts.is_partner). Fed to the detect-type
 * stage so an external payroll direct deposit (income) is told apart from a
 * self-deposit made under an owner's or partner's own name (transfer). Returns []
 * when the household is unknown or has no members/partners.
 */
export async function loadHouseholdOwnerNames(householdId: number | null): Promise<string[]> {
  if (householdId == null) return [];
  const members = await HouseholdMember.findAll({
    where: { householdId },
    attributes: ['userId'],
  });
  const userIds = members.map((m) => m.userId);
  const users = userIds.length
    ? await User.findAll({ where: { id: userIds }, attributes: ['displayName'] })
    : [];
  // Partners modelled as a Contact (contacts.is_partner) are household-internal:
  // a "direct deposit from <partner>" is a self/internal transfer, not external
  // income. Include their names so the own-name exclusion covers partners too.
  const partnerContacts = await Contact.findAll({
    where: { householdId, isPartner: true },
    attributes: ['name'],
  });
  const names = [
    ...users.map((u) => u.displayName),
    ...partnerContacts.map((c) => c.name),
  ].filter((n): n is string => Boolean(n));
  return Array.from(new Set(names));
}

export async function loadRecurringHistory(
  householdId: number | null,
  merchantClean: string,
  beforeDate: string,
  /**
   * Thread the import transaction when calling from inside one: on Postgres a
   * raw query without it runs on a separate pooled connection and cannot see
   * rows inserted earlier in the same import (READ COMMITTED).
   */
  transaction?: SequelizeTransaction,
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
      transaction,
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
  /** Same rationale as loadRecurringHistory — see its doc comment. */
  transaction?: SequelizeTransaction,
): Promise<RelationshipCandidate[]> {
  if (householdAccountIds.length === 0) return [];
  const windowStart = new Date(`${date}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - refundWindowDays);
  const windowEnd = new Date(`${date}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + refundWindowDays);
  const windowStartStr = windowStart.toISOString().slice(0, 10);
  const windowEndStr = windowEnd.toISOString().slice(0, 10);
  // The merchant filter must always apply; only the household-OR-leg is
  // conditional. Previously the entire clause was dropped when householdId
  // was null, returning every transaction in the account+date window
  // regardless of merchant.
  //
  // LOWER(...) on both sides mirrors loadRecurringHistory — normalizeMerchant
  // preserves input case, so historical rows can have mixed-case
  // merchant_clean values that a strict `=` would silently skip.
  const householdClause = householdId != null
    ? `AND (LOWER(merchant_clean) = LOWER(?) OR household_id = ?)`
    : `AND LOWER(merchant_clean) = LOWER(?)`;
  const householdReplacements = householdId != null
    ? [merchantClean, householdId]
    : [merchantClean];
  const placeholders = householdAccountIds.map(() => '?').join(',');
  // alreadyLinkedByRefundId is computed in a correlated subquery: for each
  // candidate row that's a NEGATIVE-amount purchase, look for an existing
  // refund row whose linked_transaction_id points back at it. The detector
  // uses this to avoid auto-linking the same original to a second refund.
  const rows = await sequelize.query<{
    id: number;
    accountId: number;
    amount: number;
    date: string;
    merchantClean: string;
    merchantCanonical: string | null;
    finalCategory: string | null;
    finalBusiness: number;
    sourceReference: string | null;
    alreadyLinkedByRefundId: number | null;
  }>(
    `SELECT t.id, t.account_id AS "accountId", CAST(t.amount AS REAL) AS amount, t.date,
            t.merchant_clean AS "merchantClean",
            t.merchant_canonical AS "merchantCanonical",
            t.final_category AS "finalCategory",
            t.final_business AS "finalBusiness",
            t.source_reference AS "sourceReference",
            (SELECT r.id FROM transactions r
              WHERE r.linked_transaction_id = t.id
                AND r.txn_type = 'refund'
              LIMIT 1) AS "alreadyLinkedByRefundId"
       FROM transactions t
       WHERE t.account_id IN (${placeholders})
         AND t.date BETWEEN ? AND ?
         ${householdClause}`,
    {
      replacements: [...householdAccountIds, windowStartStr, windowEndStr, ...householdReplacements],
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    amount: Number(r.amount),
    date: r.date,
    merchantClean: r.merchantClean,
    merchantCanonical: r.merchantCanonical ?? null,
    finalCategory: r.finalCategory,
    finalBusiness: Boolean(r.finalBusiness),
    sourceReference: r.sourceReference ?? null,
    alreadyLinkedByRefundId: r.alreadyLinkedByRefundId ?? null,
  }));
}

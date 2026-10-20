import type { Request } from 'express';
import { Op } from 'sequelize';
import { sequelize, Contact, PartnerSettlement, Transaction } from '../models';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import {
  applySettlements,
  resolveSolePartnerId,
  summarizeSettlements,
  type PartnerSettlementResult,
  type RawPartnerRow,
  type RawSettlementRow,
} from './partnerMath';

export type PartnerBalanceFilters = {
  /** Inclusive lower bound on transaction date and settlement settledDate. */
  dateFrom?: string;
  /** Inclusive upper bound on transaction date and settlement settledDate. */
  dateTo?: string;
  /** ISO currency code; restricts both transactions and settlements. */
  currency?: string;
};

/**
 * The household's partner balance: split spend grouped per
 * (currency, ownershipType, ownershipContactId), attributed and netted against
 * settlements by `partnerMath.applySettlements`.
 *
 * This is the single loader behind the Reports partner card
 * (`GET /api/summary/partner`) and the AI `partner_balance` answer, so the two
 * can never disagree on attribution (an unstamped split belongs to the sole
 * partner) or on settlement matching (an unmatched settlement is surfaced in
 * `unmatchedSettlements`, never folded into a balance).
 */
export async function loadPartnerBalance(
  req: Request,
  filters: PartnerBalanceFilters = {},
): Promise<PartnerSettlementResult> {
  const txnWhere: Record<string, unknown> = { ...visibleTransactionWhere(req) };
  // The settledDate window mirrors the transaction date window so closing out
  // an old debt outside the range doesn't leak into a narrow report.
  const settlementWhere: Record<string, unknown> = { ...householdWhere(req) };
  if (filters.dateFrom || filters.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (filters.dateFrom) dateCond[Op.gte] = filters.dateFrom;
    if (filters.dateTo) dateCond[Op.lte] = filters.dateTo;
    txnWhere.date = dateCond;
    settlementWhere.settledDate = dateCond;
  }
  if (filters.currency) {
    const currency = filters.currency.toUpperCase().slice(0, 3);
    txnWhere.currency = currency;
    settlementWhere.currency = currency;
  }

  const [rows, contacts, settlementRows] = await Promise.all([
    Transaction.findAll({
      where: txnWhere,
      attributes: [
        'currency',
        'ownershipType',
        'ownershipContactId',
        [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'sumMy'],
        [sequelize.fn('SUM', sequelize.col('partner_share_amount')), 'sumPartner'],
      ],
      group: ['currency', 'ownershipType', 'ownershipContactId'],
      raw: true,
    }),
    Contact.findAll({
      where: householdWhere(req),
      attributes: ['id', 'name', 'isPartner'],
      raw: true,
    }),
    PartnerSettlement.findAll({
      where: settlementWhere,
      attributes: ['contactId', 'currency', 'direction', 'amount'],
      raw: true,
    }),
  ]);

  type PartnerRow = {
    currency: string;
    ownershipType: string;
    ownershipContactId: number | null;
    sumMy: unknown;
    sumPartner: unknown;
  };
  type ContactRow = { id: number; name: string; isPartner: boolean | number };
  const typedContacts = contacts as unknown as ContactRow[];
  const contactNames = new Map(typedContacts.map((c) => [c.id, c.name]));
  const solePartnerId = resolveSolePartnerId(
    typedContacts.filter((c) => Boolean(c.isPartner)).map((c) => c.id),
  );

  const rawRows: RawPartnerRow[] = (rows as unknown as PartnerRow[]).map((r) => ({
    currency: r.currency,
    ownershipType: r.ownershipType,
    ownershipContactId: r.ownershipContactId,
    contactName:
      r.ownershipContactId != null ? contactNames.get(r.ownershipContactId) ?? null : null,
    sumMy: num(r.sumMy),
    sumPartner: num(r.sumPartner),
  }));

  return applySettlements(
    rawRows,
    summarizeSettlements(settlementRows as unknown as RawSettlementRow[]),
    { solePartnerId, contactNames },
  );
}

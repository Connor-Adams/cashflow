import { Router } from 'express';
import { ExternalOrder, ExternalOrderItem, Receipt, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import type { ItemRow, ItemsListResponse } from '../../../shared/api-types';

const router = Router();

function num(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function effectiveCategory(item: ExternalOrderItem): string | null {
  return item.categoryOverride ?? item.inferredCategory;
}

function effectiveBusinessUse(item: ExternalOrderItem): boolean {
  const raw = item.businessUseOverride ?? item.businessUsePercent;
  if (raw == null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

router.get('/items', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const txnWhere = visibleTransactionWhere(req);

    const items = await ExternalOrderItem.findAll({
      include: [
        {
          model: ExternalOrder,
          as: 'order',
          required: true,
          where: { householdId: household.id },
          include: [
            {
              model: Receipt,
              as: 'receipts',
              required: true,
              include: [
                {
                  model: Transaction,
                  as: 'transaction',
                  required: true,
                  where: txnWhere,
                },
              ],
            },
          ],
        },
      ],
      order: [['id', 'ASC']],
      limit: 50,
      subQuery: false,
    });

    const rows: ItemRow[] = items.map((it) => {
      const order = (it as ExternalOrderItem & { order?: ExternalOrder }).order!;
      const receipts = (order as ExternalOrder & { receipts?: Receipt[] }).receipts ?? [];
      const receipt = receipts[0];
      const txn = (receipt as Receipt & { transaction?: Transaction })?.transaction;
      return {
        id: it.id,
        title: it.title,
        qty: it.quantity,
        unitPrice: num(it.unitPrice),
        totalPrice: num(it.totalPrice),
        taxShare: 0,
        categoryEffective: effectiveCategory(it),
        categoryOverride: it.categoryOverride,
        businessUseEffective: effectiveBusinessUse(it),
        businessUseOverride:
          it.businessUseOverride == null ? null : Number(it.businessUseOverride) > 0,
        order: { id: order.id, vendor: order.vendor },
        receipt: {
          id: receipt?.id ?? 0,
          date: txn?.date ?? null,
          sourceTxnId: txn?.id ?? null,
        },
      };
    });

    const body: ItemsListResponse = { items: rows, nextCursor: null };
    res.json(body);
  } catch (e) {
    next(e);
  }
});

export default router;

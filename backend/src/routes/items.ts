import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import type { Request } from 'express';
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

type Filters = {
  category?: string;
  businessUse?: string;
  from?: string;
  to?: string;
  vendor?: string;
  minPrice?: number;
  maxPrice?: number;
  q?: string;
};

type Cursor = { itemId: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { itemId?: unknown };
    if (typeof obj.itemId === 'number') return { itemId: obj.itemId };
  } catch {
    /* fall through */
  }
  return null;
}

function parseFilters(req: Request): Filters {
  const q = req.query;
  const str = (k: string): string | undefined => {
    const v = q[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const numQ = (k: string): number | undefined => {
    const v = str(k);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    category: str('category'),
    businessUse: str('businessUse'),
    from: str('from'),
    to: str('to'),
    vendor: str('vendor'),
    minPrice: numQ('minPrice'),
    maxPrice: numQ('maxPrice'),
    q: str('q'),
  };
}

function buildItemWhere(f: Filters): WhereOptions {
  const and: WhereOptions[] = [];
  if (f.q) {
    and.push({ title: { [Op.like]: `%${f.q}%` } });
  }
  if (f.minPrice != null || f.maxPrice != null) {
    const priceCond: Record<symbol, number> = {};
    if (f.minPrice != null) priceCond[Op.gte] = f.minPrice;
    if (f.maxPrice != null) priceCond[Op.lte] = f.maxPrice;
    and.push({ totalPrice: priceCond as never });
  }
  if (f.category) {
    and.push({
      [Op.or]: [
        { categoryOverride: f.category },
        { categoryOverride: null, inferredCategory: f.category },
      ],
    });
  }
  if (f.businessUse === 'true') {
    and.push({
      [Op.or]: [
        {
          [Op.and]: [
            { businessUseOverride: { [Op.ne]: null } },
            { businessUseOverride: { [Op.ne]: '0' } },
          ],
        },
        {
          [Op.and]: [
            { businessUseOverride: null },
            { businessUsePercent: { [Op.ne]: null } },
            { businessUsePercent: { [Op.ne]: '0' } },
          ],
        },
      ],
    });
  } else if (f.businessUse === 'false') {
    and.push({
      [Op.or]: [
        { businessUseOverride: '0' },
        {
          [Op.and]: [
            { businessUseOverride: null },
            { [Op.or]: [{ businessUsePercent: null }, { businessUsePercent: '0' }] },
          ],
        },
      ],
    });
  }
  return and.length > 0 ? { [Op.and]: and } : {};
}

router.get('/items', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const txnWhere = visibleTransactionWhere(req);

    const f = parseFilters(req);
    const itemWhere = buildItemWhere(f);

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const cursor = decodeCursor(typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
    if (cursor) {
      (itemWhere as Record<string, unknown>)[Op.and as never] = [
        ...(((itemWhere as Record<symbol, unknown>)[Op.and] as unknown[]) ?? []),
        { id: { [Op.gt]: cursor.itemId } },
      ];
    }

    const orderWhere: WhereOptions = { householdId: household.id };
    if (f.vendor) {
      (orderWhere as Record<string, unknown>).vendor = {
        [Op.like]: `%${f.vendor.toLowerCase()}%`,
      };
    }

    const txnWhereWithDate: WhereOptions = { ...(txnWhere as object) };
    if (f.from || f.to) {
      const dateCond: Record<symbol, string> = {};
      if (f.from) dateCond[Op.gte] = f.from;
      if (f.to) dateCond[Op.lte] = f.to;
      (txnWhereWithDate as Record<string, unknown>).date = dateCond;
    }

    const items = await ExternalOrderItem.findAll({
      where: itemWhere,
      include: [
        {
          model: ExternalOrder,
          as: 'order',
          required: true,
          where: orderWhere,
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
                  where: txnWhereWithDate,
                },
              ],
            },
          ],
        },
      ],
      order: [['id', 'ASC']],
      limit: limit + 1,
      subQuery: false,
    });

    const hasMore = items.length > limit;
    const sliced = hasMore ? items.slice(0, limit) : items;

    const rows: ItemRow[] = sliced.map((it) => {
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

    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ itemId: last.id }) : null;
    const body: ItemsListResponse = { items: rows, nextCursor };
    res.json(body);
  } catch (e) {
    next(e);
  }
});

export default router;

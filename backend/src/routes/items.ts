import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import type { Request } from 'express';
import { ExternalOrder, ExternalOrderItem, Receipt, Transaction, sequelize } from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import type { ItemRow, ItemsListResponse } from '@cashflow/shared';

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

function mapItemToRow(it: ExternalOrderItem): ItemRow {
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
    currency: (order.currency ?? 'CAD').toUpperCase(),
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
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: ItemRow[]): string {
  const header = 'id,date,vendor,title,qty,unitPrice,totalPrice,categoryEffective,businessUseEffective';
  const lines = rows.map((r) =>
    [
      r.id,
      r.receipt.date ?? '',
      r.order.vendor,
      csvEscape(r.title),
      r.qty,
      r.unitPrice ?? '',
      r.totalPrice ?? '',
      csvEscape(r.categoryEffective ?? ''),
      r.businessUseEffective ? 'true' : 'false',
    ].join(','),
  );
  return [header, ...lines].join('\n');
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

// GET /analyze — top items by spend, by-vendor breakdown
router.get('/items/analyze', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { from, to, currency: currencyFilter } = req.query as Record<string, string | undefined>;

    const orderWhere: Record<string, unknown> = { householdId: household.id };
    if (from) orderWhere.orderDate = { ...(orderWhere.orderDate as object ?? {}), [Op.gte]: from };
    if (to) orderWhere.orderDate = { ...(orderWhere.orderDate as object ?? {}), [Op.lte]: to };

    const items = await ExternalOrderItem.findAll({
      include: [
        {
          model: ExternalOrder,
          as: 'order',
          required: true,
          where: orderWhere,
          attributes: ['id', 'vendor', 'orderDate', 'currency'],
        },
      ],
      attributes: ['id', 'title', 'unitPrice', 'totalPrice', 'quantity'],
    });

    type OrderedItem = ExternalOrderItem & { order: ExternalOrder };

    // Group by currency; pick the most-used one
    const currencyMap = new Map<string, number>();
    for (const it of items as OrderedItem[]) {
      const cur = (it.order.currency ?? 'CAD').toUpperCase();
      currencyMap.set(cur, (currencyMap.get(cur) ?? 0) + 1);
    }
    const sortedCurrencies = [...currencyMap.entries()].sort((a, b) => b[1] - a[1]);
    const primaryCurrency = currencyFilter?.toUpperCase() ?? sortedCurrencies[0]?.[0] ?? 'CAD';
    const currencyOthers = sortedCurrencies
      .map(([c]) => c)
      .filter((c) => c !== primaryCurrency);

    const filtered = (items as OrderedItem[]).filter(
      (it) => (it.order.currency ?? 'CAD').toUpperCase() === primaryCurrency,
    );

    // Aggregate by title
    const byTitle = new Map<string, { totalCents: number; count: number; lastBoughtOn: string; vendor: string }>();
    for (const it of filtered) {
      const key = (it.title ?? '').toLowerCase().trim();
      const price = Number(it.totalPrice ?? it.unitPrice) * (it.totalPrice ? 1 : Number(it.quantity ?? 1));
      const cents = Math.round((isFinite(price) ? price : 0) * 100);
      const date = it.order.orderDate ?? '';
      const existing = byTitle.get(key)
      if (existing) {
        existing.totalCents += cents;
        existing.count++;
        if (date > existing.lastBoughtOn) existing.lastBoughtOn = date;
      } else {
        byTitle.set(key, { totalCents: cents, count: 1, lastBoughtOn: date, vendor: it.order.vendor ?? '' });
      }
    }

    const topItems = [...byTitle.entries()]
      .sort((a, b) => b[1].totalCents - a[1].totalCents)
      .slice(0, 50)
      .map(([name, v]) => ({
        name: name.slice(0, 1).toUpperCase() + name.slice(1),
        vendor: v.vendor,
        totalCents: v.totalCents,
        count: v.count,
        lastBoughtOn: v.lastBoughtOn || null,
      }));

    // By vendor (top 10 + Other)
    const byVendor = new Map<string, number>();
    for (const it of filtered) {
      const vendor = (it.order.vendor ?? 'Unknown').trim();
      const price = Number(it.totalPrice ?? it.unitPrice) * (it.totalPrice ? 1 : Number(it.quantity ?? 1));
      const cents = Math.round((isFinite(price) ? price : 0) * 100);
      byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + cents);
    }
    const vendorsSorted = [...byVendor.entries()].sort((a, b) => b[1] - a[1]);
    const top10 = vendorsSorted.slice(0, 10);
    const otherCents = vendorsSorted.slice(10).reduce((s, [, v]) => s + v, 0);
    const byBrand = top10.map(([brand, totalCents]) => ({ brand, totalCents }));
    if (otherCents > 0) byBrand.push({ brand: 'Other', totalCents: otherCents });

    res.json({ topItems, byBrand, currencyUsed: primaryCurrency, currencyOthers });
  } catch (e) {
    next(e);
  }
});

// GET /items/analyze/trend — unit-price trend for a specific item+vendor
router.get('/items/analyze/trend', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { itemName, vendor: vendorFilter, from, to } = req.query as Record<string, string | undefined>;
    if (!itemName) {
      res.status(400).json({ error: 'INVALID_RANGE', message: 'itemName is required' });
      return;
    }

    const orderWhere: Record<string, unknown> = { householdId: household.id };
    if (from) orderWhere.orderDate = { ...(orderWhere.orderDate as object ?? {}), [Op.gte]: from };
    if (to) orderWhere.orderDate = { ...(orderWhere.orderDate as object ?? {}), [Op.lte]: to };
    if (vendorFilter) orderWhere.vendor = vendorFilter;

    const items = await ExternalOrderItem.findAll({
      where: { title: { [Op.like]: `%${itemName}%` } },
      include: [
        {
          model: ExternalOrder,
          as: 'order',
          required: true,
          where: orderWhere,
          attributes: ['id', 'vendor', 'orderDate', 'currency'],
        },
      ],
      attributes: ['id', 'title', 'unitPrice', 'totalPrice', 'quantity'],
      order: [[{ model: ExternalOrder, as: 'order' }, 'orderDate', 'ASC']],
    });

    type OrderedItem = ExternalOrderItem & { order: ExternalOrder };

    const points: Array<{ date: string; unitPriceCents: number }> = [];
    const units = new Set<string>();
    for (const it of items as OrderedItem[]) {
      const date = it.order.orderDate;
      if (!date) continue;
      const qty = Number(it.quantity ?? 1) || 1;
      const total = Number(it.totalPrice ?? null);
      const unit = Number(it.unitPrice ?? null);
      let unitPriceCents: number | null = null;
      if (isFinite(unit) && unit > 0) {
        unitPriceCents = Math.round(unit * 100);
      } else if (isFinite(total) && total > 0) {
        unitPriceCents = Math.round((total / qty) * 100);
      }
      if (unitPriceCents === null) continue;
      // Detect mixed units heuristically: different quantities on the same item name
      units.add(String(qty));
      points.push({ date, unitPriceCents });
    }

    const mixedUnits = units.size > 1;

    // Compute slope (linear regression, pct per year)
    let slopePerYear: number | null = null;
    if (points.length >= 3) {
      const xs = points.map((_p, i) => i);
      const ys = points.map((p) => p.unitPriceCents);
      const n = xs.length;
      const meanX = xs.reduce((s, x) => s + x, 0) / n;
      const meanY = ys.reduce((s, y) => s + y, 0) / n;
      const num2 = xs.reduce((s, x, i) => s + (x - meanX) * (ys[i] - meanY), 0);
      const den = xs.reduce((s, x) => s + (x - meanX) ** 2, 0);
      const slope = den !== 0 ? num2 / den : 0;
      // Convert: slope is per index. Rough assumption: ~12 indices per year (monthly rebuy)
      const indicesPerYear = Math.max(1, n / Math.max(1, (new Date(points[n-1].date).getFullYear() - new Date(points[0].date).getFullYear()) || 1));
      if (meanY !== 0) slopePerYear = (slope * indicesPerYear) / meanY;
    }

    res.json({ points, slopePerYear, mixedUnits });
  } catch (e) {
    next(e);
  }
});

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

    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (format === 'csv') {
      const maxRows = Number(process.env.ITEMS_CSV_MAX_ROWS ?? '50000');
      const allItems = await ExternalOrderItem.findAll({
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
        limit: maxRows + 1,
        subQuery: false,
      });
      if (allItems.length > maxRows) {
        res
          .status(413)
          .json({ error: `Result set too large (>${maxRows} items). Narrow your filters.` });
        return;
      }
      const csv = rowsToCsv(allItems.map(mapItemToRow));
      const filename = `items-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
      return;
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

    const rows: ItemRow[] = sliced.map(mapItemToRow);

    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ itemId: last.id }) : null;
    const body: ItemsListResponse = { items: rows, nextCursor };
    res.json(body);
  } catch (e) {
    next(e);
  }
});

router.get('/items/:id/allocation', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: 'invalid item id' });
      return;
    }

    const item = await ExternalOrderItem.findOne({
      where: { id: itemId },
      include: [
        { model: ExternalOrder, as: 'order', required: true, where: { householdId: household.id } },
      ],
    });
    if (!item) {
      res.status(403).json({ error: 'not found or not in scope' });
      return;
    }
    const order = (item as ExternalOrderItem & { order?: ExternalOrder }).order!;
    const itemTotal = Number(item.totalPrice ?? '0');
    const categoryBucket = item.categoryOverride ?? item.inferredCategory ?? null;

    const receipts = await Receipt.findAll({ where: { externalOrderId: order.id } });
    const linkedTxnIds = receipts.map((r) => r.transactionId).filter((v) => v != null);

    if (linkedTxnIds.length === 0) {
      res.json({
        itemId: item.id,
        itemTotal,
        allocatedTotal: null,
        categoryBucket,
        txnId: null,
        txnAmount: null,
        percentOfTxn: null,
        linkedTxnIds: [],
      });
      return;
    }

    const txnId = linkedTxnIds[0];
    const txn = await Transaction.findByPk(txnId);
    if (!txn) {
      res.json({
        itemId: item.id,
        itemTotal,
        allocatedTotal: null,
        categoryBucket,
        txnId: null,
        txnAmount: null,
        percentOfTxn: null,
        linkedTxnIds,
      });
      return;
    }

    const allItems = await ExternalOrderItem.findAll({ where: { externalOrderId: order.id } });
    const itemBase = (it: ExternalOrderItem): number =>
      it.totalPrice != null
        ? Number(it.totalPrice)
        : it.unitPrice != null
          ? Number(it.unitPrice) * (it.quantity || 1)
          : 0;
    const orderTotal = Number(order.total ?? '0');
    const linkAmt = orderTotal;
    const share = orderTotal > 0 ? linkAmt / orderTotal : 1;
    const baseSum = allItems.reduce((s, it) => s + itemBase(it), 0);
    const extras = (Number(order.tax ?? 0) + Number(order.shipping ?? 0)) * share;
    const rawBase = itemBase(item);
    const weight = baseSum > 0 ? rawBase / baseSum : 0;
    const allocated =
      baseSum > 0 ? rawBase * share + extras * weight : linkAmt / Math.max(allItems.length, 1);

    const txnAmount = Math.abs(Number(txn.amount));
    res.json({
      itemId: item.id,
      itemTotal,
      allocatedTotal: Math.round(allocated * 100) / 100,
      categoryBucket: categoryBucket ?? txn.finalCategory ?? null,
      txnId: txn.id,
      txnAmount,
      percentOfTxn: txnAmount > 0 ? Math.round((allocated / txnAmount) * 1000) / 10 : null,
      linkedTxnIds,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/external-order-items/bulk-patch', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = req.body as {
      itemIds?: unknown;
      categoryOverride?: unknown;
      businessUseOverride?: unknown;
    };
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
      res.status(400).json({ error: 'itemIds must be a non-empty array' });
      return;
    }
    if (body.itemIds.length > 200) {
      res.status(400).json({ error: 'cannot update more than 200 items at once' });
      return;
    }
    const ids = body.itemIds.map(Number).filter((n) => Number.isFinite(n));
    if (ids.length !== body.itemIds.length) {
      res.status(400).json({ error: 'itemIds must all be numbers' });
      return;
    }

    const patch: { categoryOverride?: string | null; businessUseOverride?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'categoryOverride')) {
      const v = body.categoryOverride;
      if (v !== null && typeof v !== 'string') {
        res.status(400).json({ error: 'categoryOverride must be string or null' });
        return;
      }
      patch.categoryOverride = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'businessUseOverride')) {
      const v = body.businessUseOverride;
      if (v !== null && typeof v !== 'boolean') {
        res.status(400).json({ error: 'businessUseOverride must be boolean or null' });
        return;
      }
      patch.businessUseOverride = v === null ? null : v ? '100' : '0';
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'no fields to patch' });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const found = await ExternalOrderItem.findAll({
        where: { id: ids },
        include: [
          { model: ExternalOrder, as: 'order', required: true, where: { householdId: household.id } },
        ],
        transaction: t,
      });
      if (found.length !== ids.length) {
        const err = new Error('one or more items not found or not in scope') as Error & {
          status?: number;
        };
        err.status = 403;
        throw err;
      }
      let updated = 0;
      for (const it of found) {
        await it.update(patch, { transaction: t });
        updated += 1;
      }
      return updated;
    });

    res.json({ updated: result });
  } catch (e) {
    next(e);
  }
});

export default router;

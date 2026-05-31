import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem, Receipt, Transaction } from '../models';
import type { WhereOptions } from 'sequelize';

export type AnalyzeFilters = {
  householdId: number;
  txnWhere: WhereOptions;
  from?: string;
  to?: string;
  vendors?: string[];
  categories?: string[];
};

export type TopItem = {
  name: string;
  brand: string;
  totalCents: number;
  count: number;
  lastBoughtOn: string;
};

export type BrandSpend = {
  brand: string;
  totalCents: number;
};

export type AnalyzeResult = {
  topItems: TopItem[];
  byBrand: BrandSpend[];
  currencyUsed: string;
  currencyOthers: string[];
};

export type TrendPoint = {
  date: string;
  unitPriceCents: number;
};

export type TrendResult = {
  points: TrendPoint[];
  slopePerYear: number | null;
  mixedUnits: boolean;
};

function effectiveCategory(item: ExternalOrderItem): string | null {
  return item.categoryOverride ?? item.inferredCategory;
}

/** Simple linear regression — returns slope (Y-units per X-unit) or null if <2 points */
function linearSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

async function fetchItems(f: AnalyzeFilters): Promise<
  Array<{
    title: string;
    vendor: string;
    unitPrice: number | null;
    totalPrice: number | null;
    quantity: number;
    category: string | null;
    date: string;
    currency: string;
  }>
> {
  const itemWhere: WhereOptions = {};
  if (f.categories && f.categories.length > 0) {
    (itemWhere as Record<string, unknown>)[Op.or as never] = f.categories.map((c) => ({
      [Op.or]: [{ categoryOverride: c }, { categoryOverride: null, inferredCategory: c }],
    }));
  }

  const orderWhere: WhereOptions = { householdId: f.householdId };
  if (f.vendors && f.vendors.length > 0) {
    (orderWhere as Record<string, unknown>).vendor = { [Op.in]: f.vendors };
  }

  const txnWhere: Record<string, unknown> = { ...(f.txnWhere as object) };
  if (f.from || f.to) {
    const dateCond: Record<symbol, string> = {};
    if (f.from) dateCond[Op.gte] = f.from;
    if (f.to) dateCond[Op.lte] = f.to;
    txnWhere.date = dateCond;
  }

  const rows = await ExternalOrderItem.findAll({
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
                where: txnWhere as WhereOptions,
              },
            ],
          },
        ],
      },
    ],
    order: [['id', 'ASC']],
    limit: 20000,
    subQuery: false,
  });

  return rows.map((it) => {
    const order = (it as ExternalOrderItem & { order?: ExternalOrder }).order!;
    const receipts = (order as ExternalOrder & { receipts?: Receipt[] }).receipts ?? [];
    const txn = (receipts[0] as Receipt & { transaction?: Transaction })?.transaction;
    return {
      title: it.title,
      vendor: order.vendor,
      unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null,
      totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
      quantity: it.quantity || 1,
      category: effectiveCategory(it),
      date: txn?.date ?? order.orderDate ?? '',
      currency: txn?.currency ?? order.currency ?? 'CAD',
    };
  });
}

/** Pick the majority currency; returns [primary, others] */
function pickCurrency(
  rows: Array<{ currency: string }>,
): [string, string[]] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  }
  if (counts.size === 0) return ['CAD', []];
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]![0];
  const others = sorted.slice(1).map(([c]) => c);
  return [primary, others];
}

export async function analyzeItems(f: AnalyzeFilters): Promise<AnalyzeResult> {
  const rows = await fetchItems(f);
  if (rows.length === 0) {
    return { topItems: [], byBrand: [], currencyUsed: 'CAD', currencyOthers: [] };
  }

  const [currencyUsed, currencyOthers] = pickCurrency(rows);
  const scoped = rows.filter((r) => r.currency === currencyUsed);

  // Top items: group by (title, vendor)
  const itemMap = new Map<
    string,
    { name: string; brand: string; totalCents: number; count: number; lastBoughtOn: string }
  >();
  for (const r of scoped) {
    const key = `${r.title}|||${r.vendor}`;
    const cents = r.totalPrice != null
      ? Math.round(r.totalPrice * 100)
      : r.unitPrice != null
        ? Math.round(r.unitPrice * r.quantity * 100)
        : 0;
    const existing = itemMap.get(key);
    if (existing) {
      existing.totalCents += cents;
      existing.count += 1;
      if (r.date && r.date > existing.lastBoughtOn) existing.lastBoughtOn = r.date;
    } else {
      itemMap.set(key, {
        name: r.title,
        brand: r.vendor,
        totalCents: cents,
        count: 1,
        lastBoughtOn: r.date,
      });
    }
  }
  const topItems = [...itemMap.values()]
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 50);

  // By brand (vendor): group by vendor, top 10 + Other
  const brandMap = new Map<string, number>();
  for (const r of scoped) {
    const cents = r.totalPrice != null
      ? Math.round(r.totalPrice * 100)
      : r.unitPrice != null
        ? Math.round(r.unitPrice * r.quantity * 100)
        : 0;
    brandMap.set(r.vendor, (brandMap.get(r.vendor) ?? 0) + cents);
  }
  const sortedBrands = [...brandMap.entries()].sort((a, b) => b[1] - a[1]);
  const top10 = sortedBrands.slice(0, 10);
  const otherSum = sortedBrands.slice(10).reduce((s, [, v]) => s + v, 0);
  const byBrand: BrandSpend[] = top10.map(([brand, totalCents]) => ({ brand, totalCents }));
  if (otherSum > 0) byBrand.push({ brand: 'Other', totalCents: otherSum });

  return { topItems, byBrand, currencyUsed, currencyOthers };
}

export async function trendForItem(
  f: AnalyzeFilters & { itemName: string; brand: string },
): Promise<TrendResult> {
  const rows = await fetchItems({ ...f, vendors: [f.brand] });
  const matched = rows.filter(
    (r) => r.title === f.itemName && r.vendor === f.brand && r.unitPrice != null && r.date,
  );

  matched.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Detect mixed quantities (different quantities at different times)
  const quantities = new Set(matched.map((r) => r.quantity));
  const mixedUnits = quantities.size > 1;

  const points: TrendPoint[] = matched.map((r) => ({
    date: r.date,
    unitPriceCents: Math.round(r.unitPrice! * 100),
  }));

  let slopePerYear: number | null = null;
  if (points.length >= 2) {
    const t0 = new Date(points[0]!.date).getTime();
    const xs = points.map((p) => (new Date(p.date).getTime() - t0) / 86400000); // days
    const ys = points.map((p) => p.unitPriceCents);
    const slopePerDay = linearSlope(xs, ys);
    if (slopePerDay != null) {
      const basePrice = ys[0]!;
      // Fraction change per year relative to first price
      slopePerYear = basePrice > 0 ? (slopePerDay * 365) / basePrice : null;
    }
  }

  return { points, slopePerYear, mixedUnits };
}

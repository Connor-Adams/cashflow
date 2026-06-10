/**
 * Heuristic parser for vendor purchase-history CSVs (Apple's
 * report-a-problem export, Google Pay / Takeout exports, etc.).
 *
 * Approach: map column headers by case-insensitive substring match to known
 * roles (date, title, amount, order id, currency, last4). Each row becomes
 * one ExtractedReceiptOrder containing one item. Caller (the route) is
 * responsible for persisting and deduping.
 */
import { parseCsvRecords } from './csvParse';
import { parseDateFlexible } from './parseDateFlexible';
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';

type ColumnRole =
  | 'date'
  | 'title'
  | 'subtitle'
  | 'amount'
  | 'orderId'
  | 'currency'
  | 'last4'
  | 'category';

const COLUMN_HINTS: Array<{ role: ColumnRole; patterns: RegExp[] }> = [
  {
    role: 'date',
    patterns: [
      /^purchase\s*date$/i,
      /^order\s*date$/i,
      /^transaction\s*date$/i,
      /^charged?\s*on$/i,
      /^date$/i,
      /\bdate\b/i,
    ],
  },
  {
    role: 'title',
    patterns: [
      /^item\s*description$/i,
      /^description$/i,
      /^product$/i,
      /^app\s*name$/i,
      /^item$/i,
      /^title$/i,
      /^content\s*name$/i,
    ],
  },
  {
    role: 'subtitle',
    patterns: [/^developer$/i, /^publisher$/i, /^artist$/i, /^author$/i, /^vendor\s*name$/i],
  },
  {
    role: 'amount',
    patterns: [
      /^amount\s*\(.*\)$/i,
      /^cost$/i,
      /^price$/i,
      /^item\s*cost$/i,
      /^order\s*total$/i,
      /^amount$/i,
      /^total$/i,
      /^proceeds$/i,
    ],
  },
  {
    role: 'orderId',
    patterns: [
      /^order\s*id$/i,
      /^reference\s*number$/i,
      /^transaction\s*id$/i,
      /^order\s*number$/i,
      /^document\s*no\.?$/i,
    ],
  },
  {
    role: 'currency',
    patterns: [/^currency$/i, /^iso\s*currency$/i, /^currency\s*code$/i],
  },
  {
    role: 'last4',
    patterns: [/last\s*4/i, /card\s*last/i],
  },
  {
    role: 'category',
    patterns: [/^category$/i, /^product\s*type$/i, /^content\s*type$/i],
  },
];

function classifyColumn(header: string): ColumnRole | null {
  for (const { role, patterns } of COLUMN_HINTS) {
    if (patterns.some((re) => re.test(header))) return role;
  }
  return null;
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  // Strip alphabetic currency prefixes ('CA$4.99', 'US$1.99', 'USD 5.99' in
  // Google Pay / Takeout exports) before commas and currency symbols.
  const trimmed = String(raw)
    .trim()
    .replace(/^[A-Za-z]{1,3}(?=[\s$])/, '')
    .replace(/[,$]/g, '')
    .trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = parseDateFlexible(raw);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type PurchaseHistoryParseResult = {
  vendor: ExtractedReceiptOrder['vendor'];
  totalRows: number;
  orders: ExtractedReceiptOrder[];
  unparsedRows: number;
  columnMapping: Record<string, ColumnRole>;
};

export interface ParsePurchaseHistoryOpts {
  vendor: ExtractedReceiptOrder['vendor'];
  /** Default currency when the CSV row doesn't carry one. */
  defaultCurrency?: string;
}

export function parsePurchaseHistoryCsv(
  text: string,
  opts: ParsePurchaseHistoryOpts,
): PurchaseHistoryParseResult {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) {
    return {
      vendor: opts.vendor,
      totalRows: 0,
      orders: [],
      unparsedRows: 0,
      columnMapping: {},
    };
  }
  const columnMapping: Record<string, ColumnRole> = {};
  for (const header of parsed.headers) {
    const role = classifyColumn(header);
    if (role) columnMapping[header] = role;
  }

  function pick(role: ColumnRole, row: Record<string, string>): string | undefined {
    for (const [header, mappedRole] of Object.entries(columnMapping)) {
      if (mappedRole === role) {
        const v = row[header];
        if (v != null && String(v).trim() !== '') return String(v);
      }
    }
    return undefined;
  }

  const orders: ExtractedReceiptOrder[] = [];
  let unparsed = 0;

  for (const row of parsed.records) {
    const title = pick('title', row);
    const amountStr = pick('amount', row);
    const dateStr = pick('date', row);
    const orderId = pick('orderId', row);
    const currency = pick('currency', row);
    const last4 = pick('last4', row);
    const category = pick('category', row);
    const subtitle = pick('subtitle', row);

    const totalNum = num(amountStr);
    const date = isoDate(dateStr);

    if (!title && totalNum == null) {
      unparsed++;
      continue;
    }

    const fullTitle = subtitle && title ? `${title} (${subtitle})` : title || '(unknown item)';

    orders.push({
      vendor: opts.vendor,
      vendorName:
        opts.vendor === 'apple'
          ? 'Apple'
          : opts.vendor === 'google'
            ? 'Google'
            : opts.vendor === 'amazon'
              ? 'Amazon'
              : null,
      orderDate: date,
      orderId: orderId ? String(orderId).trim() : null,
      subtotal: null,
      tax: null,
      total: totalNum,
      currency: (currency ?? opts.defaultCurrency ?? '').toUpperCase().slice(0, 3) || null,
      paymentLast4: last4 ? String(last4).replace(/\D/g, '').slice(-4) || null : null,
      tenders: [],
      items: [
        {
          title: fullTitle.slice(0, 512),
          quantity: 1,
          unitPrice: totalNum,
          totalPrice: totalNum,
          inferredCategory: category ? String(category).trim().slice(0, 64) : null,
        },
      ],
      notes: null,
    });
  }

  return {
    vendor: opts.vendor,
    totalRows: parsed.records.length,
    orders,
    unparsedRows: unparsed,
    columnMapping,
  };
}

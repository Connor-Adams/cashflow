import { scoreAmazonOrderMatch } from '../../amazon/matcher';
import type { ExternalOrder } from '../../models/ExternalOrder';
import type { Transaction } from '../../models/Transaction';
import type { Signal } from './types';

/**
 * Vendor-recognition map. Each entry maps the merchant text (merchantRaw +
 * merchantClean concatenated) to the vendor key stored on ExternalOrder.vendor.
 * The canonical name is what we display on the linked transaction.
 *
 * Order matters — first match wins. Put more-specific patterns first.
 */
const VENDOR_MATCHERS: Array<{
  vendor: string;
  canonical: string;
  pattern: RegExp;
}> = [
  {
    vendor: 'amazon',
    canonical: 'Amazon',
    pattern: /\b(amazon(?:\.(?:com|ca|co\.uk))?|amzn(?:\s*mktp)?|amzn\s*digital|prime\s*video)\b/i,
  },
  {
    vendor: 'apple',
    canonical: 'Apple',
    pattern: /\b(apple(?:\.com)?(?:\/bill)?|itunes|app\s*store|apple\s*music|apple\s*tv|icloud)\b/i,
  },
  {
    vendor: 'google',
    canonical: 'Google',
    pattern: /\b(google(?:\s*play)?|google\s*\*|googlepay|youtube\s*premium)\b/i,
  },
  {
    vendor: 'costco',
    canonical: 'Costco',
    pattern: /\bcostco\b/i,
  },
];

function matchVendor(merchantText: string): { vendor: string; canonical: string } | null {
  for (const entry of VENDOR_MATCHERS) {
    if (entry.pattern.test(merchantText)) {
      return { vendor: entry.vendor, canonical: entry.canonical };
    }
  }
  return null;
}

export interface LinkItemsCandidateItem {
  id: number;
  title: string;
  totalPrice: string | null;
  inferredCategory: string | null;
  businessUsePercent: string | null;
}

export interface LinkItemsCandidateOrder {
  id: number;
  vendor: string;
  total: number;
  orderDate: string;
  shipmentDate: string | null;
  paymentLast4: string | null;
  items: LinkItemsCandidateItem[];
}

export interface LinkItemsInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  date: string;
  notes: string | null;
  sourceReference: string | null;
  threshold: number;
  candidateOrders: LinkItemsCandidateOrder[];
}

function num(value: string | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildNotes(items: LinkItemsCandidateItem[]): string {
  const titles = items.slice(0, 5).map((it) => it.title);
  let joined = `Items: ${titles.join(', ')}`;
  if (joined.length > 200) joined = `${joined.slice(0, 197)}...`;
  return joined;
}

export function runLinkItemsStage(input: LinkItemsInput): Signal[] {
  const matched = matchVendor(`${input.merchantRaw} ${input.merchantClean}`);
  if (!matched) return [];

  // Only consider orders of the matched vendor.
  const vendorOrders = input.candidateOrders.filter((o) => o.vendor === matched.vendor);
  if (vendorOrders.length === 0) return [];

  // We reuse the Amazon matcher's scoring (amount proximity + date proximity
  // + payment-last4 match + merchant-text contains vendor) for all vendors.
  // The merchant-text check inside scoreAmazonOrderMatch only adds +15 when
  // the merchant looks Amazon-like, so non-Amazon vendors lose 15 points
  // there. To compensate, we add +15 here since matchVendor already verified
  // the vendor matches.
  const synthesised: Pick<Transaction, 'amount' | 'date' | 'merchantRaw' | 'merchantClean' | 'notes' | 'sourceReference'> = {
    amount: String(input.amount),
    date: input.date,
    merchantRaw: input.merchantRaw,
    merchantClean: input.merchantClean,
    notes: input.notes,
    sourceReference: input.sourceReference,
  } as Transaction;

  let best: { order: LinkItemsCandidateOrder; confidence: number; matchReason: string } | null = null;
  for (const order of vendorOrders) {
    const externalOrder: ExternalOrder = {
      total: String(order.total),
      orderDate: order.orderDate,
      shipmentDate: order.shipmentDate,
      paymentLast4: order.paymentLast4,
    } as ExternalOrder;
    const score = scoreAmazonOrderMatch(synthesised as Transaction, externalOrder);
    // Add the +15 vendor-match bump for non-Amazon vendors so they reach
    // the threshold under equivalent conditions.
    const adjusted = matched.vendor === 'amazon' ? score.confidence : Math.min(100, score.confidence + 15);
    if (adjusted >= input.threshold && (!best || adjusted > best.confidence)) {
      best = { order, confidence: adjusted, matchReason: score.matchReason };
    }
  }

  if (!best) return [];

  const items = best.order.items;
  const categories = items
    .map((it) => it.inferredCategory)
    .filter((c): c is string => c != null && c.trim() !== '');
  const uniqueCategories = Array.from(new Set(categories));

  let autoCategory: string | null = null;
  let confidence: 'high' | 'medium' = 'medium';

  if (uniqueCategories.length === 1) {
    autoCategory = uniqueCategories[0];
    confidence = 'high';
  } else if (uniqueCategories.length > 1) {
    const winner = items
      .filter((it) => it.inferredCategory != null && it.inferredCategory.trim() !== '')
      .sort((a, b) => num(b.totalPrice) - num(a.totalPrice))[0];
    autoCategory = winner?.inferredCategory ?? null;
    confidence = 'medium';
  }

  const autoBusiness = items.some((it) => num(it.businessUsePercent) > 0) || null;

  return [
    {
      source: 'item-link',
      confidence,
      fields: {
        merchantCanonical: matched.canonical,
        autoCategory,
        autoBusiness,
        linkedExternalOrderId: best.order.id,
        notes: buildNotes(items),
      },
      orderLink: {
        externalOrderId: best.order.id,
        confidence: best.confidence,
        matchReason: best.matchReason,
      },
      rationale: `linked to ${matched.canonical} order ${best.order.id} (match confidence ${best.confidence})`,
    },
  ];
}

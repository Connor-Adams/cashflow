import { isAmazonLikeMerchant, scoreAmazonOrderMatch } from '../../amazon/matcher';
import type { ExternalOrder } from '../../models/ExternalOrder';
import type { Transaction } from '../../models/Transaction';
import type { Signal } from './types';

export interface LinkItemsCandidateItem {
  id: number;
  title: string;
  totalPrice: string | null;
  inferredCategory: string | null;
  businessUsePercent: string | null;
}

export interface LinkItemsCandidateOrder {
  id: number;
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
  if (!isAmazonLikeMerchant(`${input.merchantRaw} ${input.merchantClean}`)) {
    return [];
  }

  const synthesised: Pick<Transaction, 'amount' | 'date' | 'merchantRaw' | 'merchantClean' | 'notes' | 'sourceReference'> = {
    amount: String(input.amount),
    date: input.date,
    merchantRaw: input.merchantRaw,
    merchantClean: input.merchantClean,
    notes: input.notes,
    sourceReference: input.sourceReference,
  } as Transaction;

  let best: { order: LinkItemsCandidateOrder; confidence: number } | null = null;
  for (const order of input.candidateOrders) {
    const externalOrder: ExternalOrder = {
      total: String(order.total),
      orderDate: order.orderDate,
      shipmentDate: order.shipmentDate,
      paymentLast4: order.paymentLast4,
    } as ExternalOrder;
    const score = scoreAmazonOrderMatch(synthesised as Transaction, externalOrder);
    if (score.confidence >= input.threshold && (!best || score.confidence > best.confidence)) {
      best = { order, confidence: score.confidence };
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
      source: 'amazon-items',
      confidence,
      fields: {
        merchantCanonical: 'Amazon',
        autoCategory,
        autoBusiness,
        linkedExternalOrderId: best.order.id,
        notes: buildNotes(items),
      },
      rationale: `linked to Amazon order ${best.order.id} (match confidence ${best.confidence})`,
    },
  ];
}

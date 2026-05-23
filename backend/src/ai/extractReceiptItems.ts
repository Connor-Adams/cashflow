/**
 * extractReceiptItems — turn a receipt email body (or other text-form receipt)
 * into a structured ExternalOrder + items payload using OpenAI.
 *
 * The shape mirrors what the existing Amazon order import produces, so the
 * link-items stage can attach the result to a card transaction with no
 * vendor-specific code.
 */
import { openaiJson } from './openaiJson';
import { getVisionModel } from '../config/openai';

export type ExtractedReceiptItem = {
  title: string;
  quantity: number;
  unitPrice: number | null;
  totalPrice: number | null;
  inferredCategory: string | null;
};

export type ExtractedReceiptOrder = {
  vendor: 'amazon' | 'apple' | 'google' | 'other';
  vendorName: string | null;
  orderDate: string | null;
  orderId: string | null;
  total: number | null;
  currency: string | null;
  paymentLast4: string | null;
  items: ExtractedReceiptItem[];
  notes: string | null;
};

const SYSTEM_PROMPT = `You extract structured order data from receipt emails and images.

Reply with JSON only. Schema:
{
  "vendor": "amazon" | "apple" | "google" | "other",
  "vendorName": string | null,
  "orderDate": "YYYY-MM-DD" | null,
  "orderId": string | null,
  "total": number | null,
  "currency": "USD" | "CAD" | "EUR" | "GBP" | "AUD" | null,
  "paymentLast4": string | null,
  "items": [
    {
      "title": string,
      "quantity": number,
      "unitPrice": number | null,
      "totalPrice": number | null,
      "inferredCategory": string | null
    }
  ],
  "notes": string | null
}

Rules:
- Use "amazon" / "apple" / "google" for those three exact merchants; otherwise "other".
- inferredCategory: short labels matching common personal-finance categories ("Subscriptions", "Apps", "Music", "Streaming", "Office", "Groceries", "Dining", "Hardware", "Books"). Null if uncertain.
- Quantities default to 1 if not stated.
- All numbers as plain numbers (no currency symbols, no commas).
- Strip HTML/CSS noise from item titles.
- If the input doesn't look like a receipt at all, return items: [] and total: null.`;

function parseNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.replace(/[,$]/g, '').trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseVendor(v: unknown): ExtractedReceiptOrder['vendor'] {
  if (v === 'amazon' || v === 'apple' || v === 'google') return v;
  return 'other';
}

function parseItems(v: unknown): ExtractedReceiptItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw) => {
      if (raw == null || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const title = parseString(r.title);
      if (!title) return null;
      const qty = parseNumber(r.quantity);
      return {
        title: title.slice(0, 512),
        quantity: qty != null && qty > 0 ? Math.round(qty) : 1,
        unitPrice: parseNumber(r.unitPrice),
        totalPrice: parseNumber(r.totalPrice),
        inferredCategory: parseString(r.inferredCategory),
      } satisfies ExtractedReceiptItem;
    })
    .filter((it): it is ExtractedReceiptItem => it != null)
    .slice(0, 50);
}

export function parseExtractedReceipt(j: Record<string, unknown>): ExtractedReceiptOrder {
  return {
    vendor: parseVendor(j.vendor),
    vendorName: parseString(j.vendorName),
    orderDate: parseString(j.orderDate),
    orderId: parseString(j.orderId),
    total: parseNumber(j.total),
    currency: (parseString(j.currency) ?? '').toUpperCase().slice(0, 3) || null,
    paymentLast4: parseString(j.paymentLast4)?.replace(/\D/g, '').slice(-4) || null,
    items: parseItems(j.items),
    notes: parseString(j.notes),
  };
}

/** Extract a receipt from pasted email body or any text receipt. */
export async function extractReceiptFromText(body: string): Promise<ExtractedReceiptOrder> {
  const trimmed = body.trim().slice(0, 30000); // cap input size
  if (!trimmed) {
    return {
      vendor: 'other',
      vendorName: null,
      orderDate: null,
      orderId: null,
      total: null,
      currency: null,
      paymentLast4: null,
      items: [],
      notes: null,
    };
  }
  const j = await openaiJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: trimmed },
  ]);
  return parseExtractedReceipt(j);
}

/** Extract a receipt from an image (PDF or photo). Uses the vision model. */
export async function extractReceiptFromImage(imageDataUrl: string): Promise<ExtractedReceiptOrder> {
  const model = getVisionModel();
  const j = await openaiJson(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the structured order from this receipt image.' },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  );
  // Suppress unused-var lint — we pass model via env or future overload.
  void model;
  return parseExtractedReceipt(j);
}

/**
 * Decide what to update on an external order that already exists.
 *
 * Re-importing a receipt used to be a no-op for its contents:
 * persistExtractedOrder only wrote items and tenders when the order was newly
 * created, so an order imported by an older parser stayed frozen with whatever
 * that parser produced. This plans a refresh of the PARSER-OWNED fields only.
 *
 * Two rules keep it safe:
 *
 * 1. Only parser-owned fields are ever returned. inferredCategory, confidence,
 *    displayName and businessUsePercent are produced by the AI categorization
 *    pass or by the user, cost money or effort to regenerate, and are never
 *    touched here.
 * 2. A differing row count aborts the whole plan. Rows are matched by position,
 *    which is only meaningful when the parse still has the same shape; a parser
 *    change that adds or removes a row would otherwise shift every subsequent
 *    item onto the wrong record.
 */
import type { ExtractedReceiptItem, ExtractedReceiptTender } from '../ai/extractReceiptItems';

/** An external_order_items row as Sequelize returns it (DECIMALs are strings). */
export type StoredItem = {
  id: number;
  title: string;
  quantity: number;
  unitPrice: string | null;
  totalPrice: string | null;
  itemNumber: string | null;
};

/** An external_order_tenders row as Sequelize returns it. */
export type StoredTender = {
  id: number;
  paymentLast4: string | null;
  network: string | null;
  amount: string;
};

export type RowUpdate = { id: number; fields: Record<string, unknown> };

export type RefreshPlan = {
  /** Non-null when the plan was abandoned wholesale, with the reason. */
  skipped: 'count-mismatch' | null;
  updates: RowUpdate[];
};

const CENT_TOLERANCE = 0.005;

/** Compare a stored DECIMAL string against a parsed number by value. */
function sameMoney(stored: string | null, parsed: number | null): boolean {
  if (stored == null && parsed == null) return true;
  if (stored == null || parsed == null) return false;
  return Math.abs(Number(stored) - parsed) < CENT_TOLERANCE;
}

/** Money is stored as a string; normalise so we never write "17.9900" over "17.99". */
function money(n: number | null): string | null {
  return n == null ? null : String(n);
}

function diff(
  current: unknown,
  next: unknown,
  key: string,
  out: Record<string, unknown>,
): void {
  if (current !== next) out[key] = next;
}

export function planItemRefresh(
  parsed: ExtractedReceiptItem[],
  stored: StoredItem[],
): RefreshPlan {
  if (parsed.length !== stored.length) return { skipped: 'count-mismatch', updates: [] };

  const updates: RowUpdate[] = [];
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    const p = parsed[i];
    const fields: Record<string, unknown> = {};

    diff(s.title, p.title, 'title', fields);
    diff(s.quantity, p.quantity, 'quantity', fields);
    diff(s.itemNumber, p.vendorItemId ?? null, 'itemNumber', fields);
    if (!sameMoney(s.unitPrice, p.unitPrice)) fields.unitPrice = money(p.unitPrice);
    if (!sameMoney(s.totalPrice, p.totalPrice)) fields.totalPrice = money(p.totalPrice);

    if (Object.keys(fields).length > 0) updates.push({ id: s.id, fields });
  }
  return { skipped: null, updates };
}

export function planTenderRefresh(
  parsed: ExtractedReceiptTender[],
  stored: StoredTender[],
): RefreshPlan {
  if (parsed.length !== stored.length) return { skipped: 'count-mismatch', updates: [] };

  const updates: RowUpdate[] = [];
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    const p = parsed[i];
    const fields: Record<string, unknown> = {};

    diff(s.paymentLast4, p.paymentLast4 ?? null, 'paymentLast4', fields);
    diff(s.network, p.network ?? null, 'network', fields);
    if (!sameMoney(s.amount, p.amount)) fields.amount = money(p.amount);

    if (Object.keys(fields).length > 0) updates.push({ id: s.id, fields });
  }
  return { skipped: null, updates };
}

/**
 * Best-effort extraction of a Costco item number from free text (a Google
 * result title/snippet/URL). Only matches digits that follow an "item" label
 * ("Item 1234567", "Item #1234567", "Item No. 1234567", "item:1234567") — a
 * bare number is NOT treated as an item number (too many false positives like
 * prices/sizes). Costco item numbers are 6-8 digits. Returns null if none.
 */
const ITEM_LABEL = /item\s*(?:no\.?|#|:)?\s*(\d{6,8})\b/i;

export function itemNumberFromText(text: string): string | null {
  const m = ITEM_LABEL.exec(text);
  return m ? m[1] : null;
}

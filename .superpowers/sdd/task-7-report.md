# Task 7 Report: Populate structured tax/subtotal/currency from Amazon emails

## Step 1: Field shape verification

`grep -n "subtotal\|tax\|shipping\|currency\|interface ExtractedReceiptOrder\|type ExtractedReceiptOrder" backend/src/ai/extractReceiptItems.ts`

Confirmed at line 43–61:
```ts
export type ExtractedReceiptOrder = {
  subtotal: number | null;   // line 48
  tax: number | null;        // line 49
  currency: string | null;   // line 51
  // NO shipping field
};
```

`shipping` does NOT exist on `ExtractedReceiptOrder` — dropped the shipping local as instructed.

## Parser changes (`backend/src/integrations/parsers/amazon.ts`)

1. Added `detectCurrency(body: string): string | null` helper after `parseAmount`:
   - CDN$/CA$/CAD → 'CAD', US$/USD → 'USD', £/GBP → 'GBP', €/EUR → 'EUR', else null.

2. Removed unused `SHIPPING_RE` constant (was causing TS6133 unused-variable error after shipping local was dropped).

3. In `parseAmazonReceiptEmail`, replaced the notes-stuffing block with structured population:
   - `subtotal`: parsed from `SUBTOTAL_RE` via `parseAmount`.
   - `tax`: parsed from `TAX_RE` via `parseAmount`.
   - `currency`: from `detectCurrency(body)`.
   - `notes`: now only `Order ${orderId}` (or null) — no longer carries tax/shipping strings.

## Persistence trace (Step 5)

**`scanReceipts.ts` (line 657-659):** The `ExternalOrder.findOrCreate` defaults block hardcoded `subtotal: null, tax: null, shipping: null` — it did NOT map from `extracted!.subtotal` / `extracted!.tax`. **MAPPING WAS MISSING.**

**Fix applied** to `backend/src/integrations/scanReceipts.ts`:
```ts
// Before:
subtotal: null,
tax: null,
shipping: null,

// After:
subtotal: extracted!.subtotal != null ? String(extracted!.subtotal) : null,
tax: extracted!.tax != null ? String(extracted!.tax) : null,
shipping: null,   // no shipping field on ExtractedReceiptOrder
```

**`vendorCapture.ts` (line 104-106):** Also hardcodes `subtotal: null, tax: null` — but this path handles bookmarklet/Apple import orders (not email scan). The bookmarklet payload schema (`CaptureOrderArgs`) does not carry `subtotal`/`tax` fields from the frontend, so fixing this would require a broader schema change. Left as-is with no change; it is a separate concern from the email parser path.

## Test command + output

```
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts
```

Result: **7 pass, 0 fail** (4 new tests added, 3 pre-existing).

New tests:
- `populates structured subtotal/tax, not just notes` — asserts `tax=5.39`, `subtotal=44.97`, notes has no Tax: or Shipping: strings
- `detects CAD currency from CDN$ prefix`
- `detects USD currency from US$ prefix`
- `currency is null when no currency prefix present`

Existing tests updated: None required — existing tests did not assert on `notes` content for tax/shipping.

## Typecheck

`yarn workspace cashflow-backend run typecheck` → clean (0 errors).

Initial run surfaced TS6133: 'SHIPPING_RE' is declared but its value is never read. Fixed by removing the now-unused constant.

## Commit

```
feat(parser): populate structured tax/subtotal/currency from Amazon emails
```

Files committed:
- `backend/src/integrations/parsers/amazon.ts`
- `backend/src/integrations/parsers/amazonEmailParser.test.ts`
- `backend/src/integrations/scanReceipts.ts`

## Concerns

- `vendorCapture.ts` persistence path still hardcodes `subtotal: null, tax: null` for bookmarklet/Apple import orders. That path's upstream `CaptureOrderArgs` schema doesn't carry those fields, so fixing it requires a frontend schema change. Not in scope for this task, but worth noting for completeness.
- `SHIPPING_RE` was removed entirely. If a future task adds a `shipping` field to `ExtractedReceiptOrder`, it will need to be re-added.

---

## Follow-up fixes (FIX 1 + FIX 2)

### FIX 1 — ExternalOrder persistence mapping test

Added to `backend/src/integrations/scanReceipts.test.ts`:

```
test('scanInbox: ExternalOrder.subtotal and .tax are persisted (not null) from Amazon email')
```

**Approach**: drives `scanInbox` with a stubbed `fetchMessage` returning an Amazon-format email body (from `auto-confirm@amazon.ca`), no `extractFromText` needed since the deterministic Amazon parser handles it. Asserts the created `ExternalOrder` row has non-null `subtotal` and `tax` values.

**Notes**:
- Email body uses bare `$` on the summary lines (TOTAL_RE/SUBTOTAL_RE/TAX_RE only handle optional bare `$`; `CDN$ X.XX` format does not match those regexes). The `CDN$` prefix on the per-item line is sufficient to trigger CAD currency detection.
- SQLite returns DECIMAL as a JS number; Postgres returns a string. Assertions use `Number()` coercion to work on both.
- `interacCounterparty.ts` logs an ILIKE-not-supported SQLite error during the scan (pre-existing, non-fatal — same as in `scanInboxPdf.test.ts`).

**Test command**: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceipts.test.ts`
**Result**: 5 pass, 0 fail.

### FIX 2 — detectCurrency anchored to adjacent digits

Tightened `detectCurrency` in `backend/src/integrations/parsers/amazon.ts` to require a currency symbol/code to be adjacent to a digit before returning a match.

**Pattern changes**:
- Before: `/CDN\$|CA\$|\bCAD\b/` — would match bare CAD or £ anywhere in body
- After: `/CDN\$\s*\d|CA\$\s*\d|\d[\s.]*CAD\b|\bCAD\s*\d/` and equivalent for USD/GBP/EUR

**New tests** added to `backend/src/integrations/parsers/amazonEmailParser.test.ts`:
1. `incidental £ in non-price prose does NOT override CDN$-priced order currency` — asserts CAD, not GBP, when body contains non-price "£ sterling" text alongside CDN$ item pricing
2. `detectCurrency still works for standalone CAD/USD codes adjacent to amounts` — asserts CDN$/US$ prefix patterns and trailing CAD/USD codes still resolve

**Test command**: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts`
**Result**: 9 pass, 0 fail (7 existing + 2 new).

### Typecheck

`yarn workspace cashflow-backend run typecheck` → clean (0 errors).

### Commit

```
test(parser): cover tax/subtotal persistence + anchor currency detection
```

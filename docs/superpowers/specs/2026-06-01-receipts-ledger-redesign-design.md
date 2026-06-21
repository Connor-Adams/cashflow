# Receipts ledger redesign

Date: 2026-06-01
Status: Approved (design), pending implementation plan

## Context

The `/receipts` list (`frontend/src/components/receipts/ReceiptsList.tsx`) renders
each captured order as a `<details>` with a `flex flex-wrap justify-between`
summary. Columns float by text width, so nothing aligns row-to-row; an expanded
receipt with ~31 line items has no height cap and buries the page; the raw
`source` filename (`costco_till_receipt-pdf`) leaks into the UI; and there is no
summary or financial breakdown.

This is a **visual / frontend-only** restyle into a dense, aligned **ledger** with
an enriched expansion. Approved against the mockup at
`.superpowers/brainstorm/44213-1780350989/content/ledger-detail.html`.

## Scope

**In:** `ReceiptsList.tsx` restyle + a small amount of derived computation, all
client-side. Test updates.

**Out (explicitly):**
- No backend change. The GET `/api/external-orders` response already carries
  every field we need.
- No actions on orphans (link/dismiss/accept). Status stays **display-only**.
- No tenders / payment-split display (the GET does not `include` tenders; adding
  it would be a backend change).

## Data sources — the load-bearing table

The endpoint serializes `order.toJSON()` (see `serializeOrderWithLinkStatus` in
`backend/src/routes/externalOrders.ts`), so the response **already includes** the
fields below. The frontend `ReceiptOrder` type currently declares only `total`;
widen it to declare what we render.

| UI element            | Source                                    | Kind          |
|-----------------------|-------------------------------------------|---------------|
| Vendor, Date          | `order.vendor`, `order.orderDate`         | real field    |
| Total                 | `order.total`                             | real field    |
| Subtotal              | `order.subtotal`                          | real field    |
| Tax                   | `order.tax`                               | real field    |
| Shipping              | `order.shipping`                          | real field    |
| Paid with •••• 1234   | `order.paymentLast4`                      | real field    |
| Status (dot)          | `order.linkStatus` (`linked`/`needs_match`/`orphan`) | real field |
| Line items            | `order.items[]` (`title`, `quantity`, `totalPrice`, `inferredCategory`) | real field |
| Summary bar counts    | aggregate over the orders array           | client-derived |
| Category roll-up      | group `items` by `inferredCategory`, sum `totalPrice` | client-derived |

**Nulls are expected.** `subtotal`/`tax`/`shipping`/`paymentLast4` are null on many
"Other" PDF receipts. Any breakdown line whose value is null is **omitted**, not
shown as `—`. If `inferredCategory` is null/absent across all items, the category
roll-up block is omitted entirely.

## Collapsed row — fixed grid

Replace `flex flex-wrap justify-between` with a CSS grid so columns align across
every row:

```
[ Vendor          | Date    | Tax (muted, right) | Total (right) | ● | ⌄ ]
  1.6fr             0.8fr     1fr                   1fr            dot  16px
```

- `Tax` column is muted, right-aligned, tabular-nums; blank cell when tax is null.
- Status is a small colored **dot** (jade = linked, rust = orphan, amber =
  needs_match) with an `sr-only` / `title` label so the one actionable signal
  (orphan) stays findable without a full text column. Reuses the existing
  `LINK_LABEL` map for the accessible text.
- A header row labels the columns (uppercase, muted, tiny).
- Keep the native `<details>`/`<summary>`; rotate the chevron via `[open]`.

## Expanded detail — three blocks

Rendered inside the `<details>` body, on a `--card` panel:

1. **Items** — `N items` label + the existing item rows (`title ×qty` → price,
   negatives in rust). Wrapped in a `max-height` (~150px) scroll container so a
   31-item receipt no longer dominates the page.
2. **Breakdown** — a small right-column table: `Subtotal`, `Tax`, `Shipping`
   (each shown only when non-null), then `Total` (bold, top-bordered). Below it,
   `Paid with •••• {last4}` when `paymentLast4` present.
3. **Where it went** — category roll-up: group items by `inferredCategory`, sum
   `totalPrice`, sort desc, render a proportional bar + a legend of
   `swatch · Category · CA$sum`. Cap at top 5 categories + "Other". Omitted when
   no item has a category.

> Deposits/Discounts: the mockup showed these as breakdown lines, but they are
> **line items** (e.g. `DEPOSIT VL/...`, `TPD/...`), not order columns. v1 does
> NOT aggregate them into the breakdown — they already appear in the Items list.
> (Flagged for spec review: confirm we omit a Deposits/Discounts breakdown row.)

## Summary bar

Above the list: `{n} receipts · {orphanCount} orphan · CA${totalSum} total ·
CA${taxSum} tax`, all derived from the loaded orders. Orphan count tinted rust.
Tax sum skips null-tax orders.

## Money & formatting

Reuse `formatMoney(Number(value), order.currency)`. All numeric cells use
`tabular-nums`. Negative line items render in the rust/negative color.

## Theme

Use existing CSS variables (`--card`, `--border`, `--muted-foreground`,
`--primary`/amber, jade `--positive`, rust `--warning`). No raw hex. Prefer
Tailwind utilities; for the status-dot color map use a literal lookup table (JIT
needs literal class strings) consistent with the existing `LINK_COLOR` pattern.

## Testing

Extend `frontend/src/components/receipts/ReceiptsList.test.tsx`:
- Renders subtotal/tax/total in the breakdown when present; hides lines when null.
- Renders `Paid with •••• {last4}` only when `paymentLast4` set.
- Category roll-up groups + sums by `inferredCategory`; absent when no categories.
- Summary bar counts (receipts, orphans) and sums (total, tax) are correct.
- Status dot carries the correct accessible label per `linkStatus`.

## Files

- `frontend/src/components/receipts/ReceiptsList.tsx` — restyle + derivations +
  widen `ReceiptOrder`/`ReceiptItem` types to include `subtotal`, `tax`,
  `shipping`, `paymentLast4`.
- `frontend/src/components/receipts/ReceiptsList.test.tsx` — coverage above.
- No backend files.

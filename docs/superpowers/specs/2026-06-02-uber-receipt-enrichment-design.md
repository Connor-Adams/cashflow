# Uber Receipt Enrichment — Eats Line Items & Ride Trip Details

**Status:** Draft
**Date:** 2026-06-02
**Goal:** Turn Uber receipt emails into linked, itemized enrichment on the card
transaction — Uber Eats food line items and Uber ride trip details (route,
distance, duration) — so spend, budgets, and the business/tax split reflect what
each Uber charge actually was. **Uber rides and Uber Eats are modeled as two
distinct vendors** (`uber`, `uber_eats`).

## Background

The Gmail receipt pipeline already pulls Uber mail and runs it through the
generic OpenAI extractor, but the result is silently orphaned:

1. **Scan** — `backend/src/integrations/scanReceipts.ts` lists messages from
   allowlisted senders. Uber addresses (`receipts@uber.com`, `noreply@uber.com`,
   `no-reply@uber.com`) are in `DEFAULT_RECEIPT_SENDERS` (scanReceipts.ts:70) with
   `vendorHint: 'other'`.
2. **Extract** — each body runs `tryDeterministicParse` (vendor parsers) then
   falls back to `extractReceiptFromText` (`backend/src/ai/extractReceiptItems.ts`).
   Uber has no deterministic parser, so it hits the AI fallback, which returns
   `vendor: 'other'` and (for Eats) a list of food items.
3. **Persist** — an `ExternalOrder` (+ `ExternalOrderItem`s) is created with
   `vendor: 'other'`.
4. **Link — BROKEN.** Attaching the order to its card charge runs through a
   **hard vendor filter** in two places, and both only know
   amazon/apple/google/costco:
   - `backend/src/import/matchReceiptToTransactions.ts:199` filters candidate
     transactions by `txnMatchesVendor(order.vendor, txn)`. `VENDOR_MERCHANT_PATTERNS`
     has no `'other'` key → returns `false` → every candidate dropped.
   - `backend/src/import/enrichment/linkItemsStage.ts` matches the transaction's
     merchant text against `VENDOR_MATCHERS` (same four vendors) to find candidate
     orders. No Uber entry → no link.

Net: Uber Eats items are extracted today but **never attach to the Uber
transaction**, and ride emails yield nothing structured at all (the
item-centric schema has no slot for a trip).

`linkItemsStage.ts:153` derives the transaction's `autoBusiness` from
`items.some(it => businessUsePercent > 0)`, and `autoCategory` from the items'
`inferredCategory`. So transaction-level category + business-use already flow
**up** from per-`ExternalOrderItem` values. We reuse that propagation rather than
build anything new.

## Goals

- Uber Eats food line items link to the card charge; `Dining` category
  propagates to the transaction.
- Uber rides capture trip detail (pickup, dropoff, distance, duration, time) and
  surface it on the transaction.
- Ride business-use (deductible vs personal) is inferred by AI from trip context
  and feeds the existing business/tax split machinery.
- Rides and Eats are cleanly separated as two vendors — a ride order can never
  attach to an Eats charge or vice versa.
- Reuse the existing item → transaction propagation and item display surfaces;
  add no new primitive, no new table, no migration.

## Non-Goals (v1)

- Lyft / DoorDash / Grubhub / SkipTheDishes enrichment. They stay generic. Only
  Uber is special-cased here.
- Auto-backfill of historical Uber orders. New scans get the behavior; a
  re-scan / re-enrich picks up history through the normal path.
- Generalizing the sender → vendor override to all vendors. Scoped to Uber in v1
  (apple/google/amazon already resolve vendor via their deterministic parsers).
- A first-class, queryable trip table or typed trip columns. Trip detail lives in
  `rawPayload.trip`. Promote to columns only if reporting needs it.

## Vendor split & discriminator

The ride/Eats distinction is carried by `ExternalOrder.vendor` itself — **no
`kind` column, no migration**:

- `vendor: 'uber'` → a ride. Card descriptors like `UBER TRIP`, `UBER *TRIP`.
  Has `rawPayload.trip`; one synthetic `'trip'` item.
- `vendor: 'uber_eats'` → an Eats order. Card descriptor `UBER EATS`,
  `UBER *EATS`. Has N food items.

A single classifier decides which, from the email's subject/body (the sender
address can't distinguish the two — both arrive from `uber.com` senders):

```ts
// backend/src/integrations/parsers/uber.ts
export function classifyUberKind(subject: string | null, body: string): 'uber' | 'uber_eats';
// 'uber_eats' when subject/body shows Eats markers ("Uber Eats", restaurant
// order, itemized food); otherwise 'uber' (ride).
```

## Architecture

```
Gmail msg (Uber sender)
      │
      ▼
scanReceipts.processOne
      │  is Uber sender?  ──▶ classifyUberKind(subject, body) ──▶ vendor = 'uber' | 'uber_eats'
      │  tryDeterministicParse → parsers/uber.ts (ride trip | eats items)   (Phase 2 ride parse)
      │      └─ fallback: extractReceiptFromText (+ optional trip in schema)
      ▼
ExternalOrder { vendor:'uber'|'uber_eats', rawPayload.trip? }
      │            │
      │            ├─ uber_eats → N food ExternalOrderItem (inferredCategory 'Dining')
      │            └─ uber      → 1 synthetic 'trip' ExternalOrderItem
      │                            └─ aiCategorizeUberTrip → businessUsePercent + 'Transport'
      ▼
link to Transaction (vendor-scoped — uber↛uber_eats):
  • matchReceiptToTransactions  (order→txn, Gmail-scan backfill)   ┐ both maps get
  • linkItemsStage              (txn→order, enrich pipeline)        ┘ uber + uber_eats
      │
      ▼  (existing propagation)
Transaction.autoCategory / autoBusiness   ◀── items' inferredCategory / businessUsePercent
      │
      ▼  (existing display)
ReceiptItemsDrawer / ItemDetailDrawer  + NEW trip block when vendor==='uber'
```

Three new things on top of the existing model:

1. **`classifyUberKind`** — subject/body discriminator that sets `vendor` to
   `'uber'` or `'uber_eats'`. The vendor field is the discriminator; no schema
   change.
2. **`rawPayload.trip`** — structured trip detail on ride orders. No migration
   (`raw_payload` JSON column already exists, ExternalOrder.ts:53).
3. **`parsers/uber.ts`** + **`aiCategorizeUberTrip.ts`** — Uber-aware extraction
   and ride business-use inference, both modeled on existing precedents.

### `rawPayload.trip` shape

```ts
type TripDetail = {
  pickupAddress: string | null;
  dropoffAddress: string | null;
  distance: number | null;          // numeric value
  distanceUnit: 'km' | 'mi' | null;
  durationMinutes: number | null;
  requestedAt: string | null;       // ISO datetime
  driver: string | null;
  surgeMultiplier: number | null;
};
```

## Components

### Phase 1 — Eats unblock (ships independently)

| File | Change |
| ---- | ------ |
| `backend/src/integrations/parsers/uber.ts` | NEW (classifier only in Phase 1). Export `classifyUberKind(subject, body) → 'uber' \| 'uber_eats'`. The full deterministic parse is added in Phase 2; here the file exists for the classifier. |
| `backend/src/integrations/scanReceipts.ts` | Flip the three Uber `DEFAULT_RECEIPT_SENDERS` entries to `vendorHint: 'uber'`. Build a normalized `address → vendorHint` map. In `processOne`, when the `From` address resolves to an Uber sender, call `classifyUberKind` and override `extracted.vendor` to `'uber'` / `'uber_eats'` (overrides the AI's `'other'`). Scoped to Uber; other vendors unchanged. |
| `backend/src/import/matchReceiptToTransactions.ts` | Add to `VENDOR_MERCHANT_PATTERNS`: `uber_eats: /\buber\s*\*?\s*eats\b/i` and `uber: /\buber\b(?!\s*\*?\s*eats)/i`. The negative lookahead keeps a ride order (`vendor:'uber'`) from matching an `UBER *EATS` charge (lookup is keyed by `order.vendor`, so each pattern must stand alone). |
| `backend/src/import/enrichment/linkItemsStage.ts` | Add to `VENDOR_MATCHERS`, **`uber_eats` before `uber`** (array, first-match-wins): `{ vendor:'uber_eats', canonical:'Uber Eats', pattern:/\buber\s*\*?\s*eats\b/i }` then `{ vendor:'uber', canonical:'Uber', pattern:/\buber\b/i }`. |

After Phase 1: Eats orders carry `vendor:'uber_eats'`, link to the charge, and
the existing `linkItemsStage` lifts `Dining` onto the transaction. Eats
business-use defaults personal (correctable). Ride emails get `vendor:'uber'` and
link by amount/date (no trip detail yet — Phase 2). No AI beyond the existing
item extraction.

### Phase 2 — Rides

| File | Change |
| ---- | ------ |
| `backend/src/integrations/parsers/uber.ts` | Extend with the deterministic ride parse: pull fare + `TripDetail` (pickup, dropoff, distance, duration, time) from the ride email; return `{ ok, parser:'uber', order }` with one synthetic `'trip'` item + `trip`. Eats stays on the existing AI extraction. `ok:false` falls through to AI. |
| `backend/src/ai/extractReceiptItems.ts` | Extend `ExtractedReceiptOrder` with optional `trip?: TripDetail \| null`. Extend the AI system prompt/schema so a ride survives a deterministic miss (emit trip fields). Back-compatible (optional, parsed leniently). |
| `backend/src/integrations/scanReceipts.ts` | Persist `rawPayload.trip` on ride orders. For ride orders, call `aiCategorizeUberTrip` before `ExternalOrderItem.bulkCreate` to set the synthetic trip item's `businessUsePercent` + `inferredCategory`. |
| `backend/src/ai/aiCategorizeUberTrip.ts` | NEW. Modeled on `backend/src/amazon/aiCategorizeAmazonItems.ts`. Input: `TripDetail` + existing category list. Output: `{ category, businessUsePercent (0-100\|null), confidence, rationale }`. |
| `backend/src/routes/externalOrders.ts` | Include `trip` (from `rawPayload`) in the order response for `vendor:'uber'` orders. |

### Frontend

| File | Change |
| ---- | ------ |
| `frontend/src/types/api.ts` | Add `trip` to the external-order / item row types. |
| `frontend/src/components/ReceiptItemsDrawer.tsx` | When `vendor==='uber'`, render a trip block (route, distance, duration, time). `vendor==='uber_eats'` renders the existing item list. Vendor label comes straight from the order vendor (`Uber` / `Uber Eats`). |

## Linking semantics

Ride orders (`vendor:'uber'`) and Eats orders (`vendor:'uber_eats'`) are matched
independently — the matcher filters candidate orders to the exact vendor, so a
ride can never attach to an Eats charge or vice versa. Within a vendor,
`scoreReceiptMatch` ranks by amount proximity (±$0.50 → +50), date gap, and
payment last4. The vendor split removes the same-day cross-match ambiguity that a
single `uber` vendor would have had.

## Sequencing & the fixtures dependency

- **Phase 1** needs no fixtures — classifier + vendor-map + sender-hint fix. Ships
  first, fixes the orphaning bug, makes Eats work end-to-end on the existing AI
  extraction.
- **Phase 2** rides: the AI fallback (extended schema) carries rides **day one**,
  so nothing blocks on fixtures. The deterministic ride parse in `parsers/uber.ts`
  is a fast-follow, built and tested against 1–2 real (sanitized) Uber ride +
  Eats emails when available. Until then, rides lean on the AI fallback.

## Testing

- `classifyUberKind`: Eats subject/body → `'uber_eats'`; ride subject/body →
  `'uber'`.
- `parsers/uber.ts` (Phase 2): ride email fixture → fare + `TripDetail` + one trip
  item; non-ride / malformed → `ok:false` (fall through).
- Vendor maps: `txnMatchesVendor('uber_eats', txn)` true for `UBER EATS` /
  `UBER *EATS`; `txnMatchesVendor('uber', txn)` true for `UBER TRIP` / `UBER *TRIP`
  and **false** for `UBER *EATS`; `linkItemsStage` `VENDOR_MATCHERS` resolves
  `UBER *EATS`→`uber_eats`, `UBER TRIP`→`uber`.
- `scoreReceiptMatch`: a `vendor:'uber_eats'` order links to an `UBER *EATS`
  transaction at matching amount/date; a `vendor:'uber'` order does not appear as a
  candidate for that charge.
- `scanReceipts`: an Uber-sender message sets `vendor` via `classifyUberKind` even
  when the AI returns `'other'`; ride orders persist `rawPayload.trip`.
- `aiCategorizeUberTrip`: business-looking trip context (weekday, work hours,
  office destination) → `businessUsePercent > 0`; personal context → `null`/0.
- Propagation: a linked uber ride with `businessUsePercent > 0` sets the
  transaction's `autoBusiness` via `linkItemsStage`.
- Regression: apple/google/amazon scans unaffected by the sender-hint override.

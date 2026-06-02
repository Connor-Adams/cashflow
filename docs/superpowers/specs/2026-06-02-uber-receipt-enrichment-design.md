# Uber Receipt Enrichment — Eats Line Items & Ride Trip Details

**Status:** Draft
**Date:** 2026-06-02
**Goal:** Turn Uber receipt emails into linked, itemized enrichment on the card
transaction — Uber Eats food line items and Uber ride trip details (route,
distance, duration) — so spend, budgets, and the business/tax split reflect what
each Uber charge actually was.

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
     orders. No `uber` entry → no link.

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
- Reuse the existing item → transaction propagation and item display surfaces;
  add no new primitive and no new table.

## Non-Goals (v1)

- Lyft / DoorDash / Grubhub / SkipTheDishes enrichment. They stay generic. Only
  Uber is special-cased here.
- Splitting `uber` into separate `uber` / `uber_eats` vendor keys. One `uber`
  vendor with a `kind` discriminator. Revisit only if cross-matching misfires.
- Auto-backfill of historical Uber orders. New scans get the behavior; a
  re-scan / re-enrich picks up history through the normal path.
- Generalizing the sender → vendor override to all vendors. Scoped to Uber in v1
  (apple/google/amazon already resolve vendor via their deterministic parsers).
- A first-class, queryable trip table or typed trip columns. Trip detail lives in
  `rawPayload.trip`. Promote to columns only if reporting needs it.

## Architecture

```
Gmail msg (Uber sender)
      │
      ▼
scanReceipts.processOne
      │  sender→vendorHint lookup  ──▶ force order.vendor = 'uber'   (Phase 1)
      │  tryDeterministicParse → parsers/uber.ts (ride|eats, +trip)  (Phase 2)
      │      └─ fallback: extractReceiptFromText (+ optional trip/kind in schema)
      ▼
ExternalOrder { vendor:'uber', kind:'ride'|'eats', rawPayload.trip }
      │            │
      │            ├─ eats → N food ExternalOrderItem (inferredCategory 'Dining')
      │            └─ ride → 1 synthetic 'trip' ExternalOrderItem
      │                        └─ aiCategorizeUberTrip → businessUsePercent + 'Transport'
      ▼
link to Transaction:
  • matchReceiptToTransactions  (order→txn, Gmail-scan backfill)   ┐ both need
  • linkItemsStage              (txn→order, enrich pipeline)        ┘ uber pattern
      │
      ▼  (existing propagation)
Transaction.autoCategory / autoBusiness   ◀── items' inferredCategory / businessUsePercent
      │
      ▼  (existing display)
ReceiptItemsDrawer / ItemDetailDrawer  + NEW trip block from order.kind/trip
```

Three new things on top of the existing model:

1. **`external_orders.kind`** (STRING(16), nullable: `'ride'|'eats'|null`) — the
   variant discriminator. Drives display branching and the `Uber`/`Uber Eats`
   label.
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
| `backend/src/integrations/scanReceipts.ts` | Flip the three Uber `DEFAULT_RECEIPT_SENDERS` entries to `vendorHint: 'uber'`. Build a normalized `address → vendorHint` map from `DEFAULT_RECEIPT_SENDERS`. In `processOne`, after extraction, if the message's `From` address resolves to hint `'uber'`, override `extracted.vendor = 'uber'`. (Scoped to uber; other vendors unchanged.) |
| `backend/src/import/matchReceiptToTransactions.ts` | Add `uber: /\buber\b/i` to `VENDOR_MERCHANT_PATTERNS`. Matches `UBER TRIP`, `UBER *EATS`, `UBER *TRIP` card descriptors. |
| `backend/src/import/enrichment/linkItemsStage.ts` | Add `{ vendor: 'uber', canonical: 'Uber', pattern: /\buber\b/i }` to `VENDOR_MATCHERS`. |

After Phase 1: Eats orders carry `vendor:'uber'`, link to the charge, and the
existing `linkItemsStage` lifts `Dining` onto the transaction. Eats business-use
defaults personal (correctable). No AI beyond the existing item extraction.

### Phase 2 — Rides

| File | Change |
| ---- | ------ |
| `backend/src/migrations/20260602000001-external-order-kind.js` | NEW. Add `external_orders.kind` STRING(16), nullable. |
| `backend/src/models/ExternalOrder.ts` | Declare + init `kind`. |
| `backend/src/ai/extractReceiptItems.ts` | Extend `ExtractedReceiptOrder` with optional `kind?: 'ride'\|'eats'\|null` and `trip?: TripDetail \| null`. Extend the AI system prompt/schema so a ride survives a deterministic miss (emit `kind:'ride'` + trip fields). Back-compatible (both optional, parsed leniently). |
| `backend/src/integrations/parsers/uber.ts` | NEW. Deterministic Uber parser, sibling to `amazon.ts`/`apple.ts`/`google.ts`. Detect `kind` from sender/subject/body. Ride → one synthetic item (`title:'Uber trip'`, `totalPrice: fare`) + `TripDetail`. Eats → food line items. Returns `{ ok, parser:'uber', order }` or `{ ok:false }` to fall through to AI. |
| `backend/src/integrations/parsers/index.ts` | Register `uber` in the `tryDeterministicParse` dispatch. |
| `backend/src/integrations/scanReceipts.ts` | Persist `kind` + `rawPayload.trip` onto the `ExternalOrder`. For ride orders, call `aiCategorizeUberTrip` before `ExternalOrderItem.bulkCreate` to set the trip item's `businessUsePercent` + `inferredCategory`. |
| `backend/src/ai/aiCategorizeUberTrip.ts` | NEW. Modeled on `backend/src/amazon/aiCategorizeAmazonItems.ts`. Input: `TripDetail` + existing category list. Output: `{ category, businessUsePercent (0-100\|null), confidence, rationale }`. |
| `backend/src/routes/externalOrders.ts` | Include `kind` + `trip` (from `rawPayload`) in the order response. |

### Frontend

| File | Change |
| ---- | ------ |
| `frontend/src/types/api.ts` | Add `kind` + `trip` to the external-order / item row types. |
| `frontend/src/components/ReceiptItemsDrawer.tsx` | When `kind==='ride'`, render a trip block (route, distance, duration, time) instead of / above the single trip item. Eats renders as existing item list. Label `Uber Eats` when `kind==='eats'`, else `Uber`. |

## Linking semantics

Both ride and Eats orders share `vendor:'uber'`. The matcher filters candidate
orders to `vendor==='uber'`, then `scoreReceiptMatch` ranks by amount proximity
(±$0.50 → +50), date gap, and payment last4. A same-day ride + Eats order at
similar amounts is the one ambiguity; amount + last4 normally disambiguate. If it
proves real, split into `uber` / `uber_eats` vendors (Non-Goals).

## Sequencing & the fixtures dependency

- **Phase 1** needs no fixtures — it's the vendor-map + sender-hint fix. Ships
  first, fixes the orphaning bug, makes Eats work end-to-end on the existing AI
  extraction.
- **Phase 2** rides: the AI fallback (extended schema) carries rides **day one**,
  so nothing blocks on fixtures. The deterministic `parsers/uber.ts` is a
  fast-follow, built and tested against 1–2 real (sanitized) Uber ride + Eats
  emails when available. Until then, rides lean on the AI fallback.

## Testing

- `parsers/uber.ts`: ride + Eats email fixtures → correct `kind`, trip fields,
  items, fare/total. Non-Uber / malformed bodies → `ok:false` (fall through).
- Vendor maps: `txnMatchesVendor('uber', txn)` true for `UBER TRIP`,
  `UBER *EATS`, `UBER *TRIP`; `linkItemsStage` `VENDOR_MATCHERS` matches the same.
- `scoreReceiptMatch`: a `vendor:'uber'` order links to an `UBER *EATS`
  transaction at matching amount/date.
- `scanReceipts`: an Uber-sender message forces `vendor:'uber'` even when the AI
  returns `'other'`; ride orders persist `kind` + `rawPayload.trip`.
- `aiCategorizeUberTrip`: given business-looking trip context (weekday, work
  hours, office destination) returns `businessUsePercent > 0`; personal context
  returns `null`/0.
- Propagation: a linked uber ride with `businessUsePercent > 0` sets the
  transaction's `autoBusiness` via `linkItemsStage`.
- Regression: apple/google/amazon scans unaffected by the sender-hint override.

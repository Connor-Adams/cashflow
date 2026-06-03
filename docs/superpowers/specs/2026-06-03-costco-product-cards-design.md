# Costco product-image enrichment (rich product cards)

**Date:** 2026-06-03
**Status:** Design approved, pre-implementation
**Primitive:** Transaction (extends `external_order_items`; adds one cache table). No new status machine on the spine — `costco_products` is a derived-data cache, not a primitive.

## Problem

Costco warehouse till-receipt line items have cryptic names ("KS ORG PNT BTR").
AI name-expansion already ships (`displayName`, PR #506), so items read cleanly.
The remaining gap: receipt items have no **product image**. A thumbnail is the
desired enrichment — it turns a line item into a recognizable product card.

## Why a web lookup, and why this shape

Investigated (2026-06-02, kindex `costco-sku-web-lookup-feasibility`):

- **No official Costco product API.** Direct `costco.com` fetch is Akamai
  bot-walled. General search engines don't index by item number.
- **No item-number → product lookup off the shelf.** Third-party scrapers
  (Unwrangle, ScrapingBee, Apify) take a product URL or a keyword, not a
  warehouse item number.
- **Warehouse ≠ online catalog.** Costco's site is an *extension* of warehouse
  stock, not a mirror. Many in-warehouse receipt items are simply not on
  costco.com. Coverage will always be partial — accepted.

Decomposing the "rich card" shows only **one** field genuinely needs a web
lookup:

| Card field | Needs scraping? | Source |
|---|---|---|
| Clean product name | No | LLM — already shipped (`displayName`) |
| Category | No | AI — already shipped (`inferredCategory`) |
| Price | No | Already in DB — `totalPrice`/`unitPrice` (what was actually paid) |
| Costco.com link | No | Constructible deep-link |
| **Product image** | **Yes** | Only field requiring a web lookup |

So v1's only new card content is **image + a Costco link**. No brand/size
fields — `displayName` already embeds brand, and those add no new value.

### The verification key

The accuracy risk in name-search resolution ("KS ORG PNT BTR" → search →
maybe-wrong product) is closed by the fact that **Costco product pages display
the item number**. Resolution therefore *verifies* the fuzzy name match against
the receipt's `item_number`. This forces the data source: a generic image
search (Google/Bing) can't return Costco's item number, so it can't satisfy
**verified-only**. A Costco-product scraper that returns the item number is the
only source that can. Hosted scraper, swappable behind an injectable caller.

## Confirmed requirements

- **Multi-tenant** — serves all households, not just one user.
- **Image is the must-have.** Other card fields already exist.
- **Verified-only.** Show an image only when the scraped product's item number
  equals the receipt's `item_number`. A wrong thumbnail erodes trust more than
  a missing one. No fuzzy/best-effort display.
- **Shared cache keyed by `item_number`** (global + stable across all Costco) so
  one resolution serves every household. Popular Kirkland staples repeat → high
  hit rate, bounded cost.
- **Async resolution.** Never blocks receipt ingest.
- **Graceful degradation.** No image → existing text card.

## Architecture (Approach A: shared cache + async resolver)

Rejected alternatives:
- **B — per-item, no cache:** re-scrapes the same item once per household.
  Wasteful, more cost, more ToS exposure, no clean not-found memo. Bad at scale.
- **C — synchronous at ingest:** scrape latency + rate-limit/budget failures
  would stall or break upload. We chose async.

### 1. Data model — `costco_products` cache

New table, one row per global Costco item number. Migration mirrors existing
sequelize migration style.

| Column | Type | Notes |
|---|---|---|
| `item_number` | STRING(64), unique, indexed | Join key; matches `external_order_items.item_number` |
| `status` | STRING enum | `pending` \| `resolved` \| `not_found` \| `error` |
| `image_url` | STRING(1024), null | Resolved Costco product image |
| `costco_url` | STRING(1024), null | Resolved product page URL |
| `official_name` | STRING(512), null | Scraped product title (display/debug) |
| `online_price` | DECIMAL(14,4), null | Bonus; cheap to grab from the same call |
| `source` | STRING(64) | Which scraper produced the row |
| `attempts` | INTEGER, default 0 | Retry accounting |
| `fetched_at` | DATE, null | Last resolution attempt |
| `created_at` / `updated_at` | DATE | Standard timestamps |

`not_found` and `error` are sticky sentinels — never re-queried, except `error`
rows eligible for a slow retry (bounded by `attempts`). `external_order_items`
is **unchanged** — it already carries `item_number`; the card joins on it.

### 2. Resolver — `backend/src/import/enrichment/resolveCostcoProducts.ts`

Mirrors the [expandItemNames.ts](../../../backend/src/import/enrichment/expandItemNames.ts)
shape:
- Injectable `scraperCaller` (test seam, no network in unit tests).
- Pure `parse*` function mapping scraper JSON → candidate products.
- Batch loader over unresolved item numbers.
- `apply*` writer persisting cache rows.
- `maybeResolveCostcoProductsForOrder(...)` gate: no-ops when disabled /
  unconfigured, **never throws** to the caller.

Resolution flow, per unresolved item number:
1. Name-search the scraper by `displayName ?? title`.
2. Take the top 1–2 candidates.
3. Fetch product data for each candidate.
4. **If a candidate's returned item number == receipt `item_number` →
   `resolved`** (store `image_url`, `costco_url`, `official_name`,
   `online_price`). Else → `not_found`.
5. On transport/parse failure → `error`, increment `attempts`.

Rate-limited; daily call-budget cap; vendor-gated to Costco. Default scraper:
Unwrangle (search-results API → product-data API), swappable via the injectable
caller + `source` field.

### 3. Trigger

- **Best-effort async kick** after Costco order ingest — fire-and-forget,
  alongside the existing name-expansion hook in
  [externalOrders.ts](../../../backend/src/routes/externalOrders.ts) (~line 216,
  540). Does not block or slow ingest.
- **Backfill script** `backend/scripts/backfillCostcoProductImages.ts` for the
  existing backlog. Pattern:
  [backfillCostcoItemNames.ts](../../../backend/scripts/backfillCostcoItemNames.ts).

### 4. API + frontend

- Extend `ExternalOrderItemView` (`shared/api-types.ts`) with `imageUrl` and
  `costcoUrl`, joined from `costco_products` by `item_number`.
- [ReceiptItemsDrawer.tsx](../../../frontend/src/components/ReceiptItemsDrawer.tsx)
  `ItemRow`: render a thumbnail when `imageUrl` present (links to `costcoUrl`);
  fall back to the current text card otherwise.

### 5. Config

`COSTCO_ENRICHMENT_*` env, mirroring `enrichmentAiEnabled` /
`getOpenAiConfig()`:
- `COSTCO_SCRAPER_API_KEY` — credentials (resolver no-ops if absent).
- `COSTCO_ENRICHMENT_ENABLED` — feature flag (default off until keyed).
- `COSTCO_ENRICHMENT_DAILY_CALL_CAP` — budget ceiling.

## Accepted constraints

- **ToS:** scraping-by-proxy via a hosted API is a chosen, accepted risk.
- **Coverage:** warehouse-only items get no image (`not_found` sentinel) — by
  design, not a bug.
- **Eventual consistency:** image appears shortly after upload, not instantly.

## Testing

- Resolver: pure `parse*` unit tests (candidate mapping, item-number match /
  mismatch → resolved vs not_found). Injectable caller stubs the network.
- Verification gate: matched item number → `resolved` with image; mismatched →
  `not_found`, no image stored.
- Sentinel behavior: `not_found` / `error` rows are not re-queried (except
  bounded `error` retry).
- Budget cap: resolver stops issuing calls past the daily ceiling.
- Card render: `imageUrl` present → thumbnail; absent → text-card fallback.
- Ingest hook: never throws; no-ops cleanly when disabled/unconfigured.

## Out of scope (YAGNI)

- Brand / size fields (redundant with `displayName`).
- Fuzzy / best-effort image display (verified-only).
- Self-hosted scraper (hosted API chosen).
- Synchronous ingest-time resolution.
- Image re-validation / refresh cadence (cache is effectively permanent per
  item number; revisit only if images rot).

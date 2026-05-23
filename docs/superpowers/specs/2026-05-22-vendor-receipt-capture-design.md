# Vendor Receipt Capture — Design

**Date:** 2026-05-22
**Status:** Draft (pending spec review)
**Driver:** Card transactions for Amazon, Apple, and similar vendors land as opaque descriptors (`AMZN MKTP`, `APPLE.COM/BILL`) with no item-level information. Today the only path that populates item detail is the manual Amazon CSV importer at `backend/src/routes/amazon.ts`; Apple has no parser at all. Email forwarding was considered and rejected as a user-facing solution (setup friction in N source mailboxes; provider-agnostic infra cost). A bookmarklet-based capture flow that scrapes vendor purchase-history pages in one click solves both problems without OAuth, without IMAP/Gmail integrations, and without forwarding rules.

## Goal

Add a vendor-agnostic, low-friction capture pipeline that populates `ExternalOrder` + `ExternalOrderItem` rows from in-browser scraping of vendor purchase-history pages, so the existing item-link enrichment stage (`backend/src/import/enrichment/linkItemsStage.ts`) can attach item detail to opaque card transactions for Amazon, Apple, and future vendors.

## Non-goals (deferred to later specs)

- **Paste-text / drop-screenshot ingestion with AI extraction.** Reserved as a layered follow-on. The backend `captureOrders` module designed here is the shared surface it will hit; no Option 1 UI is built in this spec.
- **Mobile capture.** Bookmarklets are desktop-browser-only. Mobile capture (share-sheet / Android web-share-target) is deferred.
- **Backfill of orders older than the page's visible window.** v1 captures what's on the page; Amazon's lazy-loaded older orders require either user scrolling or pagination-walk logic, deferred to v2.
- **Auth changes.** Email + password auth (`backend/src/routes/auth.ts`) stays unchanged.
- **Vendors beyond Amazon and Apple.** Adding Uber / DoorDash / etc. is a one-file-per-vendor extension once v1 ships; not in scope here.
- **Cross-household sharing of captured orders.** Captures attach to the capturing user's household; no sharing semantics added.

## Current state (what already exists)

- **`ExternalOrder` model** (`backend/src/models/ExternalOrder.ts`) — already vendor-agnostic: `vendor`, `vendorOrderId`, `dedupeKey`, `source`, `rawPayload` are all columns. Default `vendor='amazon'`. `dedupeKey` already enforces uniqueness keying.
- **`ExternalOrderItem` model** (`backend/src/models/ExternalOrderItem.ts`) — has `title`, `quantity`, `unitPrice`, `totalPrice`, `inferredCategory`, `businessUsePercent`, `confidence`.
- **Item-link matcher** (`backend/src/import/enrichment/linkItemsStage.ts`) — scores a Transaction against candidate ExternalOrders by amount / orderDate / shipmentDate / paymentLast4 via `scoreAmazonOrderMatch` in `backend/src/amazon/matcher.ts`. Returns a `Signal` with `merchantCanonical`, `autoCategory`, `autoBusiness`, `linkedExternalOrderId`, and a `notes` preview of item titles. **Amazon-specific gates: line 48 (`isAmazonLikeMerchant`) and line 104 (hardcoded `'Amazon'`).**
- **Order loader** (`backend/src/import/enrichment/loaders.ts:loadAmazonOrdersCache`) — loads candidate orders per household. Currently filters to Amazon-like rows.
- **Amazon CSV importer** (`backend/src/routes/amazon.ts`, `backend/src/amazon/importAmazonOrders.ts`) — only existing ExternalOrder ingestion path. Stays.
- **Backfill routine** (`backend/src/import/runEnrichmentBackfill.ts:runBackfill`) — re-runs the enrichment pipeline over a filtered set of transactions; reused for post-capture re-matching.
- **Auth + session model** (`backend/src/auth/middleware.ts`, `backend/src/models/Session.ts`) — cookie-session, scrypt-hashed passwords. Session cookies are same-site so cannot be relied on for cross-origin POSTs from amazon.com / apple.com.

## Architecture overview

Three new pieces, two small surgical changes, zero schema changes to `ExternalOrder` / `ExternalOrderItem`.

**New:**
1. **Per-user capture tokens** — bearer tokens minted in settings, scoped to a single endpoint. New table `user_capture_tokens`.
2. **Generic capture module** — `backend/src/import/vendorCapture.ts` exporting `captureOrders({ householdId, userId, vendor, orders[], source }) → CaptureResult`. Pure-ish (DB writes, no HTTP). Idempotent via `dedupeKey`. Triggers a scoped re-enrichment after writing.
3. **Capture HTTP route** — `POST /api/capture/orders` in `backend/src/routes/capture.ts`. Validates the bearer token, resolves user + household, calls `captureOrders`, returns counts.

**Changed:**
4. **Lift Amazon-isms in `linkItemsStage.ts`** — remove the `isAmazonLikeMerchant` gate (line 48); change the hardcoded `'Amazon'` (line 104) to derive from `order.vendor` via a small canonical-name map.
5. **Generalise loader** in `loaders.ts:loadAmazonOrdersCache` — rename to `loadVendorOrdersCache`, drop the vendor filter, load all of the household's ExternalOrders within a reasonable date window. (Date window already implicit in the matcher; loader stays simple.)

**Frontend:**
6. **Bookmarklet build pipeline** — two TS source files in `frontend/src/bookmarklets/` (`amazon.ts`, `apple.ts`) compiled by Vite into IIFE bundles.
7. **Settings UI** — new "Receipt capture" card in `frontend/src/pages/SettingsPage.tsx` for mint/revoke + drag-to-bookmark-bar install.

## Data model

### New table: `user_capture_tokens`

```
id              integer  primary key, autoincrement
user_id         integer  not null, fk users(id) on delete cascade
token_hash      string(64)  not null, unique           -- sha256(plaintext)
label           string(64)  not null                    -- e.g. "Personal browser"
last_used_at    timestamp  nullable
revoked_at      timestamp  nullable
created_at      timestamp  not null
updated_at      timestamp  not null

index: (user_id, revoked_at) — active-token lookup
```

Migration: `backend/src/migrations/20260522000001-user-capture-tokens.js`. Standard Sequelize migration mirroring the patterns in `20260507000001-auth-households-ownership.js`.

### No changes to `ExternalOrder` / `ExternalOrderItem`

Existing columns cover everything captured. `source` will receive new literal values (`bookmarklet-amazon-v1`, `bookmarklet-apple-v1`) alongside the existing `csv` and `email` values.

## Capture endpoint

### Route

`POST /api/capture/orders` mounted in `backend/src/app.ts` under the existing router structure. Sits outside the normal session-cookie middleware — uses a dedicated `captureAuth` middleware.

### Auth

`Authorization: Bearer cfc_<32-url-safe-chars>`. The `captureAuth` middleware:
1. Reads `Authorization` header; rejects with 401 if missing or wrong format.
2. SHA-256s the plaintext, looks up `user_capture_tokens` by `token_hash`.
3. 401 if no row, or `revoked_at IS NOT NULL`.
4. Resolves `user.id → primary household membership`. 403 if no household.
5. Updates `last_used_at = NOW()` (best-effort; failure doesn't block the request).
6. Attaches `{ user, household, token }` to the request and calls `next()`.

Token plaintext format: `cfc_` prefix + 32 chars from `crypto.randomBytes(24).toString('base64url')`. The prefix is identifiable in logs (regex `cfc_[A-Za-z0-9_-]{32}`) so leaked tokens can be detected. Plaintext is returned exactly once at mint time; only the hash is stored.

### CORS

Capture endpoint adds explicit CORS allowance for:
- `https://www.amazon.com`
- `https://www.amazon.ca`
- `https://www.amazon.co.uk`
- `https://amazon.com` and `https://amazon.ca` (apex)
- `https://reportaproblem.apple.com`

Allows `POST` and `OPTIONS`, allows `Authorization` and `Content-Type` headers, does not allow credentials (no cookies — bearer token is the auth). Lives as a small `captureCors` middleware so it can't be confused with the app-wide CORS policy.

### Request shape

```jsonc
{
  "vendor": "amazon" | "apple",
  "orders": [
    {
      "vendorOrderId": "112-1234567-1234567" | null,
      "orderDate": "2026-05-12",                  // YYYY-MM-DD, required
      "total": 43.21,                              // required
      "currency": "CAD",                           // optional, defaults to 'CAD' (matches ExternalOrder default)
      "paymentLast4": "1234" | null,
      "items": [
        {
          "title": "USB-C Cable",                  // required
          "quantity": 1,                            // optional, defaults to 1
          "totalPrice": 12.99 | null,
          "unitPrice": 12.99 | null
        }
      ],
      "rawSource": "bookmarklet-amazon-v1"          // identifies the scraper version
    }
  ]
}
```

Validation: zod schema in `backend/src/routes/capture.ts`. Reject the request with 400 if validation fails; never partially-accept. Cap `orders.length` at 200 per request; bookmarklet pages well within that.

### Response shape

```jsonc
{
  "created": 7,
  "updated": 2,
  "skipped": 0,
  "orders": [
    {
      "vendorOrderId": "112-1234567-1234567",
      "externalOrderId": 1234,
      "status": "created" | "updated" | "skipped"
    }
  ]
}
```

### Idempotency

Each incoming order gets a `dedupeKey`:
- If `vendorOrderId` present: `dedupeKey = `${vendor}:${vendorOrderId}``.
- Otherwise: `dedupeKey = `${vendor}:hash(orderDate|total|paymentLast4|items[0].title)`` using a stable sha256 truncated to 32 chars.

Upsert by `(household_id, dedupe_key)`:
- **No existing row:** insert ExternalOrder + items. Status `created`.
- **Existing row, new payload has ≥ existing item count:** update header fields, replace items. Status `updated`.
- **Existing row, new payload has fewer items than existing:** update header fields only; leave items untouched. Status `updated`. (Avoids losing detail from a fuller prior capture.)
- **Existing row, payload identical (same item count and titles):** no-op. Status `skipped`.

### Post-capture re-enrichment

After the response is sent (synchronous `res.json(...)` returns first), enqueue an in-process re-enrichment via `setImmediate`:

```ts
setImmediate(() => {
  runBackfill({
    householdId,
    accountId: null,
    limit: null,
    batchSize: 50,
    dryRun: false,
    noReviewFlag: false,
    reviewOnly: false,
    verbose: false,
    // NEW: dateFrom / dateTo computed from captured orders ± 14 days
  }).catch((err) => console.error('[capture] post-capture backfill failed', err));
});
```

`runBackfill` currently has no `dateFrom` / `dateTo` parameters. Add them as part of this work — captured-order date ranges are tight (typically within a year) and an unscoped backfill on a busy household would re-process thousands of unrelated rows on every capture. The added parameters extend the existing `where` builder in `runEnrichmentBackfill.ts` with `date: { [Op.between]: [from, to] }` when both are supplied.

## Matcher changes

Two edits in `backend/src/import/enrichment/linkItemsStage.ts`:

1. **Remove the merchant gate at line 48** (`if (!isAmazonLikeMerchant(...)) return [];`). The amount / date / last4 score in `scoreAmazonOrderMatch` already rejects non-matches; gating by merchant string is redundant once non-Amazon ExternalOrders exist.
2. **Replace hardcoded `merchantCanonical: 'Amazon'` at line 104** with `merchantCanonical: canonicalNameForVendor(best.order.vendor)`. Define `canonicalNameForVendor` in `backend/src/import/enrichment/vendors.ts`:

```ts
const VENDOR_DISPLAY: Record<string, string> = {
  amazon: 'Amazon',
  apple: 'Apple',
};
export function canonicalNameForVendor(vendor: string): string {
  return VENDOR_DISPLAY[vendor.toLowerCase()] ?? vendor;
}
```

Rename `scoreAmazonOrderMatch` → leave the function name (it's used elsewhere); the scoring logic is already vendor-neutral despite the name. A follow-up rename is non-blocking.

Loader change in `backend/src/import/enrichment/loaders.ts`: rename `loadAmazonOrdersCache` → `loadVendorOrdersCache`; remove any vendor filter so all of the household's `ExternalOrder` rows in the date window become candidates. Update the call site in `runEnrichmentBackfill.ts` (one line).

## Bookmarklets

### Source layout

```
frontend/src/bookmarklets/
  amazon.ts        — IIFE entry; scrapes amazon.{com,ca}/gp/your-orders/orders
  apple.ts         — IIFE entry; scrapes reportaproblem.apple.com
  scrape/
    amazon.ts      — pure function: extractAmazonOrdersFromDom(document) → Order[]
    apple.ts       — pure function: extractApplePurchasesFromDom(document) → Order[]
    toast.ts       — DOM toast helper (success / error / info)
    post.ts        — fetch wrapper that takes (apiUrl, token, payload) → response
```

The pure-function `scrape/*` modules are unit-testable against saved HTML fixtures. The `*.ts` entries are thin glue that calls the scraper, then `post`, then `toast`.

### Build

Vite config addition: a second build configuration that emits `frontend/dist/bookmarklets/amazon.js` and `apple.js` as IIFE bundles (no module wrapper). Minified. Each bundle is ≤ a few KB.

### Token embedding

The settings page does **not** ship a static `javascript:` URL. At render time, it:
1. Fetches the compiled bookmarklet text from `/bookmarklets/amazon.js` (or `apple.js`).
2. Prepends a config preamble: `const __CFC_TOKEN__="cfc_…"; const __CFC_API__="https://cashflow.app/api/capture/orders";`.
3. URL-encodes the whole thing.
4. Renders `<a href="javascript:<encoded>" draggable>Capture Amazon orders</a>`.

The bookmarklet source references `__CFC_TOKEN__` / `__CFC_API__` as `declare const` globals. This avoids string-substitution of arbitrary user content and keeps token plaintext only in DOM during the install moment.

### Amazon scraper outline

Target page: `https://www.amazon.{com,ca,co.uk}/gp/your-orders/orders` (also handles `/gp/your-account/order-history` for legacy users).

Per visible order card:
- `order-id` → look for the "Order #" text node inside `.order-header` / `.yohtmlc-order-id`.
- `order-date` → `.order-header .a-color-secondary` first column with a parseable date.
- `total` → `.order-header` "Total" column; parse `$nn.nn` or `CDN$ nn.nn`.
- `paymentLast4` → not generally present in the order list; left null at v1 (matcher tolerates null).
- `items` → each `.a-fixed-left-grid-col .yohtmlc-product-title` (or its successor class) gives a title; per-item price often not in list view, left null. The matcher only needs order total + date for the score; item titles drive the enrichment notes / category.

The scraper is intentionally **defensive**: if zero orders parse, return `[]`. Empty captures hit the route and produce a "no orders found on this page" toast, never a false success.

### Apple scraper outline

Target page: `https://reportaproblem.apple.com/?s=6` (the "All" purchases tab).

Per visible purchase row:
- `vendorOrderId` → not consistently surfaced; left null (dedupe falls back to hash key).
- `orderDate` → row date string parsed to YYYY-MM-DD.
- `total` → row total.
- `paymentLast4` → not in this view; null.
- `items` → one item per row, title from the row's product/app/subscription name.

Apple receipts are one-item-per-purchase, so the orders array has one item each.

### Bookmarklet error handling

Each bookmarklet wraps its work in try/catch. Toast states:

- Success: green toast, "Captured N orders. M already known, K updated."
- Empty: yellow toast, "No orders found on this page. Are you on the order history page?"
- Auth failure (401): red toast, "Cashflow token rejected. Re-mint in Settings."
- Network failure: red toast with status code or "(offline?)".
- Vendor mismatch (e.g. ran Amazon bookmarklet on Apple page): red toast, "Wrong vendor — this is the Amazon capture bookmarklet."

No retries. The user clicks the bookmark again if they want to retry.

## Settings UI

New card section in `frontend/src/pages/SettingsPage.tsx`, after existing cards. States:

### State A — no active token

```
Receipt capture
───────────────
Capture itemised purchase data from Amazon and Apple without forwarding emails.

[ Mint capture token ]
```

### State B — token just minted (visible once)

```
Token created — copy or install now. You won't see it again.

  cfc_<32-char-token>                                       [ Copy ]

Drag to your bookmark bar:

  [↗ Capture Amazon orders ]   [↗ Capture Apple purchases ]

[ Done ]
```

### State C — token exists (returning view)

```
Active token: cfc_abc…xyz  ·  Last used 2 hours ago        [ Revoke ]

Re-install bookmarklets:

  [↗ Capture Amazon orders ]   [↗ Capture Apple purchases ]
```

Token plaintext is shown **only** in State B. State C never reveals plaintext — the bookmarklet hrefs still embed the token but the visible label is just `cfc_abc…xyz` (first 4 + last 3 chars).

Mint endpoint: `POST /api/capture/tokens` → returns `{ id, plaintext, label, createdAt }`. Plaintext only in this response, never re-fetchable.
Revoke endpoint: `DELETE /api/capture/tokens/:id` → sets `revoked_at = NOW()`.
List endpoint: `GET /api/capture/tokens` → returns active tokens without plaintext, with `last_used_at`.

(These endpoints sit under the normal session-cookie middleware, not `captureAuth`.)

## Transaction row affordance

No new UI in v1. Captured orders flow through the existing `linkItemsStage` → existing transaction display surfaces show the linked-order notes and item categories. The matcher already attaches `merchantCanonical` (`'Amazon'` or `'Apple'`) so the row's existing canonical-merchant display shows the right brand without additional plumbing.

## Option 1 hook (deferred, not built)

The `vendorCapture` module accepts `orders[]` regardless of source. When paste-text / drop-screenshot ingestion ships later:
- New route `POST /api/capture/extract` accepts `{ vendor, blob: text | base64Image }`.
- Internally: OpenAI call (using existing `backend/src/config/openai.ts`) extracts an `orders[]` payload.
- Calls `captureOrders(...)` — the same function the bookmarklet route uses.

Net new code: one route, one prompt, one UI drawer. Matching, dedupe, DB, re-enrichment all reused unchanged. `ExternalOrder.source` carries `ai-paste-v1` / `ai-screenshot-v1` so provenance is auditable.

## Testing

Mirror the existing patterns:

- **`backend/test/vendorCapture.test.ts`** — unit tests for `captureOrders()`. Dedupe behaviour: identical payload skips; payload with more items updates; payload with fewer items updates header only. Vendor validation: unknown vendor rejected. Empty `items[]` accepted (header-only orders).
- **`backend/test/integration/captureOrders.test.ts`** — full route hit. Mints a token, POSTs orders, asserts ExternalOrder + items rows, asserts the post-capture backfill links a pre-seeded matching Transaction. Mirrors the structure of `backend/test/integration/backfillEnrichment.test.ts`.
- **`backend/test/integration/captureAuth.test.ts`** — token mint / list / revoke endpoints. 401 on missing/revoked/garbage tokens. CORS preflight returns correct headers for the allowed origins.
- **`frontend/test/bookmarklets/amazon.test.ts`** — `extractAmazonOrdersFromDom` fed against `frontend/test/fixtures/amazon-orders-2026-05.html` (a real saved order-history page with PII redacted). Asserts order count, totals, item titles.
- **`frontend/test/bookmarklets/apple.test.ts`** — same pattern with `apple-reportaproblem-2026-05.html`.

No headless-browser tests for the bookmarklets themselves. The DOM walk is the pure function under test; the IIFE wrapper is glue.

## Failure modes and risks

- **Vendor DOM changes.** Amazon and Apple change their page HTML periodically. Mitigation: pure-function scrapers are easy to update; saved-fixture tests catch regressions; toast on empty result so the user is never confused by silent failure.
- **Amazon TOS.** Personal-use scraping of one's own account history is not legally distinguished from the legitimate use of the site. Risk is low at personal scale. The bookmarklet runs *in the user's own browser session* against the user's *own account* — no headless scraping, no infrastructure pretending to be Amazon.
- **Token leak.** Token grants only ExternalOrder writes for one user's household. Worst case: an attacker with a leaked token writes garbage orders to the household. Mitigation: easy revoke + remint flow in settings; `last_used_at` exposed so the user can spot unexpected use; token prefix `cfc_` makes leaks pattern-detectable.
- **Re-enrichment cost.** Backfill is full-pipeline; running it after every capture could be wasteful. Mitigation: scope by household + the captured-orders date range (this spec adds `dateFrom` / `dateTo` to `runBackfill`). Capture is a manual user action, not high-frequency.
- **Currency mismatches.** Capture payload includes `currency`. Amazon.ca returns CAD; amazon.com returns USD. Order rows store currency; matcher compares totals directly — currency mismatch between an ExternalOrder and a Transaction will not match, which is the correct behaviour. No special handling needed in v1.

## Build sequence

The implementation plan (separate spec, written next via writing-plans) should sequence roughly:

1. Migration + model for `user_capture_tokens`.
2. Token mint / list / revoke routes + tests.
3. `vendorCapture.ts` module + tests.
4. `POST /api/capture/orders` route + CORS middleware + tests.
5. Lift Amazon-isms in `linkItemsStage.ts` + `loaders.ts` + tests for matcher with non-Amazon orders.
6. Post-capture re-enrichment wiring.
7. Bookmarklet source files + Vite build config + fixture tests.
8. Settings UI — mint flow.
9. Settings UI — bookmarklet install flow.
10. End-to-end smoke: real Amazon page → bookmarklet → capture → Transaction enriched.

Each step is independently shippable and testable.

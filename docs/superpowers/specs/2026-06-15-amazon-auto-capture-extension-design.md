# Amazon Auto-Capture Extension — Design

**Date:** 2026-06-15
**Status:** Approved (design); implementation pending
**Session:** amazon-ux-rework

## Problem

The Amazon integration *feels* clunky and illegible. Diagnosis (via interview)
located the root cause: **ingest is manual, so the data is stale or empty.** The
user uses neither the CSV-export path nor the existing bookmarklet, because both
require remembering to act. The page then looks broken because it renders a
near-empty table. The "separate island" and "can't make sense of the orders"
complaints are largely *downstream of stale data*.

Amazon offers individuals **no API**. Order data has only three possible sources:
the orders web page (scrape), the exported report (manual + slow), or the emails
Amazon sends. Email-routing infra was explicitly rejected as too much setup.
Gmail OAuth was rejected (restricted scope forces 7-day re-auth in testing mode).

**Chosen fix:** a browser extension that auto-captures orders the moment the user
opens *Your Orders* — upgrading the forget-prone bookmarklet into something that
fires itself. The one-time cost (install once, paste a token once) was explicitly
accepted.

## Goals

- Capture Amazon orders with **zero per-use effort once installed** — no clicking,
  no navigating to a special page beyond the orders page the user already visits.
- Capture **full itemization** (items, per-item price/quantity, currency, payment
  last4) so orders are legible, not stubs.
- Make ingest **end-to-end**: captured data auto-matches to transactions with no
  follow-up button click.
- Make the page **degrade gracefully** when data is sparse (freshness chip + a real
  empty state) instead of looking broken.

## Non-Goals (explicitly deferred)

- The deep AmazonPage legibility rebuild (collapsing the two parallel lists —
  "review transactions" + "recent orders" — into a single transaction-anchored
  ledger). Logged as a follow-up; not in this pass.
- Background / silent same-origin fetching of the orders page. The extension fires
  **only** when the user is actually viewing their orders.
- Chrome Web Store distribution. v1 is **load-unpacked + README** only.
- Auto-pairing the token from the app. v1 uses a manual one-time paste.
- Gmail OAuth, inbound-email webhooks, the unwired `parseAmazonReceiptEmail.ts`
  path — all out of scope and untouched.

## Decisions (locked)

| Question | Decision |
|---|---|
| Capture trigger | **Only on the orders page** — content script on the live DOM. No background fetch. |
| Auth / pairing | **Paste once** — capture token + API base URL into the extension Options page. |
| Page scope | **"Last synced" chip + non-broken empty state only.** Defer the rebuild. |
| Distribution | **Load unpacked + README.** No Web Store in v1. |
| Browser / manifest | **Chrome, Manifest V3.** |
| Where it's built | Inside the **`frontend`** workspace as a new Vite target, sharing `scrape/amazon.ts`. |

## Architecture

### Component 1 — Chrome MV3 extension

Built inside the `frontend` workspace via a new Vite config
(`vite.extension.config.ts`, modeled on the existing `vite.bookmarklets.config.ts`),
emitting to `frontend/dist-extension/`. It **shares** the scraper module
(`frontend/src/bookmarklets/scrape/amazon.ts`) — no duplication.

Pieces:

- **`manifest.json`** (MV3):
  - `content_scripts` matched to Amazon order-history URLs (e.g.
    `https://www.amazon.*/...order-history*`, `.../css/order-history*`, and the
    regional variants the scraper already understands).
  - `permissions`: `storage`.
  - `host_permissions`: `https://www.amazon.*/*` and the configured API origin.
  - `options_page`.
  - `action` (toolbar icon + badge for capture feedback).
- **Content script** (orders page only): runs the shared scraper against the live
  logged-in DOM → builds the capture payload (`CapturedOrderInput[]`, the shape
  `/api/capture/orders` already accepts) → `chrome.runtime.sendMessage` to the
  background worker. Does **not** itself hold the token.
- **Background service worker**: reads `{ apiBase, token }` from `chrome.storage`,
  POSTs the payload to `${apiBase}/api/capture/orders` with the bearer token
  (endpoint already enforces bearer-auth + CORS + per-IP rate-limit). Sets a
  toolbar badge: green/count on success, red on failure; logs failures to the
  service-worker console. If no token is configured, badge prompts the user to
  open Options.
- **Options page**: two fields — **API base URL**, **capture token** — persisted to
  `chrome.storage.sync`. Inline help linking to the Cashflow Settings page where
  capture tokens are minted. A "Test connection" button that POSTs an empty/ping
  request and reports auth validity.

### Component 2 — Scraper upgrade (shared)

`frontend/src/bookmarklets/scrape/amazon.ts` today extracts only order
date/total/id and bare product titles. Extend to:

- Full **item list**: title, **quantity**, **per-item price**, item number/ASIN
  when present in the DOM.
- **Currency detection** from the DOM (`CDN$` / `US$` / `$` / `USD` …), replacing
  the hardcoded-CAD `TODO` at `scrape/amazon.ts:66`.
- **Payment last4** when surfaced on the orders page.

Because the module is shared, the existing bookmarklet inherits these improvements
for free.

### Component 3 — Backend

- **`/api/capture/orders`** (existing): ingest path unchanged, but **auto-run
  matching after a successful capture write.** Today `runAmazonMatching` only fires
  from the page's "Run matching" button; without this, captured data arrives but
  the user must still click. Captured orders are tagged `source =
  'extension-amazon-v1'` to distinguish them from `bookmarklet-amazon-v1`.
  - Matching reuses `runAmazonMatching` (`backend/src/amazon/matcher.ts`) and its
    existing fan-out guard. Run it scoped to the just-captured orders' date window
    (the capture path already schedules a ±14-day enrichment backfill — reuse that
    window) to avoid a full-table rescan on every capture.
- **`GET /api/amazon/sync-status`** (new): returns
  `{ lastCapturedAt, orderCount }`, **derived** from existing `ExternalOrder` rows
  (max `createdAt` + count for the household's Amazon orders). No new table — this
  is a derived view per the primitives spine (Document/Observation folds, not a new
  status machine).

### Component 4 — AmazonPage (light touch)

- **Freshness chip**: "Synced 2h ago" / "Synced just now" from `sync-status`.
- **Empty state**: when `orderCount === 0`, replace the empty table with a setup
  prompt — "No Amazon data yet" + concise install/connect steps + link to mint a
  token — so an un-set-up integration reads as *not configured*, not *broken*.
- No other AmazonPage changes. The two-list rebuild stays deferred.

## Data Flow

```
User opens amazon.* "Your Orders"
  → content script scrapes live DOM (full items + currency + last4)
  → sendMessage → background worker
  → POST /api/capture/orders  (bearer token from chrome.storage)
      → processCapturePayload (validate vendor/date/total/items)
      → captureOrders() writes ExternalOrder + ExternalOrderItem[] (source=extension-amazon-v1)
      → AUTO: runAmazonMatching(scoped to captured date window)
          → upsert TransactionOrderLink (status=suggested), fan-out guard intact
  → badge: captured N orders
App AmazonPage
  → GET /api/amazon/sync-status → freshness chip / empty-state decision
  → suggested links already present (no "Run matching" click needed)
```

## Error Handling

- **Scraper finds nothing / DOM changed**: content script reports zero orders;
  background sets a neutral badge ("0"), does not error-spam. The page's staleness
  chip is the backstop signal that capture isn't landing.
- **No token configured**: background skips the POST, badge prompts Options.
- **Auth failure (401/403)**: red badge + console log; Options "Test connection"
  surfaces it explicitly.
- **Rate-limited (429)**: background backs off; capture is idempotent
  (`dedupeKey`), so a later retry is safe.
- **Capture validation rejects a row**: existing endpoint behavior — partial
  success with a per-row failure summary; surfaced in the background console.

## Security

- The extension stores a **capture-scoped bearer token** (already exists, narrower
  than OAuth) and POSTs cross-origin to the configured API — same trust model as
  today's bookmarklet.
- Orders-page-only trigger means **no silent background fetching** of the user's
  Amazon account; nothing fires unless the user is already viewing their own
  orders.
- Token lives in `chrome.storage.sync` (per-profile). README notes that minting a
  fresh token and revoking the old one rotates access.

## Testing

- **Scraper** (`scrape/amazon.ts`): vitest over saved Amazon order-history HTML
  fixtures — multi-item orders, refunds/negatives, `CDN$` vs `US$` vs `$` currency
  cases, missing-last4, missing-item-price. Pure-function coverage of the parser is
  the core safety net.
- **Backend**:
  - `GET /api/amazon/sync-status`: empty household, populated household, freshness
    ordering.
  - Auto-match-on-capture: capturing an order that matches an existing transaction
    yields a `suggested` `TransactionOrderLink` with **no** explicit "Run matching"
    call; fan-out guard still suppresses tied ambiguous matches.
- **Extension wiring**: manual smoke (load unpacked → open orders page → confirm
  capture + badge + links appear). MV3 end-to-end automation is not worth it for
  v1.

## Deliverables

1. `frontend/vite.extension.config.ts` + extension source (`manifest.json`,
   content script, background worker, options page) → builds to `dist-extension/`.
2. Upgraded shared `scrape/amazon.ts` (items, currency, last4) + fixtures + tests.
3. Backend: auto-match-on-capture; `GET /api/amazon/sync-status` + tests.
4. AmazonPage freshness chip + empty state.
5. `frontend/dist-extension/README.md` — load-unpacked install steps + token paste.

## Follow-ups (not this pass)

- AmazonPage legibility rebuild: collapse "review transactions" + "recent orders"
  into one transaction-anchored ledger with two exception buckets (orders with no
  transaction; Amazon charges with no order).
- Optional graduation to a Chrome Web Store **unlisted** listing if the
  developer-mode startup nag becomes annoying (no code change — packaging only).

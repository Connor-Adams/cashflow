# Receipt visibility — making the emailed-receipt pipeline legible

- **Date:** 2026-05-31
- **Status:** Approved design, pre-implementation
- **Author:** Connor (via brainstorming)

## Problem

The Gmail emailed-receipt integration shipped to prod as PR #47 (merge `2a8aaac`,
2026-05-23) and is functionally complete: OAuth connect, inbox scan, vendor
parsers (Apple/Google/Amazon/Uber/Lyft/DoorDash/Netflix/Spotify) + AI fallback,
`ExternalOrder` creation, and matching to card `Transaction`s via
`TransactionOrderLink`.

It is **invisible**. Connor requested "build a Gmail integration to get emailed
receipts" on 2026-05-31 not knowing it already exists, and has **never
connected** it. The real problem is not the pipeline — it is that:

1. **No signpost.** The only entry point is a card buried in Settings
   (`frontend/src/pages/settings/sections/GmailSection.tsx`). Nothing on the
   dashboard, nav, or anywhere else hints the feature exists. `/api/email/status`
   is fetched only when Settings loads.
2. **Ephemeral.** Scan results live in React state in `GmailSection` and vanish
   on reload. `ProcessedEmailMessage` rows accumulate in the DB but there is **no
   read endpoint** for them. The receipts created (`ExternalOrder`) have no
   browse surface (except the Amazon-scoped `AmazonPage`).

This is a classic X–Y: asked to build X (the integration), the real problem is
"I can't see that X exists or what it has done."

## Goal

Make the dormant pipeline **discoverable** and its activity **persistently
legible**, with two moves:

- **Signpost** — a dashboard tile + nav entry that surface the feature whether
  or not it is connected.
- **Persistent home** — a `/receipts` page that reads back the data the pipeline
  already produces (scan history + receipts + link status).

## Non-goals (explicit boundaries)

These are real adjacent gaps but are **out of scope** for this work:

- **No auto-scan** background/cron job. Scan stays manual (user-triggered).
- **No receipt → transaction creation.** Receipts continue to attach to existing
  card transactions; orphan receipts (no card line) are *shown* but not promoted
  to transactions.
- **No `/inbox` or `/insights` wiring.** Surfacing scan outcomes as review-items
  or Observations is a separate PR.
- **No new tables, no model changes, no primitives-spine change.**
- **No generalization of the Amazon write toolkit.** Match/run, AI-categorize,
  link accept/reject, CSV import, item edit stay Amazon-scoped under the
  `vendor=amazon` filter. Generalizing them to all `ExternalOrder`s is a
  follow-on.

## Primitives-spine check

Per `CLAUDE.md` / `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`:

- This introduces **no new status machine**. It is a **view/derivation** over
  existing primitives:
  - `ExternalOrder` (Document-primitive variant) — the captured receipt/order,
    regardless of source (`email_gmail_*`, Amazon CSV, bookmarklet). This is the
    canonical receipt record; the `/receipts` page is a view over it.
  - `ProcessedEmailMessage` — the per-message scan log (idempotency + outcome).
  - `TransactionOrderLink` — receipt ↔ transaction linkage (link status).
  - `UserEmailIntegration` — connection state (already read via `/api/email/status`).
- **No table is added.** Two read endpoints and frontend surfaces only.
- The fact that Amazon receipts and Gmail receipts are the *same* `ExternalOrder`
  primitive is why a single `/receipts` page is spine-honest and `AmazonPage`
  becomes a vendor-filtered slice of it — not a fork.

## Architecture

Three layers: read endpoints (backend), the `/receipts` page (frontend), and the
discoverability surfaces (dashboard tile + nav).

### 1. Backend — read endpoints

The pipeline writes plenty; almost nothing reads it back. Add read-only paths.

**1a. Vendor-agnostic order list.**
`GET /api/amazon/orders` (`backend/src/routes/amazon.ts:110`) already lists
`ExternalOrder`s with items — it is an Amazon-scoped version of exactly what the
receipts list needs. Promote a vendor-agnostic list:

- `GET /api/orders` — list `ExternalOrder`s for the caller's household.
  - Query params: `source` (e.g. `email_gmail_apple`), `vendor`, `linkStatus`
    (`linked` | `needs_match` | `orphan`), `limit`, `cursor`/`offset`.
  - Response per order: `id`, `vendor`, `source`, `orderDate`, `total`,
    `currency`, `paymentLast4`, item count (or items), and **link status**
    derived from joined `TransactionOrderLink` rows (see §Link-status semantics).
  - Reuse the household scoping + serialization already in `amazon.ts`.
  - Confirm the mount point during planning: `backend/src/routes/externalOrders.ts`
    already exists (`:80` does `findOrCreate`) — reuse that router if it is the
    natural home for a generic ExternalOrder read endpoint; otherwise add a small
    `orders` router. The Amazon route may delegate to the shared query helper.

**1b. Scan history.**
`GET /api/email/history` (in `backend/src/routes/emailIntegrations.ts`) over
`ProcessedEmailMessage` for the household:

- Returns recent scan messages: `messageId`, `subject`, `fromAddr`, `status`
  (`extracted` | `filtered_subject` | `no_items` | `extraction_failed` |
  `duplicate`), `parser`, `externalOrderId`, `errorMessage`, `scannedAt`.
- Supports `limit` + cursor; default newest-first.
- This is the persistent "what has Gmail done" log that currently has no read
  path — the fix for the ephemerality wound.

**1c. Connection state** — already served by `GET /api/email/status`
(`emailIntegrations.ts:40`). No change.

All three are read-only, household-scoped via `currentAuth`, and follow existing
route + error-handling patterns.

### 2. Frontend — `/receipts` page (the persistent home)

New route `/receipts` (`ReceiptsPage`), registered in `frontend/src/App.tsx`,
nav entry in the **Money** section of `Sidebar.tsx`. Three bands:

**Band A — Gmail status strip (the discovery hook).**
Reads `/api/email/status`.
- **Dormant (never connected):** prominent "Connect Gmail" CTA + one-line
  explanation. This is the band that closes "I had no idea."
- **Connected:** account email, last scan time, a **Scan** button that reuses the
  existing NDJSON streaming endpoint (`POST /api/email/scan/google?stream=1`) and
  live feed — extract that logic from `GmailSection` into a shared hook/component
  so both Settings and `/receipts` use it.
- If the server feature flag is off (`emailIntegrationEnabled === false`), show
  the existing operator-config hint.

**Band B — Scan history (collapsible).**
Reads `/api/email/history`. A compact table of recent runs/messages with outcome
badges. Replaces the ephemeral in-memory feed with a durable record.

**Band C — Receipts list.**
Reads `GET /api/orders`. Source filter (All / Gmail / Amazon / bookmarklet). Each
row: vendor · order date · total · **source badge** · **link status** (linked ✓ /
needs-match / orphan) · expand → line items (`ExternalOrderItem`: title, qty,
unit/total price, inferred category). Empty state when no receipts yet.

### 3. Amazon reconciliation (fold-in)

`/receipts` is canonical. `AmazonPage`'s full feature set is preserved as the
**`vendor=amazon` filtered view** of `/receipts`:

- **Routing:** `/amazon` → redirect to `/receipts?vendor=amazon` (React Router
  `<Navigate>`). Drop the standalone "Amazon" nav entry from `Sidebar.tsx`.
- **Shared table:** extract the orders/items table from `AmazonPage` into a shared
  component used by `ReceiptsPage` Band C.
- **Amazon write affordances stay Amazon-scoped** and render **only when the
  `vendor=amazon` filter is active**: CSV import (`POST /api/amazon/import`),
  match run (`/api/amazon/match/run`), AI categorize (`/api/amazon/categorize/run`),
  link accept/reject/manual/delete (`/api/amazon/links/*`), item edit
  (`PATCH /api/amazon/orders/:id/items/:itemId`), review-transactions
  (`/api/amazon/review-transactions`). These keep their `/api/amazon/*` endpoints
  unchanged this PR.
- **Gmail (and other non-Amazon) receipts** in Band C are **read-only** for now:
  view receipt + items + link status. Triggering matching for Gmail receipts
  continues to use the existing backfill path referenced in `GmailSection`
  ("run the backfill to attach orders to card transactions"); a per-receipt match
  button for non-Amazon sources is a follow-on, not this PR.

This is the heaviest part of the work and must be scoped accordingly: it is a
**frontend refactor** (extract shared table, mount Amazon affordances behind a
filter, redirect the route) — not a backend generalization of the Amazon toolkit.

### 4. Discoverability — dashboard tile + nav

- **Nav:** "Receipts" item in the **Money** section of `Sidebar.tsx`
  (icon `ReceiptText` or `Mail`). Optional count badge (receipts needing match,
  or recent) following the existing `useAiInboxCount`/`useInsightsCount` badge
  pattern — badge is optional polish, not required for v1.
- **Dashboard:** a new dedicated tile (sibling to `ReceiptCoverageTile`, following
  the `BentoTile` pattern in `frontend/src/components/dashboard/`):
  - **Dormant:** loud — "Emailed receipts — not connected. Connect Gmail →"
    linking to `/receipts`. This is the primary fix for the "I had no idea"
    problem.
  - **Connected:** quiet stat — "N receipts this month →" linking to `/receipts`.
  - Reads `/api/email/status` (+ a count from `/api/orders`).

## Link-status semantics

Derived per `ExternalOrder` from `TransactionOrderLink` rows:

- **linked** — has a `TransactionOrderLink` with `status = 'accepted'` (or
  confirmed equivalent).
- **needs-match** — has only `suggested` link(s) awaiting confirmation.
- **orphan** — no links. (Common for cash purchases / unsynced accounts / timing
  gaps — explicitly shown, not promoted to a transaction.)

Confirm the exact status vocabulary against `TransactionOrderLink` (`status`
default `'suggested'`; Amazon uses `suggested`/`accepted`/`rejected`) during
planning so the derivation matches reality.

## States to handle

- Feature flag off (operator hasn't configured OAuth).
- Dormant (flag on, not connected) — the common case for Connor.
- Connected, zero receipts (never scanned).
- Connected, scanning (live stream).
- Connected, populated (history + receipts list).
- Disconnected mid-use / token-expired (`status` / `statusReason` from
  `UserEmailIntegration`).

## Testing (TDD)

- **Backend:**
  - `GET /api/orders` — household scoping, `source`/`vendor`/`linkStatus`
    filters, link-status derivation join, pagination.
  - `GET /api/email/history` — scoping, ordering, status mapping, pagination.
- **Frontend:**
  - `ReceiptsPage` render states (flag-off / dormant / empty / populated /
    Amazon-filter affordances visible only under `vendor=amazon`).
  - Nav entry present; `/amazon` redirects to `/receipts?vendor=amazon`.
  - Dashboard tile dormant vs connected variants.
  - Shared scan-stream hook behaves in both Settings and `/receipts`.
  - Follow existing patterns: `GmailSection.test.tsx`, `AmazonPage` tests,
    dashboard `*Tile.test.tsx`.

## Build sequence (high level)

Detailed plan comes from the writing-plans skill. Rough order:

1. Backend read endpoints (`/api/orders`, `/api/email/history`) + tests.
2. Extract shared scan-stream hook/component out of `GmailSection`.
3. Extract shared orders/items table out of `AmazonPage`.
4. `ReceiptsPage` (three bands) + route + nav entry.
5. Mount Amazon affordances behind `vendor=amazon`; redirect `/amazon`; drop
   Amazon nav entry.
6. Dashboard tile (dormant + connected variants).
7. Full-suite verification.

## Resolved decisions

- Scope **B** (signpost + persistent page), manual scan retained.
- Receipts surface shows **all captured receipts**; Amazon becomes a filtered
  view.
- Amazon reconciliation: **fold in** — `/amazon` redirects to
  `/receipts?vendor=amazon`, standalone Amazon nav entry dropped.
- Dashboard: **new dedicated tile**.
- Endpoint named `/api/orders` (vendor-agnostic); page labeled "Receipts"
  (user-facing) though it rides on the `ExternalOrder` model. (`/api/receipts`
  is already taken by the `Receipt` file-attachment route.)

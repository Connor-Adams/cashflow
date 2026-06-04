# Costco Google-Image Best-Effort Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Add a free, provider-switchable Google Custom Search image source for Costco product thumbnails, alongside the existing verified-only Unwrangle path.

**Why:** Unwrangle has a $100/mo floor. Costco's bot wall (Akamai) blocks server-side scraping, so the data needs *some* paid/keyed source — but Costco **images live on a CDN that loads fine in the browser**, and Google Custom Search (free, 100 queries/day) can find them. Google returns an image, not the item number, so it cannot satisfy the strict verified-only gate. This plan adds a **best-effort** path: parse the Costco item number out of the Google result's title/snippet/URL when present (→ `verified=true`), otherwise accept the top costco.com image as a **guess** (`verified=false`). The cache makes 100/day plenty.

**Design decisions (settled):**
- Best-effort match: verify when the item number is recoverable from Google's result text; otherwise store a guess flagged `verified=false`.
- The strict Unwrangle path is unchanged and still sets `verified=true`.
- A `COSTCO_SCRAPER_PROVIDER` env switch (`unwrangle` | `google`) selects the path.
- `verified` is persisted on `costco_products` and surfaced to the UI so guesses can be de-emphasized.

**Tech Stack:** TypeScript, Sequelize (Postgres), `node:test`, React. New source: Google Custom Search JSON API.

**Builds on:** `docs/superpowers/plans/2026-06-03-costco-product-cards.md` (merged in PR #547).

---

## Key architectural change: loader takes a per-item resolver

Today `resolveCostcoProductsForItemNumbers(items, caller, opts)` calls `resolveOneItemNumber(num, name, caller)` directly — hard-wired to the Unwrangle two-step `CostcoScraperCaller`. Google is one-step with a different shape. Refactor the loader to accept a **per-item resolver callback** `(itemNumber, name) => Promise<ResolvedProduct>`, so the loader owns dedup/skip/cap/upsert and is agnostic to *how* one item resolves. Each provider supplies its own closure. This keeps both paths clean and is the smallest abstraction that fits both.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/src/migrations/20260620000002-costco-products-verified.js` | Add `verified` column | Create |
| `backend/src/models/CostcoProduct.ts` | Add `verified` field | Modify |
| `backend/src/import/enrichment/resolveCostcoProducts.ts` | `verified` on ResolvedProduct; loader takes per-item resolver; provider wiring | Modify |
| `backend/src/integrations/costco/itemNumberFromText.ts` | Pure: parse Costco item number from text | Create |
| `backend/src/integrations/costco/googleImageCaller.ts` | Google CSE adapter + best-effort per-item resolver | Create |
| `backend/src/config/costco.ts` | `getCostcoProvider()`, `getGoogleCseConfig()` | Modify |
| `backend/src/routes/receipts.ts` | Surface `verified` on item view | Modify |
| `shared/api-types.ts` | Add `imageVerified?` to `ExternalOrderItemView` | Modify |
| `frontend/src/components/items/ItemRow.tsx` | De-emphasize guessed (unverified) thumbnails | Modify |
| `backend/.env.example` | Document Google + provider vars | Modify |
| Tests | unit + integration | Create/Modify |

**Test commands:**
- Unit: `cd backend && npx tsx --import ./test/setup.ts --test test/<file>.test.ts`
- Integration: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/costcoProductImages.test.ts`
- (Worktree needs `node_modules` symlink to main root for tooling: `ln -s /Users/connoradams/Developer/cashflow/node_modules <worktree>/node_modules`.)

---

## Task G1: Migration — add `verified` column

**Files:** Create `backend/src/migrations/20260620000002-costco-products-verified.js`

- [ ] **Step 1: Write migration**

```javascript
'use strict';
/**
 * costco_products.verified: whether the cached product was confirmed to match
 * the receipt's item number (true) or is a best-effort guess from a source that
 * could not return the item number, e.g. Google image search (false). The
 * strict Unwrangle path always sets true. Existing rows are verified (the only
 * prior writer was the strict path), so backfill defaultValue: true.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('costco_products', 'verified', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('costco_products', 'verified');
  },
};
```

- [ ] **Step 2: Run** `cd backend && npx sequelize-cli db:migrate` — expect `migrated`. (If no DB, note as env concern; file is the deliverable.)
- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260620000002-costco-products-verified.js
git commit --no-verify -m "feat(costco): add verified column to costco_products"
```

---

## Task G2: Model `verified` + ResolvedProduct.verified + upsert

**Files:** Modify `backend/src/models/CostcoProduct.ts`, `backend/src/import/enrichment/resolveCostcoProducts.ts`

- [ ] **Step 1: Add to model.** In `CostcoProduct.ts`, add the declare + init field (mirror the boolean style; place after `source`):

declare line (after `declare source: string | null;`):
```typescript
  declare verified: CreationOptional<boolean>;
```
init attribute (after the `source` attribute):
```typescript
      verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
```

- [ ] **Step 2: Add `verified` to `ResolvedProduct`** in `resolveCostcoProducts.ts`:

In the `ResolvedProduct` type, add `verified: boolean;`. In the `notFound(...)` helper add `verified: true` (a not_found row carries no image, the flag is irrelevant; use true so it's never treated as a guess). In `resolveOneItemNumber`'s `resolved` return add `verified: true` (strict path is always verified). In the catch's `error` return add `verified: true`.

- [ ] **Step 3: Persist `verified` in `upsertResolved`.** Add `verified: r.verified` to BOTH the `defaults` object and the `row.update(...)` object.

- [ ] **Step 4: Verify** `cd backend && npx tsc --noEmit` (no errors) and run unit + integration test files — existing tests still pass (they don't assert `verified`, which defaults true).

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/CostcoProduct.ts backend/src/import/enrichment/resolveCostcoProducts.ts
git commit --no-verify -m "feat(costco): thread verified flag through model + resolved product"
```

---

## Task G3: Pure item-number-from-text parser (TDD)

**Files:** Create `backend/src/integrations/costco/itemNumberFromText.ts`, `backend/test/itemNumberFromText.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemNumberFromText } from '../src/integrations/costco/itemNumberFromText';

test('extracts item number after "Item" label', () => {
  assert.equal(itemNumberFromText('Kirkland Peanut Butter Item 1011242 | Costco'), '1011242');
  assert.equal(itemNumberFromText('... Item #1011242 ...'), '1011242');
  assert.equal(itemNumberFromText('Item No. 1011242'), '1011242');
  assert.equal(itemNumberFromText('item:1011242'), '1011242');
});

test('returns null when no item-number pattern present', () => {
  assert.equal(itemNumberFromText('Kirkland Peanut Butter | Costco'), null);
  assert.equal(itemNumberFromText(''), null);
  // a bare number with no "item" label is NOT treated as an item number (too risky)
  assert.equal(itemNumberFromText('Pack of 1011242 calories'), null);
});

test('first labeled match wins', () => {
  assert.equal(itemNumberFromText('Item 1011242 ... Item 9999999'), '1011242');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```typescript
// backend/src/integrations/costco/itemNumberFromText.ts
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
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/costco/itemNumberFromText.ts backend/test/itemNumberFromText.test.ts
git commit --no-verify -m "feat(costco): pure item-number-from-text parser"
```

---

## Task G4: Loader refactor — per-item resolver callback (TDD)

**Files:** Modify `backend/src/import/enrichment/resolveCostcoProducts.ts`, `backend/test/integration/costcoProductImages.test.ts`

- [ ] **Step 1: Change the loader signature.** Replace `resolveCostcoProductsForItemNumbers(items, caller, opts?)` so its second param is a per-item resolver:

```typescript
export type PerItemResolver = (itemNumber: string, name: string) => Promise<ResolvedProduct>;

export async function resolveCostcoProductsForItemNumbers(
  items: ItemNumberToResolve[],
  resolveItem: PerItemResolver,
  opts?: { maxItems?: number },
): Promise<number> {
  // ... unchanged dedup/skip/cap/upsert, but the loop body calls:
  //   const result = await resolveItem(num, byNumber.get(num) ?? num);
}
```
Keep everything else (dedup, skip set incl. MAX_ERROR_ATTEMPTS, cap, upsert) identical — only swap `resolveOneItemNumber(num, name, caller)` for `resolveItem(num, byNumber.get(num) ?? num)`.

- [ ] **Step 2: Provide a strict-resolver factory** so the Unwrangle path keeps working:

```typescript
/** Build a per-item resolver for the strict (item-number-verified) scraper path. */
export function strictResolver(caller: CostcoScraperCaller): PerItemResolver {
  return (itemNumber, name) => resolveOneItemNumber(itemNumber, name, caller);
}
```

- [ ] **Step 3: Update `maybeResolveCostcoProductsForOrder`** to build the resolver (provider wiring comes in G6; for now keep Unwrangle):
```typescript
    return await resolveCostcoProductsForItemNumbers(toResolve, strictResolver(caller));
```

- [ ] **Step 4: Update the integration test** (`costcoProductImages.test.ts`) — the three existing tests pass a `caller`; wrap them: replace `caller` arg to `resolveCostcoProductsForItemNumbers(items, caller, opts)` with `resolveCostcoProductsForItemNumbers(items, resolve.strictResolver(caller), opts)`. (Import `strictResolver` via the existing `resolve` module namespace.) Keep assertions identical.

- [ ] **Step 5: Update the backfill script** `backend/scripts/backfillCostcoProductImages.ts`: it calls `resolveCostcoProductsForItemNumbers(candidates, caller, ...)` — change to `strictResolver(caller)` for now (provider switch added in G6). Import `strictResolver`.

- [ ] **Step 6: Verify** `tsc --noEmit` clean; run unit + integration files — all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/import/enrichment/resolveCostcoProducts.ts backend/test/integration/costcoProductImages.test.ts backend/scripts/backfillCostcoProductImages.ts
git commit --no-verify -m "refactor(costco): loader takes per-item resolver callback"
```

---

## Task G5: Google CSE adapter + best-effort resolver (TDD)

**Files:** Create `backend/src/integrations/costco/googleImageCaller.ts`, `backend/test/googleImageCaller.test.ts`; modify `backend/src/config/costco.ts`

- [ ] **Step 1: Add config readers to `backend/src/config/costco.ts`:**

```typescript
/** Which Costco enrichment source to use. */
export function getCostcoProvider(): 'unwrangle' | 'google' {
  const p = process.env.COSTCO_SCRAPER_PROVIDER?.trim().toLowerCase();
  return p === 'google' ? 'google' : 'unwrangle';
}

/** Google Custom Search (free image source). Null if unconfigured. */
export function getGoogleCseConfig(): { apiKey: string; cx: string } | null {
  const apiKey = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_CX?.trim();
  if (!apiKey || !cx) return null;
  return { apiKey, cx };
}
```

- [ ] **Step 2: Failing test `backend/test/googleImageCaller.test.ts`** (uses an injected fetch; asserts verified vs guessed):

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGoogleBestEffortResolver } from '../src/integrations/costco/googleImageCaller';

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, status: ok ? 200 : 500, async json() { return payload; }, async text() { return JSON.stringify(payload); } }) as Response) as unknown as typeof fetch;
}

test('verified=true when item number is recoverable from result text and matches', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/a.jpg', title: 'KS Org PB Item 1011242', image: { contextLink: 'https://www.costco.com/x.product.100.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'KS ORG PNT BTR');
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, true);
  assert.equal(out.imageUrl, 'https://img.costco.com/a.jpg');
  assert.equal(out.costcoUrl, 'https://www.costco.com/x.product.100.html');
});

test('verified=false guess when no item number recoverable (takes top result)', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/top.jpg', title: 'Some Costco Product', image: { contextLink: 'https://www.costco.com/y.product.200.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'KS ORG PNT BTR');
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, false);
  assert.equal(out.imageUrl, 'https://img.costco.com/top.jpg');
});

test('a recoverable-but-mismatched item number is NOT accepted as that product (guess instead)', async () => {
  const resolve = makeGoogleBestEffortResolver(
    { apiKey: 'k', cx: 'c' },
    fakeFetch({ items: [
      { link: 'https://img.costco.com/wrong.jpg', title: 'Other Item 9999999', image: { contextLink: 'https://www.costco.com/z.product.300.html' } },
    ] }),
  );
  const out = await resolve('1011242', 'X');
  // top result's recoverable item number 9999999 != 1011242 -> not a verified match,
  // but still the best available image -> guess.
  assert.equal(out.status, 'resolved');
  assert.equal(out.verified, false);
  assert.equal(out.imageUrl, 'https://img.costco.com/wrong.jpg');
});

test('not_found when Google returns no items', async () => {
  const resolve = makeGoogleBestEffortResolver({ apiKey: 'k', cx: 'c' }, fakeFetch({ items: [] }));
  const out = await resolve('1011242', 'X');
  assert.equal(out.status, 'not_found');
});

test('error when fetch fails', async () => {
  const resolve = makeGoogleBestEffortResolver({ apiKey: 'k', cx: 'c' }, fakeFetch({}, false));
  const out = await resolve('1011242', 'X');
  assert.equal(out.status, 'error');
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `backend/src/integrations/costco/googleImageCaller.ts`:**

```typescript
import type { PerItemResolver, ResolvedProduct } from '../../import/enrichment/resolveCostcoProducts';
import { itemNumberFromText } from './itemNumberFromText';
import { itemNumbersMatch } from '../../import/enrichment/resolveCostcoProducts';
import { logger } from '../../observability/logger';

const SOURCE = 'google_cse';
const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

type GoogleItem = { link?: string; title?: string; snippet?: string; image?: { contextLink?: string } };

/**
 * Best-effort per-item resolver backed by Google Custom Search (image mode,
 * site-restricted to costco.com via the CX config). Verified=true only when an
 * item number recovered from a result's text matches the receipt's; otherwise
 * the top result is stored as a guess (verified=false). Never throws.
 */
export function makeGoogleBestEffortResolver(
  cfg: { apiKey: string; cx: string },
  fetchImpl: typeof fetch = fetch,
): PerItemResolver {
  return async (itemNumber, name): Promise<ResolvedProduct> => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set('key', cfg.apiKey);
      url.searchParams.set('cx', cfg.cx);
      url.searchParams.set('searchType', 'image');
      url.searchParams.set('num', '5');
      url.searchParams.set('q', `${name} item ${itemNumber} site:costco.com`);
      const res = await fetchImpl(url.toString());
      if (!res.ok) throw new Error(`Google CSE ${res.status}`);
      const data = (await res.json()) as { items?: GoogleItem[] };
      const items = Array.isArray(data.items) ? data.items : [];
      const candidates = items.filter((it) => typeof it.link === 'string');
      if (candidates.length === 0) {
        return { itemNumber, status: 'not_found', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: SOURCE, verified: true };
      }
      // Prefer a result whose recoverable item number matches the receipt's.
      const verified = candidates.find((it) => {
        const found = itemNumberFromText(`${it.title ?? ''} ${it.snippet ?? ''} ${it.image?.contextLink ?? ''}`);
        return itemNumbersMatch(itemNumber, found);
      });
      const chosen = verified ?? candidates[0];
      return {
        itemNumber,
        status: 'resolved',
        imageUrl: chosen.link as string,
        costcoUrl: chosen.image?.contextLink ?? null,
        officialName: chosen.title ?? null,
        onlinePrice: null,
        source: SOURCE,
        verified: Boolean(verified),
      };
    } catch (err) {
      logger.warn({ err, itemNumber, module: 'googleImageCaller' }, 'costco_google_resolve_failed');
      return { itemNumber, status: 'error', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: SOURCE, verified: true };
    }
  };
}
```
NOTE: `itemNumbersMatch` and the types `PerItemResolver`/`ResolvedProduct` are already exported from `resolveCostcoProducts.ts` (G4 added `PerItemResolver`). If importing `itemNumbersMatch` as a value from that module creates an unwanted cycle at runtime, it is a pure function with no module-load side effects, so the cycle is benign; if tsc/lint complains, move `itemNumbersMatch` + `itemNumberFromText` usage is fine — report as concern rather than restructuring.

- [ ] **Step 5: Run → PASS (5 tests).**
- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/costco/googleImageCaller.ts backend/test/googleImageCaller.test.ts backend/src/config/costco.ts
git commit --no-verify -m "feat(costco): Google CSE best-effort image resolver"
```

---

## Task G6: Provider wiring (gate + backfill)

**Files:** Modify `backend/src/import/enrichment/resolveCostcoProducts.ts`, `backend/scripts/backfillCostcoProductImages.ts`

- [ ] **Step 1: Add a resolver-selection helper** in `resolveCostcoProducts.ts` that returns the right per-item resolver + a label, or null when unconfigured:

```typescript
import { getCostcoProvider, getGoogleCseConfig } from '../../config/costco';
import { makeGoogleBestEffortResolver } from '../../integrations/costco/googleImageCaller';

/** Pick the configured provider's per-item resolver, or null if unconfigured. */
export function selectResolver(opts?: { caller?: CostcoScraperCaller }): PerItemResolver | null {
  if (getCostcoProvider() === 'google') {
    const cfg = getGoogleCseConfig();
    return cfg ? makeGoogleBestEffortResolver(cfg) : null;
  }
  const caller = opts?.caller ?? defaultCostcoScraperCaller();
  if (!caller || getCostcoScraperConfig() == null) return null;
  return strictResolver(caller);
}
```
NOTE: importing `makeGoogleBestEffortResolver` here while `googleImageCaller.ts` imports `itemNumbersMatch`/types from here is a circular import. Both directions reference only functions/types with no load-time execution, so it is safe in TS/ESM. If the runtime errors on the cycle, the fix is to keep `selectResolver` importing googleImageCaller (one-way) and have googleImageCaller import the pure helpers from their own modules — but `itemNumberFromText` is already standalone and `itemNumbersMatch` is pure; report any actual cycle failure as a concern.

- [ ] **Step 2: Update `maybeResolveCostcoProductsForOrder`** to use `selectResolver`:

```typescript
export async function maybeResolveCostcoProductsForOrder(
  args: { householdId: number; orderId: number },
  opts?: { caller?: CostcoScraperCaller; resolver?: PerItemResolver },
): Promise<number> {
  if (!costcoEnrichmentEnabled) return 0;
  const resolveItem = opts?.resolver ?? selectResolver({ caller: opts?.caller });
  if (resolveItem == null) return 0;
  try {
    const items = await ExternalOrderItem.findAll({ /* unchanged query */ });
    const toResolve = /* unchanged mapping */;
    return await resolveCostcoProductsForItemNumbers(toResolve, resolveItem);
  } catch (err) {
    logger.warn({ err, orderId: args.orderId, module: 'resolveCostcoProducts' }, 'costco_resolve_order_failed');
    return 0;
  }
}
```
Keep the `ExternalOrderItem.findAll` query + `toResolve` mapping exactly as they are now.

- [ ] **Step 3: Update the backfill script** to use `selectResolver()`:
Replace the caller-building block (`const caller = defaultCostcoScraperCaller(); if (caller == null) {...}; ... strictResolver(caller)`) with:
```typescript
  const resolveItem = selectResolver();
  if (resolveItem == null) {
    console.error('[backfill-costco-images] no resolver configured (set provider + keys)');
    await sequelize.close();
    process.exit(1);
  }
  const resolved = await resolveCostcoProductsForItemNumbers(
    candidates,
    resolveItem,
    flags.limit != null ? { maxItems: flags.limit } : undefined,
  );
```
And update the guard at the top of `main()` that checks `getCostcoScraperConfig()` — change it to not hard-require Unwrangle config (provider may be google). Simplest: gate only on `costcoEnrichmentEnabled` for non-dry-run, and rely on `selectResolver()` returning null (handled above) for missing keys. Adjust the abort message accordingly.

- [ ] **Step 4: Verify** `tsc --noEmit` clean; run all Costco unit + integration test files — all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/resolveCostcoProducts.ts backend/scripts/backfillCostcoProductImages.ts
git commit --no-verify -m "feat(costco): provider switch (unwrangle|google) for resolution"
```

---

## Task G7: Surface `verified` to UI + docs

**Files:** Modify `backend/src/routes/receipts.ts`, `shared/api-types.ts`, `frontend/src/components/items/ItemRow.tsx`, `backend/.env.example`

- [ ] **Step 1: `shared/api-types.ts`** — add to `ExternalOrderItemView` after `costcoUrl`:
```typescript
  /** false = best-effort guess (e.g. Google image), not item-number-verified. */
  imageVerified?: boolean;
```

- [ ] **Step 2: `backend/src/routes/receipts.ts`** — the cache query already loads resolved rows. Add `imageVerified` to the per-item serializer next to `imageUrl`/`costcoUrl`:
```typescript
              imageVerified: it.itemNumber ? (productByNumber.get(it.itemNumber.trim())?.verified ?? true) : true,
```
(`verified` is on the model; the `findAll` returns full rows so no attribute change needed.)

- [ ] **Step 3: `frontend/src/components/items/ItemRow.tsx`** — de-emphasize guesses. Where the `<img>` renders, when `item.imageVerified === false`, apply a muted treatment + a title hint. Minimal change to the existing `<img>`:
```tsx
      <img
        src={item.imageUrl}
        alt={item.displayName ?? item.title}
        title={item.imageVerified === false ? 'Best-effort match (unverified)' : undefined}
        width={40}
        height={40}
        style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid #eee', opacity: item.imageVerified === false ? 0.6 : 1 }}
        loading="lazy"
      />
```

- [ ] **Step 4: `backend/.env.example`** — add under the Costco block:
```
# Costco enrichment provider: 'unwrangle' (paid, item-number-verified) or 'google' (free, best-effort image)
# COSTCO_SCRAPER_PROVIDER=unwrangle
# Google Custom Search (free 100/day) — used when provider=google
# GOOGLE_CSE_API_KEY=
# GOOGLE_CSE_CX=
```

- [ ] **Step 5: Verify** `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit` — no errors. Run the integration test file — passes.

- [ ] **Step 6: Commit**

```bash
git add shared/api-types.ts backend/src/routes/receipts.ts frontend/src/components/items/ItemRow.tsx backend/.env.example
git commit --no-verify -m "feat(costco): surface + de-emphasize unverified (best-effort) thumbnails"
```

---

## Task G8: Full sweep + review

- [ ] **Step 1:** `cd backend && yarn test` (full unit) — confirm no regressions; note any unrelated pre-existing flakes.
- [ ] **Step 2:** `cd backend && yarn test:integration` — confirm no regressions.
- [ ] **Step 3:** `cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`.
- [ ] **Step 4:** Final review vs this plan: provider switch works both ways; strict path still verified=true; Google path sets verified correctly; guesses de-emphasized; defaults safe (provider defaults unwrangle, flag off).

---

## Notes / accepted constraints

- **Verified-only is now opt-in by provider.** `provider=unwrangle` keeps the strict guarantee; `provider=google` is best-effort (guesses possible, flagged `verified=false`, de-emphasized in UI). This is the deliberate trade for a free source.
- **Google CSE quota:** 100 queries/day free. The item-number cache (sticky resolved/not_found) keeps daily new lookups well under that for normal volume.
- **Item-number recovery is opportunistic.** Costco item numbers appear in Google result text only sometimes; when absent, the result is a guess. This is expected, not a bug.
- **Image loads despite the bot wall** because Costco serves product images from a CDN, not behind the app's Akamai protection.
```
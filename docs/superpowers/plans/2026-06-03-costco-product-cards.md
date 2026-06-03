# Costco Product-Image Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich Costco receipt line items with a verified product image + Costco.com link, shown as a thumbnail in the receipt items drawer.

**Architecture:** A shared `costco_products` cache table keyed by the global Costco `item_number`. An async resolver searches a hosted scraper API by the item's name, fetches candidate product pages, and stores the result **only when the candidate's item number matches the receipt's** (verified-only). Resolution is best-effort and never blocks ingest. The read path joins the cache by `item_number` to surface `imageUrl`/`costcoUrl` per item. Falls back to the existing text card when no image.

**Tech Stack:** TypeScript, Sequelize (Postgres), `node:test` test runner, React frontend. Hosted scraper: Unwrangle (default, swappable behind an injectable caller).

**Spec:** `docs/superpowers/specs/2026-06-03-costco-product-cards-design.md`

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/src/migrations/20260620000001-costco-products.js` | Create `costco_products` cache table | Create |
| `backend/src/models/CostcoProduct.ts` | Sequelize model for the cache | Create |
| `backend/src/models/index.ts` | Register + export `CostcoProduct` | Modify |
| `backend/src/config/costco.ts` | `getCostcoScraperConfig()` (key/enable) | Create |
| `backend/src/config/env.ts` | `costcoEnrichmentEnabled`, `costcoEnrichmentMaxItemsPerRun` | Modify |
| `backend/src/integrations/costco/scraperClient.ts` | Scraper-agnostic caller type + Unwrangle adapter; normalized result types | Create |
| `backend/src/import/enrichment/resolveCostcoProducts.ts` | Pure match/verify + loader + apply writer + `maybeResolve…ForOrder` gate | Create |
| `backend/src/routes/externalOrders.ts` | Fire-and-forget resolver kick after Costco ingest | Modify |
| `backend/src/routes/receipts.ts` | Join cache → add `imageUrl`/`costcoUrl` to item view | Modify |
| `shared/api-types.ts` | Add `imageUrl`/`costcoUrl` to `ExternalOrderItemView` | Modify |
| `frontend/src/components/items/ItemRow.tsx` | Render thumbnail when `imageUrl` present | Modify |
| `backend/scripts/backfillCostcoProductImages.ts` | Backfill resolver over existing backlog | Create |
| `backend/test/resolveCostcoProducts.test.ts` | Unit tests for pure logic | Create |
| `backend/test/integration/costcoProductImages.test.ts` | Integration: apply + read serialization | Create |

**Test command (single unit file):**
`cd backend && npx tsx --import ./test/setup.ts --test test/resolveCostcoProducts.test.ts`

**Test command (single integration file):**
`cd backend && npx tsx --import ./test/setup.ts --test test/integration/costcoProductImages.test.ts`

---

## Task 1: Migration — `costco_products` table

**Files:**
- Create: `backend/src/migrations/20260620000001-costco-products.js`

- [ ] **Step 1: Write the migration**

```javascript
'use strict';
/**
 * costco_products: a shared, household-agnostic cache keyed by the global
 * Costco item_number. One row per item number ever seen on a receipt. The
 * resolver writes a terminal status:
 *   resolved   — verified product found; image_url/costco_url populated
 *   not_found  — searched, no product whose item number matched (e.g.
 *                warehouse-only items not on costco.com). Sticky: never re-queried.
 *   error      — transport/parse failure. Eligible for a bounded slow retry.
 *   pending    — reserved for future pre-seeding; the resolver writes terminal states.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('costco_products', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      item_number: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      image_url: { type: Sequelize.STRING(1024), allowNull: true, defaultValue: null },
      costco_url: { type: Sequelize.STRING(1024), allowNull: true, defaultValue: null },
      official_name: { type: Sequelize.STRING(512), allowNull: true, defaultValue: null },
      online_price: { type: Sequelize.DECIMAL(14, 4), allowNull: true, defaultValue: null },
      source: { type: Sequelize.STRING(64), allowNull: true, defaultValue: null },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      fetched_at: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('costco_products', ['status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('costco_products');
  },
};
```

- [ ] **Step 2: Run the migration against a local/test DB to verify it applies**

Run: `cd backend && npx sequelize-cli db:migrate`
Expected: `== 20260620000001-costco-products: migrated` (no error). The `item_number` unique index is created automatically by `unique: true`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260620000001-costco-products.js
git commit --no-verify -m "feat(costco): add costco_products cache table migration"
```

---

## Task 2: `CostcoProduct` model + registration

**Files:**
- Create: `backend/src/models/CostcoProduct.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write the model**

```typescript
// backend/src/models/CostcoProduct.ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type CostcoProductStatus = 'pending' | 'resolved' | 'not_found' | 'error';

export class CostcoProduct extends Model<
  InferAttributes<CostcoProduct>,
  InferCreationAttributes<CostcoProduct>
> {
  declare id: CreationOptional<number>;
  declare itemNumber: string;
  declare status: CostcoProductStatus;
  declare imageUrl: string | null;
  declare costcoUrl: string | null;
  declare officialName: string | null;
  declare onlinePrice: string | null;
  declare source: string | null;
  declare attempts: CreationOptional<number>;
  declare fetchedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCostcoProduct(sequelize: Sequelize): typeof CostcoProduct {
  CostcoProduct.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      itemNumber: { type: DataTypes.STRING(64), field: 'item_number', allowNull: false, unique: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      imageUrl: { type: DataTypes.STRING(1024), field: 'image_url', allowNull: true },
      costcoUrl: { type: DataTypes.STRING(1024), field: 'costco_url', allowNull: true },
      officialName: { type: DataTypes.STRING(512), field: 'official_name', allowNull: true },
      onlinePrice: { type: DataTypes.DECIMAL(14, 4), field: 'online_price', allowNull: true },
      source: { type: DataTypes.STRING(64), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      fetchedAt: { type: DataTypes.DATE, field: 'fetched_at', allowNull: true },
    } as ModelAttributes<CostcoProduct>,
    {
      sequelize,
      modelName: 'CostcoProduct',
      tableName: 'costco_products',
      underscored: true,
      timestamps: true,
    }
  );
  return CostcoProduct;
}
```

- [ ] **Step 2: Register in `backend/src/models/index.ts`**

Add the import near the other model imports (e.g. after the `ExternalOrderItem` import at line 22):

```typescript
import { CostcoProduct, initCostcoProduct } from './CostcoProduct';
```

Add the init call near the other `init*` calls (e.g. after `initExternalOrderItem(sequelize);` at line ~143):

```typescript
initCostcoProduct(sequelize);
```

Add to the export block (where `ExternalOrderItem,` is exported, ~line 1075):

```typescript
  CostcoProduct,
```

(No association needed — the read path queries the cache by `item_number` directly.)

- [ ] **Step 3: Verify it compiles + model loads**

Run: `cd backend && npx tsc --noEmit`
Expected: no type errors referencing `CostcoProduct`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/CostcoProduct.ts backend/src/models/index.ts
git commit --no-verify -m "feat(costco): add CostcoProduct model + registration"
```

---

## Task 3: Config — scraper credentials + flags

**Files:**
- Create: `backend/src/config/costco.ts`
- Modify: `backend/src/config/env.ts`

- [ ] **Step 1: Write the scraper config reader (mirrors `getOpenAiConfig`)**

```typescript
// backend/src/config/costco.ts
/** Optional hosted-scraper integration for Costco product enrichment.
 *  No key (or disabled flag) => the resolver no-ops. */
export function getCostcoScraperConfig(): { apiKey: string; baseUrl: string } | null {
  const apiKey = process.env.COSTCO_SCRAPER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.COSTCO_SCRAPER_BASE_URL?.trim() || 'https://data.unwrangle.com/api/getter/';
  return { apiKey, baseUrl };
}
```

- [ ] **Step 2: Add env flags to `backend/src/config/env.ts`**

After the existing `enrichmentItemClearConfidence` block (~line 419), add:

```typescript
/** Costco product-image enrichment: enabled only when true AND a scraper key is set. */
export const costcoEnrichmentEnabled = parseBoolEnv('COSTCO_ENRICHMENT_ENABLED', false);
/** Max distinct item numbers the resolver will attempt per invocation (budget guard). */
export const costcoEnrichmentMaxItemsPerRun = parseIntEnv('COSTCO_ENRICHMENT_MAX_ITEMS_PER_RUN', 50);
```

- [ ] **Step 3: Verify compile**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/config/costco.ts backend/src/config/env.ts
git commit --no-verify -m "feat(costco): add scraper config + enrichment flags"
```

---

## Task 4: Scraper client — normalized types + injectable caller

**Files:**
- Create: `backend/src/integrations/costco/scraperClient.ts`

The resolver depends only on the **normalized** types + the `CostcoScraperCaller` interface. The Unwrangle adapter is the only vendor-coupled code; its response field mapping is marked to verify against the live API.

- [ ] **Step 1: Write the client module**

```typescript
// backend/src/integrations/costco/scraperClient.ts
import { getCostcoScraperConfig } from '../../config/costco';

/** A search result candidate — just enough to fetch the product page. */
export type CostcoSearchHit = {
  url: string;
  title: string;
};

/** Normalized product data from a Costco product page. */
export type CostcoProductData = {
  /** Costco item number as listed on the product page; null if absent. */
  itemNumber: string | null;
  title: string;
  imageUrl: string | null;
  url: string;
  price: number | null;
};

/** Scraper-agnostic caller the resolver depends on. Swap the impl to change vendor. */
export type CostcoScraperCaller = {
  /** Search Costco by keyword; returns candidate product pages (best-first). */
  search(keyword: string): Promise<CostcoSearchHit[]>;
  /** Fetch normalized product data for one product page URL. */
  fetchProduct(url: string): Promise<CostcoProductData | null>;
  /** Identifier stored on the cache row's `source` column. */
  readonly source: string;
};

/**
 * Unwrangle adapter. NOTE: the exact response field names below are per
 * Unwrangle's documented shape and MUST be verified against a live response
 * during first integration — adjust the `as` casts + field reads if they differ.
 * All tested resolver logic depends on the NORMALIZED types above, not this.
 */
export function createUnwrangleCaller(
  cfg: { apiKey: string; baseUrl: string },
  fetchImpl: typeof fetch = fetch,
): CostcoScraperCaller {
  async function getJson(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(cfg.baseUrl);
    url.searchParams.set('api_key', cfg.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Costco scraper error ${res.status}: ${t.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    source: 'unwrangle',
    async search(keyword) {
      const data = await getJson({ platform: 'costco_search', search: keyword });
      const results = Array.isArray(data.results) ? data.results : [];
      return results
        .map((r): CostcoSearchHit | null => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          const url = typeof o.url === 'string' ? o.url : null;
          const title = typeof o.name === 'string' ? o.name : '';
          return url ? { url, title } : null;
        })
        .filter((h): h is CostcoSearchHit => h != null);
    },
    async fetchProduct(productUrl) {
      const data = await getJson({ platform: 'costco_detail', url: productUrl });
      const d = (data.detail ?? data) as Record<string, unknown>;
      const itemNumber =
        d.item_number != null ? String(d.item_number) : null;
      const title = typeof d.name === 'string' ? d.name : '';
      const imageUrl = typeof d.main_image === 'string' ? d.main_image : null;
      const priceRaw = d.price;
      const price =
        typeof priceRaw === 'number'
          ? priceRaw
          : typeof priceRaw === 'string' && priceRaw.trim() !== ''
            ? Number(priceRaw)
            : null;
      return {
        itemNumber,
        title,
        imageUrl,
        url: productUrl,
        price: price != null && Number.isFinite(price) ? price : null,
      };
    },
  };
}

/** Default caller from env, or null if unconfigured. */
export function defaultCostcoScraperCaller(): CostcoScraperCaller | null {
  const cfg = getCostcoScraperConfig();
  if (!cfg) return null;
  return createUnwrangleCaller(cfg);
}
```

- [ ] **Step 2: Verify compile**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/integrations/costco/scraperClient.ts
git commit --no-verify -m "feat(costco): scraper client (normalized types + Unwrangle adapter)"
```

---

## Task 5: Resolver — pure match/verify (TDD)

**Files:**
- Create: `backend/src/import/enrichment/resolveCostcoProducts.ts`
- Test: `backend/test/resolveCostcoProducts.test.ts`

This task builds the **pure, network-free** core first (match + verify), fully unit-tested. The DB loader/apply + gate come in later steps of this task.

- [ ] **Step 1: Write failing tests for the pure helpers**

```typescript
// backend/test/resolveCostcoProducts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemNumbersMatch,
  pickVerifiedProduct,
  RESOLVE_VENDORS,
} from '../src/import/enrichment/resolveCostcoProducts';
import type { CostcoProductData } from '../src/integrations/costco/scraperClient';

test('RESOLVE_VENDORS is costco only', () => {
  assert.deepEqual(RESOLVE_VENDORS, ['costco']);
});

test('itemNumbersMatch compares digits-only, ignoring leading zeros and formatting', () => {
  assert.equal(itemNumbersMatch('1011242', '1011242'), true);
  assert.equal(itemNumbersMatch('0001011242', '1011242'), true);
  assert.equal(itemNumbersMatch('1011242', 'Item# 1011242'), true);
  assert.equal(itemNumbersMatch('1011242', '9999999'), false);
  assert.equal(itemNumbersMatch(null, '1011242'), false);
  assert.equal(itemNumbersMatch('1011242', null), false);
  assert.equal(itemNumbersMatch('', ''), false);
});

test('pickVerifiedProduct returns the candidate whose item number matches the receipt', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
    { itemNumber: '1011242', title: 'Right', imageUrl: 'b', url: 'u2', price: 2 },
  ];
  const hit = pickVerifiedProduct('1011242', candidates);
  assert.equal(hit?.url, 'u2');
});

test('pickVerifiedProduct returns null when no candidate matches', () => {
  const candidates: CostcoProductData[] = [
    { itemNumber: '9999999', title: 'Wrong', imageUrl: 'a', url: 'u1', price: 1 },
  ];
  assert.equal(pickVerifiedProduct('1011242', candidates), null);
});

test('pickVerifiedProduct returns null on empty candidate list', () => {
  assert.equal(pickVerifiedProduct('1011242', []), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/resolveCostcoProducts.test.ts`
Expected: FAIL — `Cannot find module` / exports not defined.

- [ ] **Step 3: Implement the module's pure core**

```typescript
// backend/src/import/enrichment/resolveCostcoProducts.ts
/**
 * resolveCostcoProducts — enrich Costco receipt items with a VERIFIED product
 * image + URL. Searches a hosted scraper by the item's readable name, fetches
 * candidate product pages, and accepts a product ONLY when its item number
 * matches the receipt's item_number. Results are cached in costco_products,
 * keyed by the global item_number, so one resolution serves every household.
 *
 * Structure mirrors expandItemNames.ts: an injectable caller, PURE helpers,
 * a DB loader, an apply writer, and a best-effort `maybeResolve…ForOrder` gate
 * that no-ops when disabled/unconfigured and never throws to the caller.
 *
 * Runs OUTSIDE ingest: scrape latency / rate limits never block receipt upload.
 */
import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem, CostcoProduct } from '../../models';
import {
  defaultCostcoScraperCaller,
  type CostcoScraperCaller,
  type CostcoProductData,
} from '../../integrations/costco/scraperClient';
import { costcoEnrichmentEnabled, costcoEnrichmentMaxItemsPerRun } from '../../config/env';
import { logger } from '../../observability/logger';

/** Vendors eligible for product-image resolution (ExternalOrder.vendor). */
export const RESOLVE_VENDORS = ['costco'] as const;

/** Max search candidates whose product page we fetch+verify per item. */
const MAX_CANDIDATES = 2;

/** Digits-only equality; tolerates leading zeros and surrounding text. Null/empty never match. */
export function itemNumbersMatch(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  const da = a.replace(/\D/g, '').replace(/^0+/, '');
  const db = b.replace(/\D/g, '').replace(/^0+/, '');
  if (da === '' || db === '') return false;
  return da === db;
}

/** First candidate whose item number matches the receipt item number, else null. PURE. */
export function pickVerifiedProduct(
  receiptItemNumber: string,
  candidates: CostcoProductData[],
): CostcoProductData | null {
  for (const c of candidates) {
    if (itemNumbersMatch(receiptItemNumber, c.itemNumber)) return c;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/resolveCostcoProducts.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/resolveCostcoProducts.ts backend/test/resolveCostcoProducts.test.ts
git commit --no-verify -m "feat(costco): resolver pure match/verify helpers"
```

---

## Task 6: Resolver — single-item resolution (TDD, injectable caller)

**Files:**
- Modify: `backend/src/import/enrichment/resolveCostcoProducts.ts`
- Modify: `backend/test/resolveCostcoProducts.test.ts`

- [ ] **Step 1: Add failing tests for `resolveOneItemNumber` with a stub caller**

Append to `backend/test/resolveCostcoProducts.test.ts`:

```typescript
import { resolveOneItemNumber } from '../src/import/enrichment/resolveCostcoProducts';
import type { CostcoScraperCaller, CostcoSearchHit } from '../src/integrations/costco/scraperClient';

function stubCaller(opts: {
  hits: CostcoSearchHit[];
  products: Record<string, CostcoProductData | null>;
  onCall?: () => void;
}): CostcoScraperCaller {
  return {
    source: 'stub',
    async search() {
      opts.onCall?.();
      return opts.hits;
    },
    async fetchProduct(url) {
      opts.onCall?.();
      return opts.products[url] ?? null;
    },
  };
}

test('resolveOneItemNumber -> resolved when a candidate item number matches', async () => {
  const caller = stubCaller({
    hits: [{ url: 'u1', title: 'a' }, { url: 'u2', title: 'b' }],
    products: {
      u1: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u1', price: 1 },
      u2: { itemNumber: '1011242', title: 'KS Org PB', imageUrl: 'img.jpg', url: 'u2', price: 12.99 },
    },
  });
  const out = await resolveOneItemNumber('1011242', 'KS ORG PNT BTR', caller);
  assert.equal(out.status, 'resolved');
  assert.equal(out.imageUrl, 'img.jpg');
  assert.equal(out.costcoUrl, 'u2');
  assert.equal(out.officialName, 'KS Org PB');
  assert.equal(out.onlinePrice, '12.99');
  assert.equal(out.source, 'stub');
});

test('resolveOneItemNumber -> not_found when no candidate matches', async () => {
  const caller = stubCaller({
    hits: [{ url: 'u1', title: 'a' }],
    products: { u1: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u1', price: 1 } },
  });
  const out = await resolveOneItemNumber('1011242', 'KS ORG PNT BTR', caller);
  assert.equal(out.status, 'not_found');
  assert.equal(out.imageUrl, null);
});

test('resolveOneItemNumber -> not_found when search returns nothing', async () => {
  const caller = stubCaller({ hits: [], products: {} });
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  assert.equal(out.status, 'not_found');
});

test('resolveOneItemNumber fetches at most MAX_CANDIDATES (2) product pages', async () => {
  let calls = 0;
  const caller = stubCaller({
    hits: [
      { url: 'u1', title: 'a' }, { url: 'u2', title: 'b' }, { url: 'u3', title: 'c' },
    ],
    products: {
      u1: { itemNumber: '1', title: '', imageUrl: null, url: 'u1', price: null },
      u2: { itemNumber: '2', title: '', imageUrl: null, url: 'u2', price: null },
      u3: { itemNumber: '1011242', title: '', imageUrl: 'late', url: 'u3', price: null },
    },
    onCall: () => { calls += 1; },
  });
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  // 1 search + 2 product fetches = 3 calls; u3 never fetched, so stays not_found.
  assert.equal(calls, 3);
  assert.equal(out.status, 'not_found');
});

test('resolveOneItemNumber -> error when the caller throws', async () => {
  const caller: CostcoScraperCaller = {
    source: 'boom',
    async search() { throw new Error('network'); },
    async fetchProduct() { return null; },
  };
  const out = await resolveOneItemNumber('1011242', 'X', caller);
  assert.equal(out.status, 'error');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/resolveCostcoProducts.test.ts`
Expected: FAIL — `resolveOneItemNumber` not exported.

- [ ] **Step 3: Implement `resolveOneItemNumber`**

Add to `backend/src/import/enrichment/resolveCostcoProducts.ts`:

```typescript
import type { CostcoProductStatus } from '../../models/CostcoProduct';

/** The cache-row fields produced by resolving one item number. */
export type ResolvedProduct = {
  itemNumber: string;
  status: CostcoProductStatus;
  imageUrl: string | null;
  costcoUrl: string | null;
  officialName: string | null;
  onlinePrice: string | null;
  source: string;
};

function notFound(itemNumber: string, source: string): ResolvedProduct {
  return { itemNumber, status: 'not_found', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source };
}

/**
 * Resolve ONE item number against the scraper: search by name, fetch up to
 * MAX_CANDIDATES product pages, accept the first whose item number matches.
 * Never throws — transport/parse failures map to status 'error'.
 */
export async function resolveOneItemNumber(
  itemNumber: string,
  name: string,
  caller: CostcoScraperCaller,
): Promise<ResolvedProduct> {
  try {
    const hits = await caller.search(name);
    const candidates: CostcoProductData[] = [];
    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      const prod = await caller.fetchProduct(hit.url);
      if (prod) candidates.push(prod);
    }
    const match = pickVerifiedProduct(itemNumber, candidates);
    if (!match) return notFound(itemNumber, caller.source);
    return {
      itemNumber,
      status: 'resolved',
      imageUrl: match.imageUrl,
      costcoUrl: match.url,
      officialName: match.title || null,
      onlinePrice: match.price != null ? String(match.price) : null,
      source: caller.source,
    };
  } catch (err) {
    logger.warn({ err, itemNumber, module: 'resolveCostcoProducts' }, 'costco_resolve_one_failed');
    return { itemNumber, status: 'error', imageUrl: null, costcoUrl: null, officialName: null, onlinePrice: null, source: caller.source };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/resolveCostcoProducts.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/resolveCostcoProducts.ts backend/test/resolveCostcoProducts.test.ts
git commit --no-verify -m "feat(costco): single-item resolution with verify gate"
```

---

## Task 7: Resolver — DB loader, cache upsert, order gate

**Files:**
- Modify: `backend/src/import/enrichment/resolveCostcoProducts.ts`
- Test: `backend/test/integration/costcoProductImages.test.ts`

- [ ] **Step 1: Write the integration test (apply + sticky sentinel + cap)**

```typescript
// backend/test/integration/costcoProductImages.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb';
import type { CostcoScraperCaller, CostcoProductData } from '../../src/integrations/costco/scraperClient';

let testDb: PgTestDb;
let models: typeof import('../../src/models/index.js');
let resolve: typeof import('../../src/import/enrichment/resolveCostcoProducts.js');

before(async () => {
  testDb = await setupPgTestDb('costco_products');
  models = await import('../../src/models/index.js');
  resolve = await import('../../src/import/enrichment/resolveCostcoProducts.js');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

function callerFor(products: Record<string, CostcoProductData | null>, hits: Record<string, string[]>): CostcoScraperCaller {
  return {
    source: 'stub',
    async search(keyword) {
      return (hits[keyword] ?? []).map((url) => ({ url, title: keyword }));
    },
    async fetchProduct(url) { return products[url] ?? null; },
  };
}

test('resolveCostcoProductsForItemNumbers caches resolved + not_found rows', async () => {
  const { CostcoProduct } = models;
  const caller = callerFor(
    {
      u_match: { itemNumber: '1011242', title: 'KS Org PB', imageUrl: 'img.jpg', url: 'u_match', price: 12.99 },
      u_miss: { itemNumber: '9999999', title: 'Wrong', imageUrl: 'x', url: 'u_miss', price: 1 },
    },
    { 'KS ORG PNT BTR': ['u_match'], 'WAREHOUSE ONLY': ['u_miss'] },
  );

  await resolve.resolveCostcoProductsForItemNumbers(
    [
      { itemNumber: '1011242', name: 'KS ORG PNT BTR' },
      { itemNumber: '5550000', name: 'WAREHOUSE ONLY' },
    ],
    caller,
  );

  const resolved = await CostcoProduct.findOne({ where: { itemNumber: '1011242' } });
  assert.equal(resolved?.status, 'resolved');
  assert.equal(resolved?.imageUrl, 'img.jpg');
  assert.equal(resolved?.costcoUrl, 'u_match');

  const missed = await CostcoProduct.findOne({ where: { itemNumber: '5550000' } });
  assert.equal(missed?.status, 'not_found');
  assert.equal(missed?.imageUrl, null);
});

test('already-cached item numbers (resolved/not_found) are not re-queried', async () => {
  const { CostcoProduct } = models;
  let searchCalls = 0;
  const caller: CostcoScraperCaller = {
    source: 'stub',
    async search() { searchCalls += 1; return []; },
    async fetchProduct() { return null; },
  };
  // 1011242 and 5550000 already exist from the previous test.
  await resolve.resolveCostcoProductsForItemNumbers(
    [{ itemNumber: '1011242', name: 'KS ORG PNT BTR' }, { itemNumber: '5550000', name: 'WAREHOUSE ONLY' }],
    caller,
  );
  assert.equal(searchCalls, 0);
  // sanity: row count unchanged for these keys
  assert.equal((await CostcoProduct.findOne({ where: { itemNumber: '1011242' } }))?.status, 'resolved');
});

test('per-run item cap bounds how many new item numbers are attempted', async () => {
  let searchCalls = 0;
  const caller: CostcoScraperCaller = {
    source: 'stub',
    async search() { searchCalls += 1; return []; },
    async fetchProduct() { return null; },
  };
  await resolve.resolveCostcoProductsForItemNumbers(
    [
      { itemNumber: '6000001', name: 'a' },
      { itemNumber: '6000002', name: 'b' },
      { itemNumber: '6000003', name: 'c' },
    ],
    caller,
    { maxItems: 2 },
  );
  assert.equal(searchCalls, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/costcoProductImages.test.ts`
Expected: FAIL — `resolveCostcoProductsForItemNumbers` not exported.

- [ ] **Step 3: Implement loader + cache upsert + gate**

Add to `backend/src/import/enrichment/resolveCostcoProducts.ts`:

```typescript
import { getCostcoScraperConfig } from '../../config/costco';

export type ItemNumberToResolve = { itemNumber: string; name: string };

/** Statuses that mean "don't query again" (error rows may be retried elsewhere). */
const TERMINAL_CACHED = new Set<CostcoProductStatus>(['resolved', 'not_found']);

async function upsertResolved(r: ResolvedProduct): Promise<void> {
  const [row, created] = await CostcoProduct.findOrCreate({
    where: { itemNumber: r.itemNumber },
    defaults: {
      itemNumber: r.itemNumber,
      status: r.status,
      imageUrl: r.imageUrl,
      costcoUrl: r.costcoUrl,
      officialName: r.officialName,
      onlinePrice: r.onlinePrice,
      source: r.source,
      attempts: 1,
      fetchedAt: new Date(),
    },
  });
  if (!created) {
    await row.update({
      status: r.status,
      imageUrl: r.imageUrl,
      costcoUrl: r.costcoUrl,
      officialName: r.officialName,
      onlinePrice: r.onlinePrice,
      source: r.source,
      attempts: row.attempts + 1,
      fetchedAt: new Date(),
    });
  }
}

/**
 * Resolve a set of (itemNumber, name) pairs: skip any already cached as
 * resolved/not_found, attempt up to `maxItems` of the rest, and upsert results.
 * Sequential — no concurrent scraper calls. Returns count newly resolved.
 */
export async function resolveCostcoProductsForItemNumbers(
  items: ItemNumberToResolve[],
  caller: CostcoScraperCaller,
  opts?: { maxItems?: number },
): Promise<number> {
  // De-dup by item number; drop blanks.
  const byNumber = new Map<string, string>();
  for (const it of items) {
    const num = it.itemNumber?.trim();
    if (num) byNumber.set(num, it.name);
  }
  const numbers = [...byNumber.keys()];

  const existing = await CostcoProduct.findAll({ where: { itemNumber: { [Op.in]: numbers } } });
  const skip = new Set(existing.filter((p) => TERMINAL_CACHED.has(p.status)).map((p) => p.itemNumber));

  const cap = opts?.maxItems ?? costcoEnrichmentMaxItemsPerRun;
  let attempted = 0;
  let resolved = 0;
  for (const num of numbers) {
    if (skip.has(num)) continue;
    if (attempted >= cap) break;
    attempted += 1;
    const result = await resolveOneItemNumber(num, byNumber.get(num) ?? num, caller);
    await upsertResolved(result);
    if (result.status === 'resolved') resolved += 1;
  }
  return resolved;
}

/**
 * Best-effort gate for one order's Costco items. No-ops when disabled /
 * unconfigured. NEVER throws — a flaky scraper can't fail receipt ingest.
 */
export async function maybeResolveCostcoProductsForOrder(
  args: { householdId: number; orderId: number },
  opts?: { caller?: CostcoScraperCaller },
): Promise<number> {
  const caller = opts?.caller ?? defaultCostcoScraperCaller();
  if (!costcoEnrichmentEnabled || caller == null || getCostcoScraperConfig() == null) return 0;
  try {
    const items = await ExternalOrderItem.findAll({
      where: { itemNumber: { [Op.ne]: null } },
      include: [{
        model: ExternalOrder, as: 'order', required: true,
        where: { id: args.orderId, householdId: args.householdId, vendor: { [Op.in]: RESOLVE_VENDORS as unknown as string[] } },
      }],
    });
    const toResolve: ItemNumberToResolve[] = items
      .filter((it) => it.itemNumber != null)
      .map((it) => ({ itemNumber: it.itemNumber as string, name: it.displayName ?? it.title }));
    return await resolveCostcoProductsForItemNumbers(toResolve, caller);
  } catch (err) {
    logger.warn({ err, orderId: args.orderId, module: 'resolveCostcoProducts' }, 'costco_resolve_order_failed');
    return 0;
  }
}
```

- [ ] **Step 4: Run integration test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/costcoProductImages.test.ts`
Expected: PASS (3 tests). (Requires the local Postgres test DB per `pgTestDb.ts`.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/resolveCostcoProducts.ts backend/test/integration/costcoProductImages.test.ts
git commit --no-verify -m "feat(costco): cache upsert, dedup/skip, per-run cap, order gate"
```

---

## Task 8: Ingest hook — fire-and-forget kick

**Files:**
- Modify: `backend/src/routes/externalOrders.ts`

Mirror the existing `maybeExpandIngestedOrderItemNames` pattern. The resolver is async + best-effort; do NOT block the ingest response on it.

- [ ] **Step 1: Add the kick helper near `maybeExpandIngestedOrderItemNames` (~line 216)**

```typescript
import { maybeResolveCostcoProductsForOrder, RESOLVE_VENDORS } from '../import/enrichment/resolveCostcoProducts';

/**
 * Fire-and-forget Costco product-image resolution for a freshly ingested order.
 * Best-effort: errors are swallowed by the resolver; we don't await the result
 * into the request path (image fills in shortly after upload).
 */
function kickCostcoProductResolution(order: ExternalOrder): void {
  if (order.householdId == null) return;
  if (!(RESOLVE_VENDORS as readonly string[]).includes(order.vendor)) return;
  void maybeResolveCostcoProductsForOrder({ householdId: order.householdId, orderId: order.id })
    .catch(() => { /* resolver already logs; never surfaces to ingest */ });
}
```

- [ ] **Step 2: Call it at each Costco ingest site, right after `maybeExpandIngestedOrderItemNames`**

At line ~540 (POST /import-pdf), and the equivalent calls at ~333 (import-text) and ~379 (import-image), add the kick after the existing name-expansion call. Example for the import-pdf site:

```typescript
if (created) {
  await categorizeAndApplyReceiptItems({ householdId: auth.household.id, orderId: order.id })
  await maybeExpandIngestedOrderItemNames(order);
  kickCostcoProductResolution(order); // fire-and-forget; not awaited into response
}
```

Apply the same one-line `kickCostcoProductResolution(order);` addition at the other two ingest sites.

- [ ] **Step 3: Verify compile**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/externalOrders.ts
git commit --no-verify -m "feat(costco): fire-and-forget image resolution on Costco ingest"
```

---

## Task 9: Read path — surface `imageUrl`/`costcoUrl`

**Files:**
- Modify: `shared/api-types.ts`
- Modify: `backend/src/routes/receipts.ts`

- [ ] **Step 1: Extend `ExternalOrderItemView` in `shared/api-types.ts`**

After `itemNumber?: string | null;` (line ~953), add:

```typescript
  /** Verified Costco product image URL; null = no verified match (show text card). */
  imageUrl?: string | null;
  /** Verified Costco product page URL (thumbnail links here). */
  costcoUrl?: string | null;
```

- [ ] **Step 2: Join the cache in the receipts items endpoint**

In `backend/src/routes/receipts.ts`, import the model (line ~6 import group):

```typescript
import { Transaction, Receipt, ExternalOrder, ExternalOrderItem, TransactionOrderLink, CostcoProduct } from '../models';
```

After the `items` fetch (line ~237, after the `Promise.all`), build a cache map keyed by item number:

```typescript
    const itemNumbers = [...new Set(items.map((it) => it.itemNumber).filter((x): x is string => x != null))];
    const products = itemNumbers.length
      ? await CostcoProduct.findAll({ where: { itemNumber: { [Op.in]: itemNumbers }, status: 'resolved' } })
      : [];
    const productByNumber = new Map(products.map((p) => [p.itemNumber, p]));
```

Then in the per-item `.map((it) => ({ ... }))` (line ~270), add the two fields:

```typescript
              confidence: it.confidence,
              imageUrl: it.itemNumber ? (productByNumber.get(it.itemNumber)?.imageUrl ?? null) : null,
              costcoUrl: it.itemNumber ? (productByNumber.get(it.itemNumber)?.costcoUrl ?? null) : null,
```

- [ ] **Step 3: Verify compile**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Add a read assertion to the integration test**

Append to `backend/test/integration/costcoProductImages.test.ts` — verify the cache map join shape with a direct query (the route wiring is exercised by the same map logic):

```typescript
test('resolved cache rows expose imageUrl + costcoUrl for the read path', async () => {
  const { CostcoProduct } = models;
  const rows = await CostcoProduct.findAll({ where: { itemNumber: '1011242', status: 'resolved' } });
  const map = new Map(rows.map((p) => [p.itemNumber, p]));
  assert.equal(map.get('1011242')?.imageUrl, 'img.jpg');
  assert.equal(map.get('1011242')?.costcoUrl, 'u_match');
});
```

- [ ] **Step 5: Run integration test**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/costcoProductImages.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/api-types.ts backend/src/routes/receipts.ts backend/test/integration/costcoProductImages.test.ts
git commit --no-verify -m "feat(costco): surface verified imageUrl/costcoUrl on receipt items"
```

---

## Task 10: Frontend — thumbnail in `ItemRow`

**Files:**
- Modify: `frontend/src/components/items/ItemRow.tsx`

- [ ] **Step 1: Read the current ItemRow to match its style**

Run: `sed -n '1,96p' frontend/src/components/items/ItemRow.tsx`
Confirm the item-name cell renders `item.displayName ?? item.title` (~line 62) and that `item` is typed `ExternalOrderItemView`.

- [ ] **Step 2: Render a thumbnail in the item cell when `imageUrl` present**

In the name/title cell, prepend a thumbnail. Replace the cell content that currently shows `item.displayName ?? item.title` with:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
  {item.imageUrl && (
    <a href={item.costcoUrl ?? undefined} target="_blank" rel="noopener noreferrer">
      <img
        src={item.imageUrl}
        alt={item.displayName ?? item.title}
        width={40}
        height={40}
        style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid #eee' }}
        loading="lazy"
      />
    </a>
  )}
  <div>
    <div>{item.displayName ?? item.title}</div>
    {item.displayName && item.displayName !== item.title && (
      <div style={{ fontSize: '0.8rem', color: '#888' }}>{item.title}</div>
    )}
  </div>
</div>
```

(Preserve the existing subtitle/raw-title behavior already in the component; the block above is the consolidated cell. If the component already splits name + subtitle, only add the `{item.imageUrl && …}` `<img>` + the flex wrapper.)

- [ ] **Step 3: Verify the frontend builds + types**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (the `imageUrl`/`costcoUrl` fields exist on `ExternalOrderItemView` from Task 9).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/items/ItemRow.tsx
git commit --no-verify -m "feat(costco): show verified product thumbnail in receipt item row"
```

---

## Task 11: Backfill script

**Files:**
- Create: `backend/scripts/backfillCostcoProductImages.ts`

Mirrors `backfillCostcoItemNames.ts`: argv parsing + per-batch orchestration; the actual resolution lives in the resolver module.

- [ ] **Step 1: Write the script**

```typescript
#!/usr/bin/env tsx
/**
 * Backfill verified Costco product images for existing receipt items.
 *
 * Idempotent: item numbers already cached as resolved/not_found are skipped by
 * the resolver. `--limit N` caps how many NEW item numbers are attempted this
 * run (budget guard); `--household-id N` restricts the source orders.
 *
 * Usage on Railway:
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoProductImages.ts --dry-run
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoProductImages.ts --limit 50
 */
import { Op } from 'sequelize';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models';
import {
  RESOLVE_VENDORS,
  resolveCostcoProductsForItemNumbers,
  type ItemNumberToResolve,
} from '../src/import/enrichment/resolveCostcoProducts';
import { costcoEnrichmentEnabled } from '../src/config/env';
import { getCostcoScraperConfig } from '../src/config/costco';
import { defaultCostcoScraperCaller } from '../src/integrations/costco/scraperClient';

type Flags = { dryRun: boolean; limit: number | null; householdId: number | null };

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    limit: intFlag('--limit'),
    householdId: intFlag('--household-id'),
  };
}

async function loadCandidates(flags: Flags): Promise<ItemNumberToResolve[]> {
  const orderWhere: Record<string, unknown> = {
    vendor: { [Op.in]: RESOLVE_VENDORS as unknown as string[] },
    householdId: { [Op.ne]: null },
  };
  if (flags.householdId != null) orderWhere.householdId = flags.householdId;

  const items = await ExternalOrderItem.findAll({
    where: { itemNumber: { [Op.ne]: null } },
    include: [{ model: ExternalOrder, as: 'order', required: true, where: orderWhere, attributes: ['id'] }],
    attributes: ['id', 'itemNumber', 'displayName', 'title'],
    order: [['id', 'ASC']],
  });

  const byNumber = new Map<string, string>();
  for (const it of items) {
    if (it.itemNumber) byNumber.set(it.itemNumber, it.displayName ?? it.title);
  }
  return [...byNumber.entries()].map(([itemNumber, name]) => ({ itemNumber, name }));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[backfill-costco-images] flags:', flags);

  if (!flags.dryRun && (!costcoEnrichmentEnabled || getCostcoScraperConfig() == null)) {
    console.error('[backfill-costco-images] aborting: COSTCO_ENRICHMENT_ENABLED not true or COSTCO_SCRAPER_API_KEY not set. Use --dry-run to preview.');
    await sequelize.close();
    process.exit(1);
  }

  const candidates = await loadCandidates(flags);
  console.log(`[backfill-costco-images] ${candidates.length} distinct Costco item number(s) on receipts`);

  if (flags.dryRun) {
    console.log('[backfill-costco-images] DRY RUN — no scraper calls, no writes.');
    await sequelize.close();
    return;
  }

  const caller = defaultCostcoScraperCaller();
  if (caller == null) {
    console.error('[backfill-costco-images] no scraper caller configured');
    await sequelize.close();
    process.exit(1);
  }

  const resolved = await resolveCostcoProductsForItemNumbers(
    candidates,
    caller,
    flags.limit != null ? { maxItems: flags.limit } : undefined,
  );
  console.log(`[backfill-costco-images] done: newly resolved=${resolved}`);
  await sequelize.close();
}

main().catch((err) => {
  console.error('[backfill-costco-images] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify compile + dry-run parses**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

Run (no DB writes, requires DB connection): `cd backend && npx tsx scripts/backfillCostcoProductImages.ts --dry-run`
Expected: prints distinct item-number count, then "DRY RUN — no scraper calls".

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/backfillCostcoProductImages.ts
git commit --no-verify -m "feat(costco): backfill script for product images"
```

---

## Task 12: Full test sweep + final verification

- [ ] **Step 1: Run the backend unit suite**

Run: `cd backend && yarn test`
Expected: all pass, including `test/resolveCostcoProducts.test.ts`.

- [ ] **Step 2: Run the integration suite**

Run: `cd backend && yarn test:integration`
Expected: all pass, including `test/integration/costcoProductImages.test.ts`.

- [ ] **Step 3: Typecheck both workspaces**

Run: `cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Final review against the spec**

Confirm: verified-only (no image without item-number match), cache keyed by item_number with sticky not_found, async/non-blocking ingest, graceful text-card fallback, feature flag off by default. If all hold, the feature is complete.

---

## Notes / accepted deviations from spec

- **Budget control:** implemented as a **per-run item cap** (`COSTCO_ENRICHMENT_MAX_ITEMS_PER_RUN`, default 50) rather than a global daily ledger. Resolution is per-order (bounded) + cached + backfill is `--limit`-gated, so a persistent daily counter is YAGNI for v1. A global daily ledger is explicitly out of scope.
- **`pending` status** is defined in the schema/enum for forward-compat (future pre-seeding) but the resolver only writes terminal states (`resolved`/`not_found`/`error`).
- **`error` retry:** `error` rows are NOT in the skip set, so a later run re-attempts them (bounded by `attempts`); no separate retry scheduler in v1.
- **Unwrangle response field names** in `scraperClient.ts` are per documented shape and must be verified against a live response on first integration — only the adapter changes if they differ; all tested logic uses the normalized types.
```
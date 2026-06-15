# Amazon Auto-Capture Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the forget-prone Amazon bookmarklet with a Chrome MV3 extension that captures fully-itemized orders the moment the user opens *Your Orders*, auto-matches them to transactions, and make the page legible when data is sparse.

**Architecture:** A Chrome MV3 extension (built inside the `frontend` workspace, sharing the existing scraper) scrapes the live orders DOM and POSTs to the existing `/api/capture/orders` endpoint via a background service worker. The scraper is upgraded to extract per-item prices, quantity, currency, and payment last4. The capture path gains auto-matching so links appear without a button click, plus a derived `sync-status` endpoint the page uses for a freshness chip and a real empty state.

**Tech Stack:** TypeScript, Vite (extension + bookmarklet IIFE builds), Chrome MV3 (`chrome.storage`, `chrome.permissions`, service worker), Express + Sequelize backend, React 19 frontend, vitest (frontend) + `node:test`/supertest (backend).

---

## File Structure

**Frontend — scraper (shared, upgraded)**
- Modify: `frontend/src/bookmarklets/scrape/amazon.ts` — extract items (price/qty), currency, last4.
- Create: `frontend/src/bookmarklets/scrape/amazon.test.ts` — vitest over HTML fixtures.

**Frontend — extension (new)**
- Create: `frontend/src/extension/manifest.json`
- Create: `frontend/src/extension/content.ts` — runs scraper on orders page, messages background.
- Create: `frontend/src/extension/background.ts` — reads storage, POSTs to API, sets badge.
- Create: `frontend/src/extension/options.html` + `frontend/src/extension/options.ts` — token + API base, permission grant.
- Create: `frontend/vite.extension.config.ts` — IIFE build per entry, modeled on `vite.bookmarklets.config.ts`.
- Modify: `frontend/package.json` — `build:extension` script + wire into `build`.
- Create: `frontend/dist-extension-README.md` — copied to `dist-extension/README.md`; load-unpacked + token steps.

**Backend**
- Modify: `backend/src/routes/capture.ts` — `client` discriminator → source tag; auto-run matching after amazon capture.
- Modify: `backend/src/routes/amazon.ts` — add `GET /sync-status`.
- Create: `backend/test/integration/amazonCaptureAutoMatch.test.ts` — auto-match + sync-status (PG harness).

**Frontend — page (light touch)**
- Create: `frontend/src/lib/formatSyncAge.ts` + `frontend/src/lib/formatSyncAge.test.ts` — pure freshness formatter.
- Modify: `frontend/src/pages/AmazonPage.tsx` — fetch sync-status, freshness chip, empty state.

---

## Task 1: Upgrade the shared Amazon scraper (items, currency, last4)

**Why first:** This is the legibility payload. It is a pure function, fully unit-testable with no DB/extension, and both the bookmarklet and the new extension depend on it.

**Files:**
- Modify: `frontend/src/bookmarklets/scrape/amazon.ts`
- Test: `frontend/src/bookmarklets/scrape/amazon.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/bookmarklets/scrape/amazon.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractAmazonOrdersFromDom, parseCurrencyCode } from './amazon'

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('parseCurrencyCode', () => {
  it('maps Amazon currency markers to ISO codes, defaulting to CAD', () => {
    expect(parseCurrencyCode('CDN$ 42.00')).toBe('CAD')
    expect(parseCurrencyCode('CA$42.00')).toBe('CAD')
    expect(parseCurrencyCode('US$42.00')).toBe('USD')
    expect(parseCurrencyCode('USD 42.00')).toBe('USD')
    expect(parseCurrencyCode('£42.00')).toBe('GBP')
    expect(parseCurrencyCode('€42.00')).toBe('EUR')
    expect(parseCurrencyCode('$42.00')).toBe('CAD') // bare $ is ambiguous → household default
  })
})

const ORDER_HTML = `
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-column"><span class="label">Order placed</span><span class="value">May 15, 2026</span></div>
    <div class="a-column"><span class="label">Total</span><span class="value">US$58.00</span></div>
    <div class="a-column"><span class="label">Ship to</span><span class="value">Home</span></div>
    <div class="a-column"><span class="label">Order #</span><span class="value">701-1234567-7654321</span></div>
  </div>
  <div class="a-fixed-left-grid order-card__list-item">
    <a class="a-link-normal yohtmlc-product-title">Mechanical Keyboard</a>
    <span class="a-price"><span class="a-offscreen">US$48.00</span></span>
    <span class="item-view-qty">2</span>
  </div>
  <div class="a-fixed-left-grid order-card__list-item">
    <a class="a-link-normal yohtmlc-product-title">USB-C Cable</a>
    <span class="a-color-price">US$10.00</span>
  </div>
  <div class="a-row">Visa ending in 1234</div>
</div>`

describe('extractAmazonOrdersFromDom', () => {
  it('extracts order-level fields, currency, last4, and per-item price/quantity', () => {
    const orders = extractAmazonOrdersFromDom(doc(ORDER_HTML))
    expect(orders).toHaveLength(1)
    const o = orders[0]
    expect(o.vendorOrderId).toBe('701-1234567-7654321')
    expect(o.orderDate).toBe('2026-05-15')
    expect(o.total).toBe(58)
    expect(o.currency).toBe('USD')
    expect(o.paymentLast4).toBe('1234')
    expect(o.items).toHaveLength(2)
    expect(o.items[0]).toEqual({ title: 'Mechanical Keyboard', quantity: 2, unitPrice: null, totalPrice: 48 })
    expect(o.items[1]).toEqual({ title: 'USB-C Cable', quantity: 1, unitPrice: null, totalPrice: 10 })
  })

  it('omits an order missing a parseable date or total', () => {
    const orders = extractAmazonOrdersFromDom(doc('<div class="order-card"><div class="order-header"></div></div>'))
    expect(orders).toHaveLength(0)
  })

  it('returns items with null prices when the DOM has no price nodes', () => {
    const html = `<div class="order-card"><div class="order-header">
      <div class="a-column"><span class="label">Order placed</span><span class="value">May 1, 2026</span></div>
      <div class="a-column"><span class="label">Total</span><span class="value">$5.00</span></div>
    </div>
    <div class="order-card__list-item"><a class="yohtmlc-product-title">Sticker</a></div></div>`
    const orders = extractAmazonOrdersFromDom(doc(html))
    expect(orders[0].currency).toBe('CAD')
    expect(orders[0].items[0]).toEqual({ title: 'Sticker', quantity: 1, unitPrice: null, totalPrice: null })
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `yarn workspace frontend run test -- amazon.test`
Expected: FAIL — `parseCurrencyCode` is not exported / item shape mismatches.

- [ ] **Step 3: Implement the scraper upgrade**

Replace the body of `frontend/src/bookmarklets/scrape/amazon.ts` with:

```ts
import type { CapturedItem, CapturedOrder } from './types';

function parseDate(text: string): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const m = text.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function parseTotal(text: string): number | null {
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

/** Map an Amazon money string's currency marker to an ISO 4217 code. Bare "$"
 *  is ambiguous on Amazon (CA and US both render it), so default to CAD — the
 *  household default — and let the user correct outliers on the order. */
export function parseCurrencyCode(text: string): string {
  const t = text.toUpperCase();
  if (/CDN\$|CA\$|C\$|CAD/.test(t)) return 'CAD';
  if (/US\$|USD/.test(t)) return 'USD';
  if (/£|GBP/.test(t)) return 'GBP';
  if (/€|EUR/.test(t)) return 'EUR';
  return 'CAD';
}

function parseMoneyFrom(el: Element | null | undefined): number | null {
  if (!el) return null;
  return parseTotal(el.textContent ?? '');
}

function last4From(text: string): string | null {
  return text.match(/ending in\s*(\d{4})/i)?.[1] ?? text.match(/\b(\d{4})\b/)?.[1] ?? null;
}

function extractItems(card: Element): CapturedItem[] {
  const titleEls = Array.from(
    card.querySelectorAll('.yohtmlc-product-title, a.yohtmlc-product-title, .a-link-normal.yohtmlc-product-title'),
  );
  return titleEls
    .map((titleEl): CapturedItem | null => {
      const title = (titleEl.textContent ?? '').trim();
      if (!title) return null;
      const row =
        titleEl.closest('.order-card__list-item, .a-fixed-left-grid, .a-box') ?? titleEl.parentElement ?? card;
      const priceEl = row.querySelector('.a-price .a-offscreen, .a-color-price, .yohtmlc-item-price');
      const qtyEl = row.querySelector('.item-view-qty, .product-image__qty-label, .od-item-view-qty');
      const qtyNum = qtyEl ? Number((qtyEl.textContent ?? '').replace(/\D+/g, '')) : NaN;
      return {
        title,
        quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
        unitPrice: null,
        totalPrice: parseMoneyFrom(priceEl),
      };
    })
    .filter((it): it is CapturedItem => it != null);
}

export function extractAmazonOrdersFromDom(doc: Document): CapturedOrder[] {
  const cards = Array.from(doc.querySelectorAll('.order-card, .js-order-card'));
  const seen = new Set<Element>();
  const unique = cards.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  const orders: CapturedOrder[] = [];
  for (const card of unique) {
    const cols = Array.from(card.querySelectorAll('.order-header .a-column, .order-header div'));
    let orderDate: string | null = null;
    let total: number | null = null;
    let vendorOrderId: string | null = null;
    let currency = 'CAD';

    for (const col of cols) {
      const labelEl = col.querySelector('.label, .a-color-secondary.label');
      const valueEl = col.querySelector('.value, .a-color-secondary.value, bdi');
      const label = (labelEl?.textContent ?? '').trim().toLowerCase();
      const value = (valueEl?.textContent ?? '').trim();
      if (!value) continue;
      if (label.includes('order placed') || label.includes('placed')) {
        orderDate = parseDate(value) ?? orderDate;
      } else if (label.includes('total')) {
        total = parseTotal(value) ?? total;
        currency = parseCurrencyCode(value);
      } else if (label.includes('order #') || label.includes('order id') || label.includes('order number')) {
        vendorOrderId = value;
      }
    }

    if (!vendorOrderId) {
      const bdi = card.querySelector('bdi');
      if (bdi?.textContent) vendorOrderId = bdi.textContent.trim();
    }

    const paymentLast4 = last4From(card.textContent ?? '');
    const items = extractItems(card);

    if (orderDate && total != null) {
      orders.push({
        vendorOrderId,
        orderDate,
        total,
        currency,
        paymentLast4,
        items,
        rawSource: 'bookmarklet-amazon-v1',
      });
    }
  }
  return orders;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `yarn workspace frontend run test -- amazon.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the bookmarklet still type-checks**

Run: `yarn workspace frontend run build:bookmarklets`
Expected: builds `public/bookmarklets/amazon.js` and `apple.js` with no errors.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/bookmarklets/scrape/amazon.ts frontend/src/bookmarklets/scrape/amazon.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(amazon): scrape per-item price/qty, currency, last4"
```

---

## Task 2: Build the Chrome MV3 extension

**Files:**
- Create: `frontend/src/extension/manifest.json`
- Create: `frontend/src/extension/content.ts`
- Create: `frontend/src/extension/background.ts`
- Create: `frontend/src/extension/options.html`
- Create: `frontend/src/extension/options.ts`
- Create: `frontend/vite.extension.config.ts`
- Create: `frontend/dist-extension-README.md`
- Modify: `frontend/package.json`

> This task has no automated tests (MV3 wiring is verified by manual smoke per the spec). Each step is still small and independently checkable via `tsc`/build output.

- [ ] **Step 1: Add the manifest**

Create `frontend/src/extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Cashflow Amazon Capture",
  "version": "1.0.0",
  "description": "Captures your Amazon orders into Cashflow when you open Your Orders.",
  "permissions": ["storage"],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "options_page": "options.html",
  "action": { "default_title": "Cashflow Amazon Capture" },
  "content_scripts": [
    {
      "matches": [
        "https://www.amazon.com/gp/css/order-history*",
        "https://www.amazon.com/gp/your-account/order-history*",
        "https://www.amazon.com/your-orders/orders*",
        "https://www.amazon.ca/gp/css/order-history*",
        "https://www.amazon.ca/gp/your-account/order-history*",
        "https://www.amazon.ca/your-orders/orders*",
        "https://www.amazon.co.uk/gp/css/order-history*",
        "https://www.amazon.co.uk/gp/your-account/order-history*",
        "https://www.amazon.co.uk/your-orders/orders*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Add the content script**

Create `frontend/src/extension/content.ts`:

```ts
import { extractAmazonOrdersFromDom } from '../bookmarklets/scrape/amazon';

// Content scripts run in the page's origin and are subject to its CORS policy,
// so we never POST from here — we hand the scraped orders to the background
// service worker, whose fetch (with granted host permission) is not CORS-bound.
const orders = extractAmazonOrdersFromDom(document);
if (orders.length > 0) {
  chrome.runtime.sendMessage({ type: 'CASHFLOW_CAPTURE', vendor: 'amazon', orders });
}
```

- [ ] **Step 3: Add the background service worker**

Create `frontend/src/extension/background.ts`:

```ts
interface StoredConfig {
  apiBase?: string;
  token?: string;
}

async function getConfig(): Promise<StoredConfig> {
  return new Promise((resolve) => chrome.storage.sync.get(['apiBase', 'token'], (v) => resolve(v as StoredConfig)));
}

function setBadge(text: string, color: string): void {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

chrome.runtime.onMessage.addListener((msg: { type?: string; vendor?: string; orders?: unknown[] }) => {
  if (msg?.type !== 'CASHFLOW_CAPTURE') return;
  void (async () => {
    const { apiBase, token } = await getConfig();
    if (!apiBase || !token) {
      setBadge('SET', '#b45309'); // prompt the user to open Options
      return;
    }
    try {
      const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/capture/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vendor: msg.vendor ?? 'amazon', orders: msg.orders ?? [], client: 'extension' }),
      });
      if (res.status === 401 || res.status === 403) {
        setBadge('AUTH', '#dc2626');
        return;
      }
      if (!res.ok) {
        setBadge('ERR', '#dc2626');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { created?: number; matchSuggested?: number };
      setBadge(String((msg.orders ?? []).length), '#16a34a');
      console.info('[cashflow] captured', body);
    } catch (e) {
      setBadge('ERR', '#dc2626');
      console.error('[cashflow] capture failed', e);
    }
  })();
});
```

- [ ] **Step 4: Add the options page**

Create `frontend/src/extension/options.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Cashflow Amazon Capture — Options</title>
<style>
  body { font: 14px system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.5rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; }
  #status { margin-top: 1rem; }
</style>
<h1>Cashflow Amazon Capture</h1>
<p>Mint a capture token in Cashflow → Settings → Imports, then paste it below with your Cashflow URL.</p>
<label for="apiBase">Cashflow API base URL</label>
<input id="apiBase" placeholder="https://cashflow.example.com" />
<label for="token">Capture token</label>
<input id="token" placeholder="cfc_..." />
<button id="save">Save &amp; grant access</button>
<button id="test">Test connection</button>
<p id="status"></p>
<script type="module" src="options.js"></script>
```

Create `frontend/src/extension/options.ts`:

```ts
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiBaseEl = $('apiBase') as HTMLInputElement;
const tokenEl = $('token') as HTMLInputElement;
const statusEl = $('status') as HTMLElement;

function originPattern(apiBase: string): string {
  return `${new URL(apiBase).origin}/*`;
}

chrome.storage.sync.get(['apiBase', 'token'], (v) => {
  apiBaseEl.value = (v as { apiBase?: string }).apiBase ?? '';
  tokenEl.value = (v as { token?: string }).token ?? '';
});

$('save').addEventListener('click', () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
  const token = tokenEl.value.trim();
  if (!apiBase || !token) {
    statusEl.textContent = 'Both fields are required.';
    return;
  }
  let pattern: string;
  try {
    pattern = originPattern(apiBase);
  } catch {
    statusEl.textContent = 'API base must be a full URL (https://…).';
    return;
  }
  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    if (!granted) {
      statusEl.textContent = 'Permission denied — capture cannot reach your Cashflow.';
      return;
    }
    chrome.storage.sync.set({ apiBase, token }, () => {
      statusEl.textContent = 'Saved. Open Amazon → Your Orders to capture.';
    });
  });
});

$('test').addEventListener('click', () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
  const token = tokenEl.value.trim();
  void fetch(`${apiBase}/api/capture/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ vendor: 'amazon', orders: [] }),
  })
    .then((r) => {
      // Empty orders array is rejected with 400 by a VALID token; 401 means bad token.
      statusEl.textContent = r.status === 401 ? 'Token rejected (401).' : 'Token accepted ✓';
    })
    .catch((e) => {
      statusEl.textContent = `Could not reach API: ${e instanceof Error ? e.message : String(e)}`;
    });
});
```

- [ ] **Step 5: Add the Vite build config**

Create `frontend/vite.extension.config.ts` (modeled on `vite.bookmarklets.config.ts`; one IIFE entry per invocation):

```ts
import { defineConfig } from 'vite';
import { resolve } from 'path';

const entry = process.env.EXT_ENTRY;
if (entry !== 'content' && entry !== 'background' && entry !== 'options') {
  throw new Error(`EXT_ENTRY must be "content" | "background" | "options" (got: ${String(entry)}).`);
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-extension',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, `src/extension/${entry}.ts`),
      output: {
        format: 'iife',
        entryFileNames: `${entry}.js`,
        inlineDynamicImports: true,
      },
    },
    minify: 'esbuild',
    target: 'es2020',
  },
});
```

- [ ] **Step 6: Add the README that ships in the build**

Create `frontend/dist-extension-README.md`:

```markdown
# Cashflow Amazon Capture — install (load unpacked)

1. Build it: from the repo root run `yarn workspace frontend run build:extension`.
   This produces `frontend/dist-extension/`.
2. Open Chrome → `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `frontend/dist-extension/` folder.
5. In Cashflow → **Settings → Imports**, mint a capture token.
6. Right-click the extension icon → **Options**. Paste your Cashflow URL and the
   token, click **Save & grant access**, approve the permission prompt.
7. Open Amazon → **Your Orders**. The badge shows the number of captured orders.

Re-mint a token and revoke the old one any time to rotate access. Chrome will
ask to "disable developer-mode extensions" on startup — that is expected for an
unpacked extension; leave it enabled.
```

- [ ] **Step 7: Wire the build scripts**

In `frontend/package.json`, add a `build:extension` script and append it to `build`. Change lines 8–9 to:

```json
    "build": "yarn build:bookmarklets && yarn build:extension && tsc -b && vite build",
    "build:bookmarklets": "BOOKMARKLET_ENTRY=amazon vite build --config vite.bookmarklets.config.ts && BOOKMARKLET_ENTRY=apple vite build --config vite.bookmarklets.config.ts",
    "build:extension": "EXT_ENTRY=content vite build --config vite.extension.config.ts && EXT_ENTRY=background vite build --config vite.extension.config.ts && EXT_ENTRY=options vite build --config vite.extension.config.ts && cp src/extension/manifest.json src/extension/options.html dist-extension/ && cp dist-extension-README.md dist-extension/README.md",
```

- [ ] **Step 8: Build and verify the artifact**

Run: `yarn workspace frontend run build:extension`
Expected: `frontend/dist-extension/` contains `content.js`, `background.js`, `options.js`, `manifest.json`, `options.html`, `README.md`.

Run: `ls frontend/dist-extension`
Expected: all six files listed.

- [ ] **Step 9: Add `dist-extension/` to gitignore (build output, not source)**

Append to `frontend/.gitignore` (create if absent):

```
dist-extension/
```

- [ ] **Step 10: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/extension frontend/vite.extension.config.ts frontend/dist-extension-README.md frontend/package.json frontend/.gitignore
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(amazon): Chrome MV3 auto-capture extension"
```

---

## Task 3: Auto-run matching on capture + tag extension source

**Files:**
- Modify: `backend/src/routes/capture.ts`
- Test: `backend/test/integration/amazonCaptureAutoMatch.test.ts` (create; covers Task 3 + Task 4)

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/amazonCaptureAutoMatch.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let token: string;
let testDb: PgTestDb;
let householdId: number;
let accountId: number;
let userId: number;

before(async () => {
  testDb = await setupPgTestDb('amazon-capture-automatch');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'automatch@example.com',
    displayName: 'Auto Match',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const mint = await authed.post('/api/capture/tokens').send({ label: 'Ext' });
  token = mint.body.plaintext;
  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
  const account = await models.Account.findOne();
  assert.ok(account);
  accountId = account.id;
  householdId = account.householdId as number;
  const user = await models.User.findOne();
  assert.ok(user);
  userId = user.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('sync-status is empty before any capture', async () => {
  const res = await authed.get('/api/amazon/sync-status');
  assert.equal(res.status, 200);
  assert.equal(res.body.orderCount, 0);
  assert.equal(res.body.lastCapturedAt, null);
});

test('capturing an Amazon order auto-suggests a link to a matching transaction', async () => {
  // Seed a transaction that should match the captured order (exact amount,
  // 1-day gap, Amazon merchant → score 90, well above the 70 threshold).
  await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    importBatch: 'test',
    date: '2026-05-06',
    merchantRaw: 'AMZN Mktp CA',
    merchantClean: 'AMZN Mktp CA',
    amount: '-19.99',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-automatch-1',
  } as never);

  const res = await request(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      client: 'extension',
      orders: [
        {
          vendorOrderId: '701-9999999-9999999',
          orderDate: '2026-05-05',
          total: 19.99,
          currency: 'CAD',
          paymentLast4: null,
          items: [{ title: 'A book', totalPrice: 19.99 }],
          rawSource: 'extension-amazon-v1',
        },
      ],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  assert.ok(res.body.matchSuggested >= 1, `expected matchSuggested >= 1, got ${res.body.matchSuggested}`);

  const order = await models.ExternalOrder.findOne({ where: { vendorOrderId: '701-9999999-9999999' } });
  assert.equal(order!.source, 'extension-amazon-v1');
  const links = await models.TransactionOrderLink.findAll({ where: { externalOrderId: order!.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'suggested');
});

test('sync-status reports the capture afterward', async () => {
  const res = await authed.get('/api/amazon/sync-status');
  assert.equal(res.status, 200);
  assert.ok(res.body.orderCount >= 1);
  assert.ok(typeof res.body.lastCapturedAt === 'string' && res.body.lastCapturedAt.length > 0);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --test test/integration/amazonCaptureAutoMatch.test.ts`
Expected: FAIL — `sync-status` 404, `matchSuggested` undefined, source is `bookmarklet-amazon-v1`.

> Integration tests need Postgres. If `TEST_DATABASE_URL` is unset, start one and export it (see CLAUDE.md → integration tests). The auto-match + source assertions fail until Step 3; `sync-status` until Task 4.

- [ ] **Step 3: Implement source discrimination + auto-match in `capture.ts`**

In `backend/src/routes/capture.ts`:

Add the matcher import after line 10 (`scheduleInternalBackfill` import):

```ts
import { runAmazonMatching } from '../amazon/matcher';
```

Change the `processCapturePayload` return type and append auto-matching. Replace the `return result;` at the end of the function (currently line 113) with:

```ts
  let matchSuggested = 0;
  if (vendor === 'amazon') {
    const match = await runAmazonMatching({ householdId: args.householdId });
    matchSuggested = match.suggested;
  }

  return { ...result, matchSuggested };
```

And widen the function signature's return type — change `): Promise<CaptureResult> {` (line 31) to:

```ts
): Promise<CaptureResult & { matchSuggested: number }> {
```

In the `POST /orders` handler, derive the source prefix from an optional `client`
field so extension captures are tagged distinctly. Replace the body of that
handler (lines 233–241) with:

```ts
    const { user, household } = req.captureAuth!;
    const client = String((req.body as { client?: unknown } | undefined)?.client ?? '')
      .trim()
      .toLowerCase();
    const result = await processCapturePayload({
      body: req.body,
      householdId: household.id,
      userId: user.id,
      sourcePrefix: client === 'extension' ? 'extension' : 'bookmarklet',
    });
    res.json(result);
```

- [ ] **Step 4: Run the test, confirm the auto-match + source assertions pass**

Run: `cd backend && yarn tsx --test test/integration/amazonCaptureAutoMatch.test.ts`
Expected: the auto-match test PASSES; the two `sync-status` tests still FAIL (404) until Task 4.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add backend/src/routes/capture.ts backend/test/integration/amazonCaptureAutoMatch.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(amazon): auto-run matching on capture; tag extension source"
```

---

## Task 4: Add the `GET /api/amazon/sync-status` endpoint

**Files:**
- Modify: `backend/src/routes/amazon.ts`
- Test: reuses `backend/test/integration/amazonCaptureAutoMatch.test.ts` (the two `sync-status` tests from Task 3).

- [ ] **Step 1: Confirm the sync-status tests are red**

Run: `cd backend && yarn tsx --test test/integration/amazonCaptureAutoMatch.test.ts`
Expected: the two `sync-status` tests FAIL with 404 (route not yet defined).

- [ ] **Step 2: Implement the endpoint**

In `backend/src/routes/amazon.ts`, add this route (place it after the `GET /categories` handler, around line 85). It derives freshness from existing rows — no new table:

```ts
router.get('/sync-status', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const where = { householdId: household.id, vendor: 'amazon' as const };
    const [orderCount, latest] = await Promise.all([
      ExternalOrder.count({ where }),
      ExternalOrder.max('createdAt', { where }) as Promise<Date | string | null>,
    ]);
    res.json({
      orderCount,
      lastCapturedAt: latest ? new Date(latest).toISOString() : null,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 3: Run the test, confirm all pass**

Run: `cd backend && yarn tsx --test test/integration/amazonCaptureAutoMatch.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 4: Typecheck the backend**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add backend/src/routes/amazon.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(amazon): GET /sync-status (derived freshness + count)"
```

---

## Task 5: Freshness chip + real empty state on AmazonPage

**Files:**
- Create: `frontend/src/lib/formatSyncAge.ts`
- Test: `frontend/src/lib/formatSyncAge.test.ts` (create)
- Modify: `frontend/src/pages/AmazonPage.tsx`

- [ ] **Step 1: Write the failing test for the pure formatter**

Create `frontend/src/lib/formatSyncAge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatSyncAge } from './formatSyncAge'

const now = new Date('2026-06-15T12:00:00Z')

describe('formatSyncAge', () => {
  it('returns "Never synced" for null', () => {
    expect(formatSyncAge(null, now)).toBe('Never synced')
  })
  it('formats just-now and minutes', () => {
    expect(formatSyncAge('2026-06-15T11:59:40Z', now)).toBe('Synced just now')
    expect(formatSyncAge('2026-06-15T11:30:00Z', now)).toBe('Synced 30m ago')
  })
  it('formats hours and days', () => {
    expect(formatSyncAge('2026-06-15T09:00:00Z', now)).toBe('Synced 3h ago')
    expect(formatSyncAge('2026-06-13T12:00:00Z', now)).toBe('Synced 2d ago')
  })
})
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `yarn workspace frontend run test -- formatSyncAge`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the formatter**

Create `frontend/src/lib/formatSyncAge.ts`:

```ts
/** Human freshness label for the Amazon capture sync chip. `now` is injected
 *  for deterministic tests; defaults to the current time in the app. */
export function formatSyncAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never synced'
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (secs < 60) return 'Synced just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `Synced ${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `Synced ${hours}h ago`
  const days = Math.round(hours / 24)
  return `Synced ${days}d ago`
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `yarn workspace frontend run test -- formatSyncAge`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire sync-status into AmazonPage**

In `frontend/src/pages/AmazonPage.tsx`:

Add the import near the other `lib` imports (after line 27):

```ts
import { formatSyncAge } from '../lib/formatSyncAge'
```

Add a state field after `itemPriceErrors` (line 143):

```ts
  const [syncStatus, setSyncStatus] = useState<{ orderCount: number; lastCapturedAt: string | null } | null>(null)
```

Extend `refresh` (lines 145–154) to fetch sync-status alongside the others:

```ts
  const refresh = useCallback(async () => {
    const [orderRows, txnRows, categoryRows, sync] = await Promise.all([
      getJson<AmazonOrder[]>('/api/amazon/orders?limit=50'),
      getJson<AmazonTransaction[]>('/api/amazon/review-transactions'),
      getJson<{ categories: string[] }>('/api/amazon/categories'),
      getJson<{ orderCount: number; lastCapturedAt: string | null }>('/api/amazon/sync-status'),
    ])
    setOrders(orderRows)
    setTxns(txnRows)
    setCategories(categoryRows.categories)
    setSyncStatus(sync)
  }, [])
```

Add the freshness chip inside `amazonActionRow`, before the "Run matching" button (after line 343 `<div className="amazonActionRow">`):

```tsx
          {syncStatus && (
            <span className="muted" title={syncStatus.lastCapturedAt ?? 'No Amazon orders captured yet'}>
              {formatSyncAge(syncStatus.lastCapturedAt)} · {syncStatus.orderCount} order{syncStatus.orderCount === 1 ? '' : 's'}
            </span>
          )}
```

- [ ] **Step 6: Add the real empty state**

Still in `AmazonPage.tsx`, immediately after `{message && <p className="error">{message}</p>}` (line 365), add a setup prompt shown only when there is genuinely no data:

```tsx
      {syncStatus?.orderCount === 0 && txns.length === 0 && (
        <EmptyState
          title="No Amazon data yet"
          description="Install the Cashflow Amazon Capture extension, paste a capture token from Settings → Imports, then open Amazon → Your Orders. Captured orders appear here automatically and match to your card charges."
        />
      )}
```

> `EmptyState` is already imported (line 14). If its prop names differ from `title`/`description`, open `frontend/src/components/ui/empty-state.tsx` and match the actual prop signature — do not invent props.

- [ ] **Step 7: Verify build + tests**

Run: `yarn workspace frontend run test -- formatSyncAge amazon.test`
Expected: PASS.

Run: `yarn workspace frontend run build`
Expected: builds with no type errors (this also runs `tsc -b`).

- [ ] **Step 8: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/lib/formatSyncAge.ts frontend/src/lib/formatSyncAge.test.ts frontend/src/pages/AmazonPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(amazon): sync freshness chip + real empty state"
```

---

## Task 6: Full verification

- [ ] **Step 1: Backend typecheck + amazon/capture tests**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/bookmarklets 2>/dev/null; yarn tsx --test test/integration/amazonCaptureAutoMatch.test.ts test/integration/captureOrders.test.ts`
Expected: PASS (auto-match, sync-status, and existing capture behavior all green).

- [ ] **Step 2: Frontend tests + build**

Run: `yarn workspace frontend run test`
Expected: PASS (including the new scraper + formatSyncAge suites).

Run: `yarn workspace frontend run build`
Expected: builds frontend + bookmarklets + extension with no errors.

- [ ] **Step 3: Manual extension smoke (the one non-automated check)**

1. `yarn workspace frontend run build:extension`
2. Load `frontend/dist-extension/` unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked).
3. Options → paste local API base (`http://localhost:3001`) + a minted token → Save & grant.
4. With `yarn dev` running and you logged in, open Amazon → Your Orders.
5. Confirm: badge shows a captured count; the AmazonPage freshness chip updates to "Synced just now"; suggested links appear without clicking "Run matching".

- [ ] **Step 4: Confirm clean tree + push**

```bash
git status
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git push -u origin claude/practical-dhawan-476f33
```

---

## Notes for the implementer

- **Do not** add scraper price/qty selectors beyond what the fixtures cover without a fixture to prove them — Amazon's DOM varies by region and account; the parser is best-effort and must degrade to `null`, never throw.
- The capture endpoint already validates dates/totals/items and dedupes by `dedupeKey`; the extension path reuses all of it. Do not re-validate in the extension.
- `runAmazonMatching` is idempotent and fan-out-guarded (`selectMatchCandidates`), so calling it on every capture cannot create duplicate or spurious links.
- Source tag lengths fit `external_orders.source` STRING(32): `extension-amazon-v1` (19), `bookmarklet-amazon-v1` (21).

## Deferred (out of scope — do not build)

- The transaction-anchored single-ledger rebuild (collapsing "review transactions" + "recent orders" into one list with exception buckets).
- Chrome Web Store unlisted distribution.
- Auto-pairing the token from the app, Gmail OAuth, inbound-email webhooks.

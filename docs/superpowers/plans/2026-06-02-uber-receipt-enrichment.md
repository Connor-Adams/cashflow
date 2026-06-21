# Uber Receipt Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link Uber Eats food items and Uber ride trip details to their card transactions, modeling rides (`vendor:'uber'`) and Eats (`vendor:'uber_eats'`) as two distinct vendors, and infer ride business-use from trip context.

**Architecture:** Reuse the existing Gmail-scan → `ExternalOrder`/`ExternalOrderItem` → `linkItemsStage` propagation. The `vendor` field is the ride/Eats discriminator (no `kind` column, no migration). Phase 1 unblocks Eats by teaching the two vendor-pattern maps about Uber and forcing `vendor` from the sender; Phase 2 adds a deterministic ride parser, trip detail in `rawPayload.trip`, and an AI trip business-use categorizer. Trip detail surfaces in the existing receipt drawer.

**Tech Stack:** TypeScript, Node (`node:test` via `tsx`), Sequelize, Express, React. OpenAI via `openaiJsonWithMeta`.

**Spec:** `docs/superpowers/specs/2026-06-02-uber-receipt-enrichment-design.md`

**Test command (single file):** `cd backend && npx tsx --import ./test/setup.ts --test test/<file>.test.ts`
Backend tests live in `backend/test/` (NOT co-located with `src`).

---

## File Structure

**Phase 1 (Eats unblock):**
- `backend/src/integrations/parsers/uber.ts` — NEW. Vendor classifier (`classifyUberKind`, `uberVendorOverride`). Extended with ride parsing in Phase 2.
- `backend/src/import/matchReceiptToTransactions.ts` — MODIFY. Add `uber`/`uber_eats` to `VENDOR_MERCHANT_PATTERNS`.
- `backend/src/import/enrichment/linkItemsStage.ts` — MODIFY. Add `uber_eats`/`uber` to `VENDOR_MATCHERS`; export `matchVendor` for testing.
- `backend/src/integrations/scanReceipts.ts` — MODIFY. Flip Uber `vendorHint` to `'uber'`; override `extracted.vendor` via `uberVendorOverride`.

**Phase 2 (Rides):**
- `backend/src/ai/extractReceiptItems.ts` — MODIFY. Add `TripDetail` type, `trip?` on order, `businessUsePercent?` on item, `parseTrip`.
- `backend/src/integrations/parsers/uber.ts` — MODIFY. Add `parseUberRide`.
- `backend/src/integrations/parsers/index.ts` — MODIFY. Dispatch Uber sender → `parseUberRide`.
- `backend/src/ai/aiCategorizeUberTrip.ts` — NEW. Trip business-use inference.
- `backend/src/integrations/scanReceipts.ts` — MODIFY. Persist `rawPayload.trip`; categorize ride; honor item `businessUsePercent`.
- `backend/src/routes/receipts.ts` — MODIFY. Include `trip` in the serialized order.
- `shared/api-types.ts` — MODIFY. Add `trip` to `ExternalOrderView` + a `TripDetailView` type.
- `frontend/src/components/ReceiptItemsDrawer.tsx` — MODIFY. Render a trip block when `order.trip` is present.

---

# PHASE 1 — Eats unblock

## Task 1: Teach the receipt-matcher about Uber vendors

**Files:**
- Modify: `backend/src/import/matchReceiptToTransactions.ts` (the `VENDOR_MERCHANT_PATTERNS` const)
- Test: `backend/test/uberVendorPatterns.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/uberVendorPatterns.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txnMatchesVendor } from '../src/import/matchReceiptToTransactions';
import type { Transaction } from '../src/models/Transaction';

function makeTxn(merchant: string): Transaction {
  return { merchantRaw: merchant, merchantClean: merchant } as Transaction;
}

test('uber_eats matches Uber Eats card descriptors', () => {
  assert.equal(txnMatchesVendor('uber_eats', makeTxn('UBER *EATS')), true);
  assert.equal(txnMatchesVendor('uber_eats', makeTxn('UBER EATS')), true);
});

test('uber matches ride descriptors but never Eats', () => {
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER *TRIP')), true);
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER TRIP HELP.UBER.COM')), true);
  assert.equal(txnMatchesVendor('uber', makeTxn('UBER *EATS')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberVendorPatterns.test.ts`
Expected: FAIL — `txnMatchesVendor('uber_eats', ...)` returns `false` (no `uber_eats` key).

- [ ] **Step 3: Add the patterns**

In `backend/src/import/matchReceiptToTransactions.ts`, add two entries to `VENDOR_MERCHANT_PATTERNS` (the `uber_eats` entry must exist independently; order within the object is irrelevant because lookup is keyed by `order.vendor`):

```ts
const VENDOR_MERCHANT_PATTERNS: Record<string, RegExp> = {
  amazon: /\b(amazon(?:\.(?:com|ca|co\.uk))?|amzn|prime\s*video)\b/i,
  apple: /\b(apple(?:\.com)?|itunes|app\s*store|apple\s*music|apple\s*tv|icloud)\b/i,
  google: /\b(google(?:\s*play)?|googlepay|youtube\s*premium)\b/i,
  costco: /\bcostco\b/i,
  uber_eats: /\buber\s*\*?\s*eats\b/i,
  uber: /\buber\b(?!\s*\*?\s*eats)/i,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberVendorPatterns.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/matchReceiptToTransactions.ts backend/test/uberVendorPatterns.test.ts
git commit -m "feat(receipts): match uber and uber_eats vendors in receipt matcher"
```

---

## Task 2: Teach the enrichment link stage about Uber vendors

**Files:**
- Modify: `backend/src/import/enrichment/linkItemsStage.ts` (the `VENDOR_MATCHERS` array + export `matchVendor`)
- Test: `backend/test/linkItemsUberVendor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/linkItemsUberVendor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchVendor } from '../src/import/enrichment/linkItemsStage';

test('Uber Eats resolves before Uber (array order)', () => {
  assert.deepEqual(matchVendor('UBER *EATS'), { vendor: 'uber_eats', canonical: 'Uber Eats' });
  assert.deepEqual(matchVendor('UBER EATS TORONTO'), { vendor: 'uber_eats', canonical: 'Uber Eats' });
});

test('Uber ride resolves to uber', () => {
  assert.deepEqual(matchVendor('UBER *TRIP'), { vendor: 'uber', canonical: 'Uber' });
  assert.deepEqual(matchVendor('UBER TRIP HELP.UBER.COM'), { vendor: 'uber', canonical: 'Uber' });
});

test('non-Uber merchants are unaffected', () => {
  assert.deepEqual(matchVendor('AMZN MKTP'), { vendor: 'amazon', canonical: 'Amazon' });
  assert.equal(matchVendor('STARBUCKS'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/linkItemsUberVendor.test.ts`
Expected: FAIL — `matchVendor` is not exported / Uber returns `null`.

- [ ] **Step 3: Export `matchVendor` and add Uber matchers**

In `backend/src/import/enrichment/linkItemsStage.ts`:

(a) Add two entries to the END of the `VENDOR_MATCHERS` array — `uber_eats` BEFORE `uber` (first-match-wins):

```ts
  {
    vendor: 'costco',
    canonical: 'Costco',
    pattern: /\bcostco\b/i,
  },
  {
    vendor: 'uber_eats',
    canonical: 'Uber Eats',
    pattern: /\buber\s*\*?\s*eats\b/i,
  },
  {
    vendor: 'uber',
    canonical: 'Uber',
    pattern: /\buber\b/i,
  },
];
```

(b) Change `function matchVendor(...)` to `export function matchVendor(...)` (signature unchanged):

```ts
export function matchVendor(merchantText: string): { vendor: string; canonical: string } | null {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/linkItemsUberVendor.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/linkItemsStage.ts backend/test/linkItemsUberVendor.test.ts
git commit -m "feat(enrichment): resolve uber and uber_eats vendors in link-items stage"
```

---

## Task 3: Uber vendor classifier

**Files:**
- Create: `backend/src/integrations/parsers/uber.ts`
- Test: `backend/test/uberClassifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/uberClassifier.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUberKind, uberVendorOverride } from '../src/integrations/parsers/uber';

test('classifyUberKind detects Eats vs ride', () => {
  assert.equal(classifyUberKind('Your Uber Eats order with Pizza Place', 'Total ...'), 'uber_eats');
  assert.equal(classifyUberKind('Your Tuesday morning trip with Uber', 'Thanks for riding'), 'uber');
  assert.equal(classifyUberKind(null, 'Uber Eats receipt body'), 'uber_eats');
});

test('uberVendorOverride only fires for uber.com senders', () => {
  assert.equal(uberVendorOverride('receipts@uber.com', 'Your Uber Eats order', ''), 'uber_eats');
  assert.equal(uberVendorOverride('Uber Receipts <noreply@uber.com>', 'Your trip', 'Thanks for riding'), 'uber');
  assert.equal(uberVendorOverride('no-reply@apple.com', 'Uber Eats', ''), null);
  assert.equal(uberVendorOverride(null, 'x', ''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberClassifier.test.ts`
Expected: FAIL — module `../src/integrations/parsers/uber` does not exist.

- [ ] **Step 3: Create the classifier**

Create `backend/src/integrations/parsers/uber.ts`:

```ts
/**
 * Uber receipt parsing. Uber rides and Uber Eats are modeled as two distinct
 * vendors ('uber', 'uber_eats'). The sender address can't distinguish them
 * (both arrive from uber.com), so we classify from the subject/body.
 *
 * Phase 2 adds parseUberRide() for deterministic trip extraction.
 */

/** Classify an Uber email as a ride ('uber') or an Eats order ('uber_eats'). */
export function classifyUberKind(subject: string | null, body: string): 'uber' | 'uber_eats' {
  const hay = `${subject ?? ''} ${body}`;
  return /uber\s*eats/i.test(hay) ? 'uber_eats' : 'uber';
}

/**
 * Returns the Uber vendor to force on an extracted order, or null when the
 * message isn't from an Uber sender. The Gmail query already restricts senders
 * to the allowlist, so an @uber.com From is authoritative.
 */
export function uberVendorOverride(
  fromAddress: string | null,
  subject: string | null,
  body: string,
): 'uber' | 'uber_eats' | null {
  if (!/@uber\.com/i.test(fromAddress ?? '')) return null;
  return classifyUberKind(subject, body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberClassifier.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/parsers/uber.ts backend/test/uberClassifier.test.ts
git commit -m "feat(receipts): add uber vendor classifier (ride vs eats)"
```

---

## Task 4: Wire the classifier into the Gmail scan

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` (lines 70-72 sender hints; the extraction block ~434-450)

Integration wiring — coverage is provided by Task 3's helper tests. No new test.

- [ ] **Step 1: Flip the Uber sender hints**

In `backend/src/integrations/scanReceipts.ts`, change the three Uber entries in `DEFAULT_RECEIPT_SENDERS` from `vendorHint: 'other'` to `vendorHint: 'uber'`:

```ts
  // Rides / food
  { address: 'receipts@uber.com', vendorHint: 'uber', label: 'Uber receipts' },
  { address: 'noreply@uber.com', vendorHint: 'uber', label: 'Uber' },
  { address: 'no-reply@uber.com', vendorHint: 'uber', label: 'Uber' },
```

- [ ] **Step 2: Import the override helper**

Add to the import of `extractReceiptFromText` area (top of file, near line 40):

```ts
import { extractReceiptFromText } from '../ai/extractReceiptItems';
import { uberVendorOverride } from './parsers/uber';
```

- [ ] **Step 3: Apply the override after extraction**

In `processOne`, immediately AFTER the det-parse / AI-fallback block (just after the `extracted = await extractReceiptFromText(body); parser = 'ai'; aiExtractions++;` else-branch closes, before `result.parser = parser;`), insert:

```ts
      // Uber rides and Uber Eats both arrive from uber.com but the AI returns
      // vendor 'other'. The sender is authoritative for the vendor family;
      // subject/body picks ride vs eats.
      const uberVendor = uberVendorOverride(result.from, result.subject, body);
      if (uberVendor) {
        extracted.vendor = uberVendor;
      }
```

- [ ] **Step 4: Verify the full backend test suite still passes**

Run: `cd backend && yarn test`
Expected: PASS (no regressions; existing scanReceipts tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts
git commit -m "feat(receipts): force uber/uber_eats vendor from sender on gmail scan"
```

**At this point Phase 1 is complete: Uber Eats emails create `vendor:'uber_eats'` orders that link to the charge, and `Dining` propagates via the existing link stage.**

---

# PHASE 2 — Rides

## Task 5: Trip types + lenient parse

**Files:**
- Modify: `backend/src/ai/extractReceiptItems.ts`
- Test: `backend/test/extractReceiptTrip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/extractReceiptTrip.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractedReceipt } from '../src/ai/extractReceiptItems';

test('parseExtractedReceipt reads an optional trip block', () => {
  const order = parseExtractedReceipt({
    vendor: 'uber',
    total: 23.45,
    items: [],
    trip: {
      pickupAddress: '123 Main St',
      dropoffAddress: '456 King St W',
      distance: 12.3,
      distanceUnit: 'km',
      durationMinutes: 27,
      requestedAt: '2026-03-03T09:14:00Z',
      driver: 'Sam',
      surgeMultiplier: 1.2,
    },
  });
  assert.equal(order.trip?.distance, 12.3);
  assert.equal(order.trip?.distanceUnit, 'km');
  assert.equal(order.trip?.dropoffAddress, '456 King St W');
});

test('parseExtractedReceipt defaults trip to null', () => {
  const order = parseExtractedReceipt({ vendor: 'other', total: 5, items: [] });
  assert.equal(order.trip ?? null, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/extractReceiptTrip.test.ts`
Expected: FAIL — `order.trip` is `undefined` / type error.

- [ ] **Step 3: Add the types and parse**

In `backend/src/ai/extractReceiptItems.ts`:

(a) Add the `TripDetail` type and extend `ExtractedReceiptItem` + `ExtractedReceiptOrder`:

```ts
export type TripDetail = {
  pickupAddress: string | null;
  dropoffAddress: string | null;
  distance: number | null;
  distanceUnit: 'km' | 'mi' | null;
  durationMinutes: number | null;
  requestedAt: string | null;
  driver: string | null;
  surgeMultiplier: number | null;
};
```

Add `businessUsePercent?: number | null;` to `ExtractedReceiptItem`, and `trip?: TripDetail | null;` to `ExtractedReceiptOrder`.

(b) Add a `parseTrip` helper:

```ts
function parseTrip(v: unknown): TripDetail | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const unit = parseString(r.distanceUnit);
  return {
    pickupAddress: parseString(r.pickupAddress),
    dropoffAddress: parseString(r.dropoffAddress),
    distance: parseNumber(r.distance),
    distanceUnit: unit === 'km' || unit === 'mi' ? unit : null,
    durationMinutes: parseNumber(r.durationMinutes),
    requestedAt: parseString(r.requestedAt),
    driver: parseString(r.driver),
    surgeMultiplier: parseNumber(r.surgeMultiplier),
  };
}
```

(c) In `parseExtractedReceipt`, add `trip: parseTrip(j.trip),` to the returned object.

(d) Extend `SYSTEM_PROMPT` so the AI fallback can emit a trip for ride receipts (lets rides the deterministic parser misses still carry trip detail). Append to the schema and rules in the prompt string:

```ts
// Add to the JSON schema block in SYSTEM_PROMPT:
//   "trip": { "pickupAddress": string|null, "dropoffAddress": string|null,
//             "distance": number|null, "distanceUnit": "km"|"mi"|null,
//             "durationMinutes": number|null, "requestedAt": string|null,
//             "driver": string|null, "surgeMultiplier": number|null } | null
// Add to the rules:
//   - Only populate "trip" for rideshare/taxi receipts (e.g. Uber/Lyft trips).
//     For all other receipts set "trip": null.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/extractReceiptTrip.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/extractReceiptItems.ts backend/test/extractReceiptTrip.test.ts
git commit -m "feat(receipts): add TripDetail type and lenient trip parse"
```

---

## Task 6: Deterministic Uber ride parser

**Files:**
- Modify: `backend/src/integrations/parsers/uber.ts` (add `parseUberRide`)
- Modify: `backend/src/integrations/parsers/index.ts` (dispatch)
- Test: `backend/test/uberRideParser.test.ts`

> Note: Uber email templates vary by locale; the regexes below target the
> plain-text body produced by `gmail.extractMessageBody`. Tune against real
> sanitized fixtures when available (spec fast-follow). Until then the AI
> fallback (Task 5 schema) carries rides the parser misses.

- [ ] **Step 1: Write the failing test**

Create `backend/test/uberRideParser.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUberRide } from '../src/integrations/parsers/uber';

const RIDE_BODY = [
  'Thanks for riding, Connor',
  'Total $23.45',
  'March 3, 2026',
  '9:14 AM  123 Main St, Toronto',
  '9:41 AM  456 King St W, Toronto',
  '12.3 km | 27 min',
].join('\n');

test('parseUberRide extracts fare, distance, duration, addresses', () => {
  const order = parseUberRide(RIDE_BODY);
  assert.ok(order);
  assert.equal(order!.vendor, 'uber');
  assert.equal(order!.total, 23.45);
  assert.equal(order!.items.length, 1);
  assert.equal(order!.items[0].inferredCategory, 'Transport');
  assert.equal(order!.trip?.distance, 12.3);
  assert.equal(order!.trip?.distanceUnit, 'km');
  assert.equal(order!.trip?.durationMinutes, 27);
  assert.equal(order!.trip?.pickupAddress, '123 Main St, Toronto');
  assert.equal(order!.trip?.dropoffAddress, '456 King St W, Toronto');
});

test('parseUberRide returns null for a non-ride body', () => {
  assert.equal(parseUberRide('Your Uber Eats order. Total $11.00'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberRideParser.test.ts`
Expected: FAIL — `parseUberRide` is not exported.

- [ ] **Step 3: Implement `parseUberRide`**

Append to `backend/src/integrations/parsers/uber.ts` (add the import at the top):

```ts
import type { ExtractedReceiptOrder, TripDetail } from '../../ai/extractReceiptItems';

const RIDE_TOTAL_RE = /\bTotal\b\s*\$?\s*([0-9]+\.[0-9]{2})/i;
const DISTANCE_RE = /([0-9]+(?:\.[0-9]+)?)\s*(km|mi)\b/i;
const DURATION_RE = /([0-9]+)\s*min\b/i;
const TIME_ADDR_RE = /\b\d{1,2}:\d{2}\s*[AP]M\s+(.+?)\s*$/gim;

/** Parse an Uber RIDE email body. Returns null if it doesn't look like a ride. */
export function parseUberRide(body: string): ExtractedReceiptOrder | null {
  if (/uber\s*eats/i.test(body)) return null; // Eats handled by AI extraction
  const totalMatch = body.match(RIDE_TOTAL_RE);
  if (!totalMatch) return null;
  const total = Number(totalMatch[1]);

  const distMatch = body.match(DISTANCE_RE);
  const durMatch = body.match(DURATION_RE);
  const addresses: string[] = [];
  for (const m of body.matchAll(TIME_ADDR_RE)) {
    addresses.push(m[1].trim());
  }

  const trip: TripDetail = {
    pickupAddress: addresses[0] ?? null,
    dropoffAddress: addresses[1] ?? null,
    distance: distMatch ? Number(distMatch[1]) : null,
    distanceUnit: distMatch ? (distMatch[2].toLowerCase() as 'km' | 'mi') : null,
    durationMinutes: durMatch ? Number(durMatch[1]) : null,
    requestedAt: null,
    driver: null,
    surgeMultiplier: null,
  };

  return {
    vendor: 'uber',
    vendorName: 'Uber',
    orderDate: null,
    orderId: null,
    subtotal: null,
    tax: null,
    total,
    currency: null,
    paymentLast4: null,
    tenders: [],
    items: [
      {
        title: 'Uber trip',
        quantity: 1,
        unitPrice: total,
        totalPrice: total,
        inferredCategory: 'Transport',
      },
    ],
    notes: null,
    trip,
  };
}
```

- [ ] **Step 4: Register the parser in the dispatch**

In `backend/src/integrations/parsers/index.ts`, add the import and an Uber branch BEFORE the final `return`:

```ts
import { parseUberRide } from './uber';
```

```ts
  // Uber (rides only; Eats falls through to AI item extraction)
  if (/@?uber\.com/.test(from)) {
    const order = parseUberRide(ctx.body);
    if (order) return { ok: true, parser: 'uber', order };
    return { ok: false, reason: 'uber_parser_no_match' };
  }

  return { ok: false, reason: 'no_vendor_parser' };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/uberRideParser.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/parsers/uber.ts backend/src/integrations/parsers/index.ts backend/test/uberRideParser.test.ts
git commit -m "feat(receipts): deterministic uber ride parser with trip detail"
```

---

## Task 7: AI ride business-use categorizer

**Files:**
- Create: `backend/src/ai/aiCategorizeUberTrip.ts`
- Test: `backend/test/aiCategorizeUberTrip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/aiCategorizeUberTrip.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeUberTrip } from '../src/ai/aiCategorizeUberTrip';
import type { TripDetail } from '../src/ai/extractReceiptItems';

const TRIP: TripDetail = {
  pickupAddress: 'Home',
  dropoffAddress: '200 Bay St (office)',
  distance: 8,
  distanceUnit: 'km',
  durationMinutes: 20,
  requestedAt: '2026-03-03T08:30:00Z',
  driver: null,
  surgeMultiplier: null,
};

test('categorizeUberTrip returns category + businessUsePercent from the model', async () => {
  const fakeCaller = async () => ({
    json: { category: 'Transport', businessUsePercent: 100, confidence: 80, rationale: 'weekday commute to office' },
    raw: '',
    model: 'test',
    promptTokens: 0,
    completionTokens: 0,
  });
  const result = await categorizeUberTrip(TRIP, { caller: fakeCaller as never });
  assert.equal(result.category, 'Transport');
  assert.equal(result.businessUsePercent, 100);
});

test('categorizeUberTrip clamps a missing businessUsePercent to null', async () => {
  const fakeCaller = async () => ({
    json: { category: 'Transport', businessUsePercent: null, confidence: 50, rationale: 'personal' },
    raw: '',
    model: 'test',
    promptTokens: 0,
    completionTokens: 0,
  });
  const result = await categorizeUberTrip(TRIP, { caller: fakeCaller as never });
  assert.equal(result.businessUsePercent, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aiCategorizeUberTrip.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the categorizer**

Create `backend/src/ai/aiCategorizeUberTrip.ts` (mirrors the injectable-caller pattern from `amazon/aiCategorizeAmazonItems.ts`):

```ts
import { openaiJsonWithMeta, type OpenAiJsonResult } from './openaiJson';
import type { TripDetail } from './extractReceiptItems';

export type UberTripCategorization = {
  category: string;
  businessUsePercent: number | null;
  confidence: number;
  rationale: string;
};

export type UberTripOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>;

const SYSTEM_PROMPT = `You classify a single Uber ride for personal-finance purposes.
Reply with JSON only:
{"category": string, "businessUsePercent": number|null, "confidence": number, "rationale": string}
Rules:
- category is a short label, default "Transport".
- businessUsePercent is 0-100 when the trip is plausibly for work (weekday, work hours,
  office/airport/client destination); null when clearly personal or uncertain.
- confidence 0-100.`;

function clampPercent(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function categorizeUberTrip(
  trip: TripDetail,
  opts: { caller?: UberTripOpenAiCaller } = {},
): Promise<UberTripCategorization> {
  const caller = opts.caller ?? ((m, o) => openaiJsonWithMeta(m, o));
  const meta = await caller(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(trip) },
    ],
    { temperature: 0 },
  );
  const j = (meta.json ?? {}) as Record<string, unknown>;
  const category =
    typeof j.category === 'string' && j.category.trim() ? j.category.trim().slice(0, 128) : 'Transport';
  return {
    category,
    businessUsePercent: clampPercent(j.businessUsePercent),
    confidence: clampConfidence(j.confidence),
    rationale: typeof j.rationale === 'string' ? j.rationale.slice(0, 512) : '',
  };
}
```

> Verify `openaiJsonWithMeta`'s return field for parsed JSON is named `json` and
> its options accept `{ temperature }` — open `backend/src/ai/openaiJson.ts` and
> align the field/option names if they differ.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aiCategorizeUberTrip.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/aiCategorizeUberTrip.ts backend/test/aiCategorizeUberTrip.test.ts
git commit -m "feat(receipts): AI categorizer for uber ride business-use"
```

---

## Task 8: Persist trip detail + business-use in the scan

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` (extraction block, order `defaults`, `bulkCreate`)

Integration wiring over Tasks 5-7 (each unit-tested). No new test; verify via full suite.

- [ ] **Step 1: Import the categorizer**

Near the existing parser/AI imports in `backend/src/integrations/scanReceipts.ts`:

```ts
import { categorizeUberTrip } from '../ai/aiCategorizeUberTrip';
```

- [ ] **Step 2: Categorize ride trips before persistence**

In `processOne`, AFTER the `no_items` guard (the `if (extracted.total == null && extracted.items.length === 0)` block) and BEFORE the `const dedupeKey = [...]` line, insert:

```ts
      // For Uber rides, infer business-use from trip context and stamp it on
      // the single synthetic trip item so it propagates via linkItemsStage.
      if (extracted.vendor === 'uber' && extracted.trip && extracted.items[0]) {
        try {
          const cat = await categorizeUberTrip(extracted.trip);
          extracted.items[0].inferredCategory = cat.category;
          extracted.items[0].businessUsePercent = cat.businessUsePercent;
        } catch (err) {
          logger.warn(
            { messageId: summary.id, error: err instanceof Error ? err.message : String(err) },
            'uber_trip_categorize_failed',
          );
        }
      }
```

- [ ] **Step 3: Persist `rawPayload.trip`**

In the `ExternalOrder.findOrCreate` `defaults`, change the `rawPayload` line to surface the trip at top level:

```ts
            rawPayload: { extracted, gmailMessageId: summary.id, parser, trip: extracted!.trip ?? null } as unknown,
```

- [ ] **Step 4: Honor the item's business-use in `bulkCreate`**

In the `ExternalOrderItem.bulkCreate` map, change the hardcoded `businessUsePercent: null` line to:

```ts
              businessUsePercent: it.businessUsePercent != null ? String(it.businessUsePercent) : null,
```

- [ ] **Step 5: Verify the full backend suite passes**

Run: `cd backend && yarn test`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/scanReceipts.ts
git commit -m "feat(receipts): persist uber trip detail and ride business-use on scan"
```

---

## Task 9: Surface trip detail in the receipt API

**Files:**
- Modify: `shared/api-types.ts` (`ExternalOrderView` + new `TripDetailView`)
- Modify: `backend/src/routes/receipts.ts` (order serialization ~244-252)
- Test: `backend/test/receiptsTripSerialization.test.ts` (pure shape helper)

- [ ] **Step 1: Add the shared types**

In `shared/api-types.ts`, add a `TripDetailView` and extend `ExternalOrderView`:

```ts
export type TripDetailView = {
  pickupAddress: string | null;
  dropoffAddress: string | null;
  distance: number | null;
  distanceUnit: 'km' | 'mi' | null;
  durationMinutes: number | null;
  requestedAt: string | null;
  driver: string | null;
  surgeMultiplier: number | null;
};
```

Add `trip?: TripDetailView | null;` to `ExternalOrderView`.

- [ ] **Step 2: Write the failing test**

Create `backend/test/receiptsTripSerialization.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTrip } from '../src/routes/receipts';

test('orderTrip pulls trip out of rawPayload', () => {
  const trip = { pickupAddress: 'A', dropoffAddress: 'B', distance: 5, distanceUnit: 'km',
    durationMinutes: 10, requestedAt: null, driver: null, surgeMultiplier: null };
  assert.deepEqual(orderTrip({ rawPayload: { trip } } as never), trip);
  assert.equal(orderTrip({ rawPayload: null } as never), null);
  assert.equal(orderTrip({ rawPayload: { extracted: {} } } as never), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/receiptsTripSerialization.test.ts`
Expected: FAIL — `orderTrip` is not exported.

- [ ] **Step 4: Add `orderTrip` and include it in the response**

In `backend/src/routes/receipts.ts`, add (near the top, after imports). Add `ExternalOrder` to the EXISTING `../models` import if it isn't already imported there (don't create a duplicate import line); add the shared type import:

```ts
// ensure ExternalOrder is in the existing: import { ... ExternalOrder ... } from '../models';
import type { TripDetailView } from '@cashflow/shared';

export function orderTrip(order: Pick<ExternalOrder, 'rawPayload'>): TripDetailView | null {
  const raw = order.rawPayload as { trip?: TripDetailView | null } | null;
  return raw?.trip ?? null;
}
```

Then in the order serialization block (currently lines 244-252), add the `trip` field:

```ts
          order: order
            ? {
                id: order.id,
                vendor: order.vendor,
                subtotal: order.subtotal,
                tax: order.tax,
                shipping: order.shipping,
                total: order.total,
                currency: order.currency,
                trip: orderTrip(order),
              }
            : null,
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/receiptsTripSerialization.test.ts`
Expected: PASS.
Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/api-types.ts backend/src/routes/receipts.ts backend/test/receiptsTripSerialization.test.ts
git commit -m "feat(receipts): expose uber trip detail in receipt order view"
```

---

## Task 10: Render the trip block in the receipt drawer

**Files:**
- Modify: `frontend/src/components/ReceiptItemsDrawer.tsx` (the `ReceiptPanel` render)
- Test: `frontend/src/components/ReceiptItemsDrawer.test.tsx` (add a case)

- [ ] **Step 1: Write the failing test**

FIRST read `frontend/src/components/ReceiptItemsDrawer.test.tsx` end-to-end to learn its render harness, factories, and how it mounts `ReceiptPanel` (it may render the whole `ReceiptItemsDrawer` rather than the panel directly). Then add a case rendering a receipt whose `order.trip` is set, asserting the route + distance render, using THIS file's existing helpers (the snippet below is the shape to adapt, not verbatim names):

```tsx
test('renders a trip block for Uber rides', () => {
  const receipt = makeReceiptWithItems({
    order: {
      id: 1, vendor: 'uber', subtotal: null, tax: null, shipping: null,
      total: '23.45', currency: 'CAD',
      trip: {
        pickupAddress: '123 Main St', dropoffAddress: '456 King St W',
        distance: 12.3, distanceUnit: 'km', durationMinutes: 27,
        requestedAt: null, driver: null, surgeMultiplier: null,
      },
    },
    items: [],
  });
  render(<ReceiptPanelHarness receipt={receipt} />);
  expect(screen.getByText(/123 Main St/)).toBeInTheDocument();
  expect(screen.getByText(/12.3\s*km/)).toBeInTheDocument();
});
```

> Use the test file's existing helpers (`makeReceiptWithItems` / harness, `render`,
> `screen`). If a factory doesn't exist, build the `ReceiptWithItems` object inline
> matching the shape used by the other tests in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test ReceiptItemsDrawer`
Expected: FAIL — no trip block rendered.

- [ ] **Step 3: Render the trip block**

In `frontend/src/components/ReceiptItemsDrawer.tsx`, inside `ReceiptPanel`, after the vendor header `<div>` and before the `<table>`, add:

```tsx
      {order.trip && (
        <div style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: '#444' }}>
          <div>
            {order.trip.pickupAddress ?? '—'} → {order.trip.dropoffAddress ?? '—'}
          </div>
          <div style={{ color: '#666' }}>
            {order.trip.distance != null && `${order.trip.distance} ${order.trip.distanceUnit ?? ''}`}
            {order.trip.distance != null && order.trip.durationMinutes != null && ' · '}
            {order.trip.durationMinutes != null && `${order.trip.durationMinutes} min`}
          </div>
        </div>
      )}
```

Also change the vendor label to read `Uber` / `Uber Eats` from the vendor key:

```tsx
        <strong>{order.vendor === 'uber' ? 'Uber' : order.vendor === 'uber_eats' ? 'Uber Eats' : order.vendor}</strong>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn test ReceiptItemsDrawer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ReceiptItemsDrawer.tsx frontend/src/components/ReceiptItemsDrawer.test.tsx
git commit -m "feat(receipts): render uber trip detail in receipt drawer"
```

---

## Final verification

- [ ] **Backend suite:** `cd backend && yarn test` → PASS
- [ ] **Backend typecheck:** `cd backend && yarn typecheck` → no errors
- [ ] **Frontend tests + typecheck:** `cd frontend && yarn test` and `yarn typecheck` (or `yarn build`) → PASS
- [ ] **Lint:** `cd backend && yarn lint` → clean for touched files
```

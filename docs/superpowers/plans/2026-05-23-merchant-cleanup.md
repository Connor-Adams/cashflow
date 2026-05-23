# Merchant Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse duplicate-merchant noise by fixing the dashboard's grouping key, extending the normalizer and brand dictionary, and adding a Wealthsimple-investment normalization stage.

**Architecture:** No new tables, no UI. Three surgical code edits + one new enrichment stage + one one-off backfill. The dashboard report fix (1 line) immediately surfaces existing `merchant_canonical` work that's currently invisible.

**Tech Stack:** TypeScript, `node:test` (`tsx --test test/*.test.ts`), Sequelize (already wired), existing enrichment pipeline in `backend/src/import/enrich.ts`.

**Spec:** [docs/superpowers/specs/2026-05-23-merchant-cleanup-design.md](../specs/2026-05-23-merchant-cleanup-design.md)

**Testing convention (read once):** All tests live in `backend/test/*.test.ts` using Node's built-in test runner with `assert/strict`. Run with `yarn workspace backend test` from repo root, or `cd backend && yarn test`. Run a single file with `cd backend && npx tsx --test test/<file>.test.ts`.

---

### Task 1: Mid-string store-number stripping in `normalizeMerchant`

Strips numeric/alphanumeric store IDs that sit between merchant words and city/state words (e.g., `MCDONALD'S #12164 GUELPH`, `STARBUCKS 04747 GUELPH`, `WALMART 3144 3144 GUELPH`, `SHELL C12587 GUELPH`).

**Files:**
- Modify: `backend/src/import/normalizeMerchant.ts`
- Test: `backend/test/normalizeMerchant.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/normalizeMerchant.test.ts`:

```ts
test('normalizeMerchant strips mid-string numeric store IDs', () => {
  assert.equal(normalizeMerchant("MCDONALD'S #12164 GUELPH"), "MCDONALD'S");
  assert.equal(normalizeMerchant('STARBUCKS 04747 GUELPH'), 'STARBUCKS');
  assert.equal(normalizeMerchant('PETRO-CANADA 10585 GUELPH'), 'PETRO-CANADA');
  assert.equal(normalizeMerchant('WALMART 3144 3144 GUELPH'), 'WALMART');
  assert.equal(normalizeMerchant('DOMINOS PIZZA 10263 GUELPH'), 'DOMINOS PIZZA');
});

test('normalizeMerchant strips mid-string alphanumeric store IDs', () => {
  assert.equal(normalizeMerchant('SHELL C12587 GUELPH'), 'SHELL');
  assert.equal(normalizeMerchant('COSTCO GAS W1168'), 'COSTCO GAS');
});

test('normalizeMerchant does not strip short leading numbers or single-digit store nums', () => {
  // 500 is part of the merchant name (sports box seat), don't drop
  assert.equal(normalizeMerchant('500 LOGE CLUB TORONTO'), '500 LOGE CLUB');
  // Single-digit isn't a store ID
  assert.equal(normalizeMerchant('ZEHRS GUELPH CLAIR # 5'), 'ZEHRS GUELPH CLAIR');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: FAIL on each new assertion (mismatched strings — the new transforms aren't implemented yet).

- [ ] **Step 3: Implement mid-string store stripping**

In `backend/src/import/normalizeMerchant.ts`, add these constants after the existing `TRAILING_*` regexes (around line 14):

```ts
// Numeric or alphanumeric store-id token surrounded by spaces with content after,
// e.g. "#12164" in "MCDONALD'S #12164 GUELPH", "C12587" in "SHELL C12587 GUELPH".
// Requires content after (positive lookahead) so we don't strip true trailing IDs
// (those are handled by TRAILING_STORE_NUMBER).
const MID_STORE_NUMBER = /\s+(?:#\s*\d{2,}|\d{3,}|[A-Z]\d{4,})(?=\s+\S)/g;
```

Then in `normalizeMerchant` (around line 90, just before the existing `while (prev !== s)` loop), add:

```ts
  s = s.replace(MID_STORE_NUMBER, '').replace(/\s+/g, ' ').trim();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: PASS. Also: no existing tests regress.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/normalizeMerchant.ts backend/test/normalizeMerchant.test.ts
git commit -m "feat(import): strip mid-string store IDs in normalizeMerchant"
```

---

### Task 2: Duplicate trailing-city collapse in `normalizeMerchant`

Handles `FARM BOY #36 GUELPH GUELPH`, `A&W #4769 TORONTO TORONTO`, `LCBO/RAO #0706 GUELPH GUELPH`, `BEERTOWN GUELPH GUELPH`.

**Files:**
- Modify: `backend/src/import/normalizeMerchant.ts`
- Test: `backend/test/normalizeMerchant.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/normalizeMerchant.test.ts`:

```ts
test('normalizeMerchant collapses duplicate trailing city tokens', () => {
  assert.equal(normalizeMerchant('FARM BOY GUELPH GUELPH'), 'FARM BOY');
  assert.equal(normalizeMerchant("A&W TORONTO TORONTO"), 'A&W');
  assert.equal(normalizeMerchant('BEERTOWN GUELPH GUELPH'), 'BEERTOWN');
});

test('normalizeMerchant does not collapse non-duplicate tails', () => {
  assert.equal(normalizeMerchant('REN PETS GUELPH'), 'REN PETS GUELPH');
  assert.equal(normalizeMerchant('FOO BAR BAZ'), 'FOO BAR BAZ');
});

test('normalizeMerchant duplicate-tail collapse is case-insensitive', () => {
  assert.equal(normalizeMerchant('SLAP BURGERS Guelph guelph'), 'SLAP BURGERS Guelph');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement duplicate-tail collapse**

In `backend/src/import/normalizeMerchant.ts`, add helper after `stripCityStateTail`:

```ts
function collapseDuplicateTailWord(s: string): string {
  const words = s.split(' ');
  if (
    words.length >= 2 &&
    words[words.length - 1].toLowerCase() === words[words.length - 2].toLowerCase()
  ) {
    words.pop();
    return words.join(' ');
  }
  return s;
}
```

Then inside the existing `while (prev !== s)` loop in `normalizeMerchant`, add `collapseDuplicateTailWord` so the loop becomes:

```ts
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(TRAILING_STORE_NUMBER, '').trim();
    s = collapseDuplicateTailWord(s);
    s = stripCityStateTail(s);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: PASS. No regressions on existing tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/normalizeMerchant.ts backend/test/normalizeMerchant.test.ts
git commit -m "feat(import): collapse duplicate trailing city in normalizeMerchant"
```

---

### Task 3: Additional processor prefixes in `normalizeMerchant`

Adds Instacart's `IC*`, Cantaloupe vending's `CTLP*`, `INTUIT *`, and `PADDLE.NET*` prefixes.

**Files:**
- Modify: `backend/src/import/normalizeMerchant.ts`
- Test: `backend/test/normalizeMerchant.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/normalizeMerchant.test.ts`:

```ts
test('normalizeMerchant strips IC* (Instacart) prefix', () => {
  assert.equal(normalizeMerchant('IC* INSTACART*SUBSCRIP HALIFAX'), 'INSTACART*SUBSCRIP');
});

test('normalizeMerchant strips CTLP* prefix', () => {
  assert.equal(normalizeMerchant('CTLP*CS VENDING SOLUTI'), 'CS VENDING SOLUTI');
});

test('normalizeMerchant strips INTUIT * prefix', () => {
  assert.equal(normalizeMerchant('INTUIT *QBOOKS ONLINE'), 'QBOOKS ONLINE');
});

test('normalizeMerchant strips PADDLE.NET* prefix', () => {
  assert.equal(normalizeMerchant('PADDLE.NET* MTW LONDON'), 'MTW');
  assert.equal(normalizeMerchant('PADDLE.NET* BTTRDISPLY LONDON'), 'BTTRDISPLY');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement additional prefixes**

In `backend/src/import/normalizeMerchant.ts`, extend `PROCESSOR_PREFIXES` (the array at the top) with these entries:

```ts
  /^IC\s*\*\s*/i,
  /^CTLP\s*\*\s*/i,
  /^INTUIT\s*\*\s*/i,
  /^PADDLE\.NET\s*\*\s*/i,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/normalizeMerchant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/normalizeMerchant.ts backend/test/normalizeMerchant.test.ts
git commit -m "feat(import): add IC*, CTLP*, INTUIT *, PADDLE.NET* prefix strippers"
```

---

### Task 4: Fix DoorDash word-boundary in `brandDictionary`

Current pattern `\b(doordash|dd\s*\*doordash)\b` doesn't match `DOORDASHTHESAFFRONI` because there's no word boundary after `DOORDASH`. Drop the trailing `\b`.

**Files:**
- Modify: `backend/src/import/enrichment/brandDictionary.ts:14`
- Test: `backend/test/brandDictionary.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/brandDictionary.test.ts`:

```ts
test('lookupSeedBrand matches DoorDash on glued restaurant suffixes', () => {
  assert.equal(lookupSeedBrand('DOORDASHTHESAFFRONI DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHBARBURRITO DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHMCDONALDS DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHPOPEYESLOUI'), 'DoorDash');
});

test('lookupSeedBrand still matches plain DoorDash', () => {
  assert.equal(lookupSeedBrand('DOORDASH'), 'DoorDash');
  assert.equal(lookupSeedBrand('DD *DOORDASH'), 'DoorDash');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx tsx --test test/brandDictionary.test.ts`
Expected: FAIL — glued-prefix assertions return `null`.

- [ ] **Step 3: Fix the pattern**

In `backend/src/import/enrichment/brandDictionary.ts`, change line 14 from:

```ts
  { pattern: /\b(doordash|dd\s*\*doordash)\b/i, canonical: 'DoorDash' },
```

to (drop the trailing `\b`):

```ts
  { pattern: /\b(doordash|dd\s*\*doordash)/i, canonical: 'DoorDash' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/brandDictionary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/brandDictionary.ts backend/test/brandDictionary.test.ts
git commit -m "fix(brand-dict): match DoorDash on glued restaurant prefixes"
```

---

### Task 5: Add new brand entries to `brandDictionary`

Expands the seed dict with ~25 brands seen in the user's real data.

**Files:**
- Modify: `backend/src/import/enrichment/brandDictionary.ts`
- Test: `backend/test/brandDictionary.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/brandDictionary.test.ts`:

```ts
test('lookupSeedBrand handles new restaurant brands', () => {
  assert.equal(lookupSeedBrand('BURGER KING'), 'Burger King');
  assert.equal(lookupSeedBrand('BURGER KING #24238 PUSLINCH'), 'Burger King');
  assert.equal(lookupSeedBrand('WENDYS'), "Wendy's");
  assert.equal(lookupSeedBrand("MCDONALD'S"), "McDonald's");
  assert.equal(lookupSeedBrand('A&W'), 'A&W');
  assert.equal(lookupSeedBrand('A & W'), 'A&W');
  assert.equal(lookupSeedBrand('POPEYES #13383'), 'Popeyes');
  assert.equal(lookupSeedBrand('TACO BELL'), 'Taco Bell');
  assert.equal(lookupSeedBrand('KFC'), 'KFC');
  assert.equal(lookupSeedBrand('KFC/TB STONE RD'), 'KFC/Taco Bell (combo)');
  assert.equal(lookupSeedBrand('BOOSTER JUICE'), 'Booster Juice');
  assert.equal(lookupSeedBrand('PIZZA PIZZA'), 'Pizza Pizza');
  assert.equal(lookupSeedBrand('PIZZAVILLE'), 'Pizzaville');
});

test('lookupSeedBrand handles new retail brands', () => {
  assert.equal(lookupSeedBrand('DOLLARAMA'), 'Dollarama');
  assert.equal(lookupSeedBrand('SHOPPERS DRUG MART'), 'Shoppers Drug Mart');
  assert.equal(lookupSeedBrand('THE HOME DEPOT'), 'Home Depot');
  assert.equal(lookupSeedBrand('MARSHALLS'), 'Marshalls');
  assert.equal(lookupSeedBrand('WINNERS'), 'Winners');
});

test('lookupSeedBrand handles new grocery/liquor brands', () => {
  assert.equal(lookupSeedBrand('FARM BOY'), 'Farm Boy');
  assert.equal(lookupSeedBrand('FOOD BASICS'), 'Food Basics');
  assert.equal(lookupSeedBrand('ZEHRS'), 'Zehrs');
  assert.equal(lookupSeedBrand('THE BEER STORE'), 'Beer Store');
  assert.equal(lookupSeedBrand('LCBO'), 'LCBO');
  assert.equal(lookupSeedBrand('RCSS'), 'Real Canadian Superstore');
});

test('lookupSeedBrand handles new tech/subscription brands', () => {
  assert.equal(lookupSeedBrand('CURSOR'), 'Cursor');
  assert.equal(lookupSeedBrand('XAI LLC'), 'xAI');
  assert.equal(lookupSeedBrand('GROK XAI'), 'xAI');
  assert.equal(lookupSeedBrand('CLOUDFLARE'), 'Cloudflare');
  assert.equal(lookupSeedBrand('DISCORD'), 'Discord');
  assert.equal(lookupSeedBrand('DISCORD* NITROMONTHLY'), 'Discord');
  assert.equal(lookupSeedBrand('TWITCH'), 'Twitch');
  assert.equal(lookupSeedBrand('HOLAFLY'), 'Holafly');
  assert.equal(lookupSeedBrand('AIRALO'), 'Airalo');
  assert.equal(lookupSeedBrand('INSTACART'), 'Instacart');
  assert.equal(lookupSeedBrand('INTUIT QBOOKS'), 'Intuit');
  assert.equal(lookupSeedBrand('PADDLE.NET'), 'Paddle');
  assert.equal(lookupSeedBrand('FEDEX'), 'FedEx');
  assert.equal(lookupSeedBrand('UPS'), 'UPS');
  assert.equal(lookupSeedBrand('UPS*'), 'UPS');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx tsx --test test/brandDictionary.test.ts`
Expected: FAIL — all return null.

- [ ] **Step 3: Add the new brand entries**

In `backend/src/import/enrichment/brandDictionary.ts`, append to `SEED_BRANDS` (before the closing `];`). Note: `kfc/tb` must come BEFORE the standalone `kfc` and `taco bell` patterns so the combined form wins:

```ts
  { pattern: /\b(kfc\/tb)\b/i, canonical: 'KFC/Taco Bell (combo)' },
  { pattern: /\b(taco\s*bell)\b/i, canonical: 'Taco Bell' },
  { pattern: /\b(kfc)\b/i, canonical: 'KFC' },
  { pattern: /\b(burger\s*king|bk\s*#?\d*)\b/i, canonical: 'Burger King' },
  { pattern: /\b(wendys|wendy's)\b/i, canonical: "Wendy's" },
  { pattern: /\b(popeyes)/i, canonical: 'Popeyes' },
  { pattern: /\b(a\s*&\s*w|a&w)\b/i, canonical: 'A&W' },
  { pattern: /\b(pizza\s*pizza)\b/i, canonical: 'Pizza Pizza' },
  { pattern: /\b(pizzaville)\b/i, canonical: 'Pizzaville' },
  { pattern: /\b(booster\s*juice)\b/i, canonical: 'Booster Juice' },
  { pattern: /\b(dollarama)\b/i, canonical: 'Dollarama' },
  { pattern: /\b(shoppers\s*drug\s*mart|shoppers\s*dm)\b/i, canonical: 'Shoppers Drug Mart' },
  { pattern: /\b(home\s*depot)\b/i, canonical: 'Home Depot' },
  { pattern: /\b(marshalls)\b/i, canonical: 'Marshalls' },
  { pattern: /\b(winners)\b/i, canonical: 'Winners' },
  { pattern: /\b(farm\s*boy)\b/i, canonical: 'Farm Boy' },
  { pattern: /\b(food\s*basics)\b/i, canonical: 'Food Basics' },
  { pattern: /\b(zehrs)\b/i, canonical: 'Zehrs' },
  { pattern: /\b(the\s*beer\s*store|beer\s*store)\b/i, canonical: 'Beer Store' },
  { pattern: /\b(lcbo)\b/i, canonical: 'LCBO' },
  { pattern: /\b(real\s*canadian\s*superstore|rcss)\b/i, canonical: 'Real Canadian Superstore' },
  { pattern: /\b(cursor)\b/i, canonical: 'Cursor' },
  { pattern: /\b(xai|grok|x\.ai)\b/i, canonical: 'xAI' },
  { pattern: /\b(cloudflare)\b/i, canonical: 'Cloudflare' },
  { pattern: /\b(discord)/i, canonical: 'Discord' },
  { pattern: /\b(twitch)\b/i, canonical: 'Twitch' },
  { pattern: /\b(holafly)\b/i, canonical: 'Holafly' },
  { pattern: /\b(airalo)\b/i, canonical: 'Airalo' },
  { pattern: /\b(instacart|ic\s*\*\s*instacart)/i, canonical: 'Instacart' },
  { pattern: /\b(intuit|qbooks|quickbooks)\b/i, canonical: 'Intuit' },
  { pattern: /\b(paddle\.net|paddle)/i, canonical: 'Paddle' },
  { pattern: /\b(fedex)/i, canonical: 'FedEx' },
  { pattern: /\b(ups\s*\*|\bups\b)/i, canonical: 'UPS' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/brandDictionary.test.ts`
Expected: PASS. Also run the entire test suite to check nothing regresses: `cd backend && yarn test`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/brandDictionary.ts backend/test/brandDictionary.test.ts
git commit -m "feat(brand-dict): add ~30 brand entries for restaurants, retail, tech subs"
```

---

### Task 6: Create `wsInvestmentBrandStage`

A new enrichment stage that recognizes Wealthsimple investment-transaction strings and rolls them up to `{TICKER} — {Action}` or simple action labels.

**Files:**
- Create: `backend/src/import/enrichment/wsInvestmentBrandStage.ts`
- Create: `backend/test/wsInvestmentBrandStage.test.ts`
- Modify: `backend/src/import/enrichment/types.ts` (add `ws-investment` to `SignalSource`)

- [ ] **Step 1: Extend the SignalSource union**

In `backend/src/import/enrichment/types.ts`, change the `SignalSource` type (lines 8-18) to include `'ws-investment'`:

```ts
export type SignalSource =
  | 'normalize-seed'
  | 'normalize-learned'
  | 'ws-investment'
  | 'type-detect'
  | 'recurring'
  | 'rule'
  | 'memory'
  | 'item-link'
  | 'refund-link'
  | 'transfer-link'
  | 'ai';
```

- [ ] **Step 2: Write the failing tests**

Create `backend/test/wsInvestmentBrandStage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWsInvestmentBrandStage } from '../src/import/enrichment/wsInvestmentBrandStage';

function canonicalOf(raw: string): string | null {
  const signals = runWsInvestmentBrandStage({ merchantRaw: raw });
  if (signals.length === 0) return null;
  const c = signals[0].fields.merchantCanonical;
  return c ?? null;
}

test('ws-investment: ticker buy', () => {
  assert.equal(
    canonicalOf('XEQT - iShares Core Equity ETF Portfolio: Bought 0.3921 shares at $40.78 per share (executed at 2026-01-06)'),
    'XEQT — Buy',
  );
  assert.equal(
    canonicalOf('VFV - Vanguard S&P 500 Index ETF: Bought 14.7110 shares (executed at 2025-11-06)'),
    'VFV — Buy',
  );
});

test('ws-investment: ticker sell', () => {
  assert.equal(
    canonicalOf('NFLD - Exploits Discovery Corp: Sold 1500.0000 shares (executed at 2025-08-19)'),
    'NFLD — Sell',
  );
});

test('ws-investment: dividend', () => {
  assert.equal(
    canonicalOf('VFV - Vanguard S&P 500 Index ETF: Cash dividend distribution, received on 2025-10-07, record date of'),
    'VFV — Dividend',
  );
  assert.equal(
    canonicalOf('DOO - BRP Inc: Cash dividend distribution, received on 2025-10-14, record date of'),
    'DOO — Dividend',
  );
});

test('ws-investment: shares on loan / loan terminated', () => {
  assert.equal(
    canonicalOf('XEQT - iShares Core Equity ETF Portfolio: 2.0000 Shares on loan (executed at 2025-09-03)'),
    'XEQT — Loan out',
  );
  assert.equal(
    canonicalOf('PLUR - Plurilock Security Inc.: Loan of 3.0000 shares terminated (executed at 2025-03-03)'),
    'PLUR — Loan terminated',
  );
});

test('ws-investment: ticker transfer in', () => {
  assert.equal(
    canonicalOf('ETH - Ethereum: Transfer of 0.0036 ETH into the account (executed at 2024-10-01), FX Rate: 1.3488'),
    'ETH — Transfer in',
  );
});

test('ws-investment: crypto rewards', () => {
  assert.equal(canonicalOf('0.0020786267 of DOT rewards earned'), 'DOT — Stake reward');
  assert.equal(canonicalOf('0.0000714937 of ETH rewards earned'), 'ETH — Stake reward');
});

test('ws-investment: staked', () => {
  assert.equal(canonicalOf('Staked 0.0208474700 of ETH-Ethereum'), 'ETH — Stake');
  assert.equal(canonicalOf('Staked 4.9018380000 of DOT-Polkadot'), 'DOT — Stake');
});

test('ws-investment: crypto purchase/sale/fee', () => {
  assert.equal(
    canonicalOf('Purchase of 500000.0000000000 PEPE (executed at 2025-01-07), FX Rate: 1.4401, Fee charged $0.27'),
    'PEPE — Buy',
  );
  assert.equal(
    canonicalOf('Sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552'),
    'XRP — Sell',
  );
  assert.equal(
    canonicalOf('Trading fee for sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552'),
    'XRP — Trading fee',
  );
  assert.equal(
    canonicalOf('Fee paid on DOT-Polkadot staking reward:'),
    'DOT — Stake fee',
  );
});

test('ws-investment: cash account flow lines', () => {
  assert.equal(
    canonicalOf('Money transfer into the account (executed at 2024-12-13)'),
    'Money transfer in',
  );
  assert.equal(
    canonicalOf('Money transfer out of the account (executed at 2025-08-05)'),
    'Money transfer out',
  );
  assert.equal(
    canonicalOf('Tax-free money transfer into the account (executed at 2025-08-18)'),
    'Money transfer in',
  );
  assert.equal(
    canonicalOf('Contribution (executed at 2025-11-02)'),
    'Contribution',
  );
  assert.equal(
    canonicalOf('Subscription fee paid for period 2025-10-07 to'),
    'WS Premium fee',
  );
  assert.equal(
    canonicalOf('Stock lending monthly interest payment'),
    'Stock lending interest',
  );
  assert.equal(
    canonicalOf('Interest received (executed at 2025-09-01)'),
    'Interest received',
  );
});

test('ws-investment: returns no signal for ordinary merchant strings', () => {
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'STARBUCKS' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'AMZN MKTP CA*B57UC85N2' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: 'DOORDASHTHESAFFRONI' }).length, 0);
  assert.equal(runWsInvestmentBrandStage({ merchantRaw: '' }).length, 0);
});

test('ws-investment: signal source and confidence', () => {
  const signals = runWsInvestmentBrandStage({
    merchantRaw: 'Contribution (executed at 2025-11-02)',
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'ws-investment');
  assert.equal(signals[0].confidence, 'high');
});
```

- [ ] **Step 3: Run the test file to verify failure**

Run: `cd backend && npx tsx --test test/wsInvestmentBrandStage.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the stage**

Create `backend/src/import/enrichment/wsInvestmentBrandStage.ts`:

```ts
import type { Signal } from './types';

export interface WsInvestmentBrandStageInput {
  merchantRaw: string;
}

interface Rule {
  pattern: RegExp;
  /** Build the canonical from regex match groups. Return null to skip. */
  toCanonical: (m: RegExpMatchArray) => string;
}

// Ordered: first match wins. More specific patterns first.
const RULES: Rule[] = [
  // Crypto rewards: "0.001... of DOT rewards earned"
  {
    pattern: /^[\d.]+\s+of\s+([A-Z]{2,5})\s+rewards earned/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake reward`,
  },
  // Staked: "Staked 0.020... of ETH-Ethereum"
  {
    pattern: /^Staked\s+[\d.]+\s+of\s+([A-Z]{2,5})-/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake`,
  },
  // Fee paid on staking: "Fee paid on DOT-Polkadot staking reward:"
  {
    pattern: /^Fee paid on\s+([A-Z]{2,5})-.*staking reward/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake fee`,
  },
  // Crypto trading fee: "Trading fee for sale of N XRP ..."
  {
    pattern: /^Trading fee for\s+(?:sale|purchase) of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Trading fee`,
  },
  // Crypto buy: "Purchase of 500000.0 PEPE (executed at ...)"
  {
    pattern: /^Purchase of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Buy`,
  },
  // Crypto sell: "Sale of 4.0 XRP (executed at ...)"
  {
    pattern: /^Sale of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Sell`,
  },
  // Ticker dividend: "XEQT - iShares ...: Cash dividend distribution, received on ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*Cash dividend distribution/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Dividend`,
  },
  // Ticker buy with optional price: "XEQT - iShares ...: Bought 0.3921 shares ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*Bought\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Buy`,
  },
  // Ticker sell: "NFLD - Exploits ...: Sold 1500.0 shares ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*Sold\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Sell`,
  },
  // Loan out: "PLUR - Plurilock ...: 2.0 Shares on loan ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*[\d.]+\s+Shares on loan/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Loan out`,
  },
  // Loan terminated: "PLUR - Plurilock ...: Loan of 3.0 shares terminated ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*Loan of\s+[\d.]+\s+shares terminated/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Loan terminated`,
  },
  // Ticker transfer in: "ETH - Ethereum: Transfer of 0.0036 ETH into the account ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s*-\s*.+?:\s*Transfer of\s+.+\s+into the account/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Transfer in`,
  },

  // Cash account flow lines (no ticker)
  {
    pattern: /^(?:Tax-free\s+)?Money transfer into the account/i,
    toCanonical: () => 'Money transfer in',
  },
  {
    pattern: /^(?:Tax-free\s+)?Money transfer out of the account/i,
    toCanonical: () => 'Money transfer out',
  },
  {
    pattern: /^Contribution\s*\(executed at\b/i,
    toCanonical: () => 'Contribution',
  },
  {
    pattern: /^Subscription fee paid for period/i,
    toCanonical: () => 'WS Premium fee',
  },
  {
    pattern: /^Stock lending monthly interest payment/i,
    toCanonical: () => 'Stock lending interest',
  },
  {
    pattern: /^Interest received\b/i,
    toCanonical: () => 'Interest received',
  },
];

export function runWsInvestmentBrandStage(input: WsInvestmentBrandStageInput): Signal[] {
  const raw = input.merchantRaw?.trim() ?? '';
  if (!raw) return [];

  for (const rule of RULES) {
    const m = raw.match(rule.pattern);
    if (m) {
      return [
        {
          source: 'ws-investment',
          confidence: 'high',
          fields: { merchantCanonical: rule.toCanonical(m) },
        },
      ];
    }
  }
  return [];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/wsInvestmentBrandStage.test.ts`
Expected: PASS for all assertions.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/enrichment/types.ts backend/src/import/enrichment/wsInvestmentBrandStage.ts backend/test/wsInvestmentBrandStage.test.ts
git commit -m "feat(enrich): add wsInvestmentBrandStage for Wealthsimple txn rollup"
```

---

### Task 7: Wire `wsInvestmentBrandStage` into the pipeline

Inserts the new stage before `normalize` in `enrich.ts`. When the WS stage produces a canonical, skip `normalizeStage`'s canonical lookup entirely (its brand-dict patterns could incidentally match ticker symbols like `TD`).

**Files:**
- Modify: `backend/src/import/enrich.ts`
- Test: `backend/test/enrichPipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/enrichPipeline.test.ts`:

```ts
test('enrichTransaction labels WS investment txn via ws-investment stage', async () => {
  const result = await enrichTransaction({
    raw: {
      merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.3921 shares at $40.78 per share (executed at 2026-01-06)',
      amount: 0,
      date: '2026-01-06',
      notes: null,
      sourceReference: null,
    },
    rules: [],
    memory: null,
    recurringHistory: [],
    amazonOrders: [],
    relationshipCandidates: [],
    accountId: 1,
    householdAccountIds: [1],
  } as any); // existing tests in this file already use `as any` for partial inputs

  assert.equal(result.fields.merchantCanonical, 'XEQT — Buy');
  assert.equal(result.fields.autoSource, 'ws-investment');
});

test('enrichTransaction labels regular merchant via normalize-seed (not WS stage)', async () => {
  const result = await enrichTransaction({
    raw: {
      merchantRaw: 'STARBUCKS 04747 GUELPH',
      amount: 5.25,
      date: '2026-01-06',
      notes: null,
      sourceReference: null,
    },
    rules: [],
    memory: null,
    recurringHistory: [],
    amazonOrders: [],
    relationshipCandidates: [],
    accountId: 1,
    householdAccountIds: [1],
  } as any);

  assert.equal(result.fields.merchantCanonical, 'Starbucks');
});
```

Note: if the existing `enrichPipeline.test.ts` doesn't already import `enrichTransaction`, read the file first and follow its existing import pattern.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx tsx --test test/enrichPipeline.test.ts`
Expected: FAIL on `XEQT — Buy` — currently returns null or some unrelated canonical.

- [ ] **Step 3: Wire in the stage**

In `backend/src/import/enrich.ts`:

First, add the import near the top (with the other stage imports):

```ts
import { runWsInvestmentBrandStage } from './enrichment/wsInvestmentBrandStage';
```

Then in `enrichTransaction` (around line 63), replace the existing "Stage 1: normalize" block:

```ts
  // Stage 0: ws-investment (early canonical for Wealthsimple txns)
  const wsSignals = safeStage('ws-investment', () => runWsInvestmentBrandStage({
    merchantRaw: input.raw.merchantRaw,
  }), []);
  signals.push(...wsSignals);
  const wsHit = wsSignals.some((sig) => sig.fields.merchantCanonical != null);

  // Stage 1: normalize (skipped if ws-investment claimed the canonical)
  if (!wsHit) {
    signals.push(...safeStage('normalize', () => runNormalizeStage({
      merchantRaw: input.raw.merchantRaw,
      learnedLookup: input.learnedBrandLookup,
    }), []));
  } else {
    // Still need merchantClean for downstream stages — derive it without canonical lookup
    signals.push({
      source: 'normalize-seed',
      confidence: 'high',
      fields: { merchantClean: normalizeMerchantClean(input.raw.merchantRaw) },
    });
  }
```

And at the top of `enrich.ts`, add the import for `normalizeMerchant` (if not already present) and alias it for readability:

```ts
import { normalizeMerchant as normalizeMerchantClean } from './normalizeMerchant';
```

(Or use whatever import name is already in the file — read the file first to confirm.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/enrichPipeline.test.ts`
Expected: PASS. Run the full suite to check nothing regresses: `cd backend && yarn test`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrich.ts backend/test/enrichPipeline.test.ts
git commit -m "feat(enrich): run wsInvestmentBrandStage before normalize, skip on hit"
```

---

### Task 8: Flip dashboard merchant grouping to prefer canonical

The single highest-leverage change: makes the existing `merchant_canonical` work visible in the user's main merchant view.

**Files:**
- Modify: `backend/src/routes/summary.ts:230`
- Test: `backend/test/` (find a dashboard summary test if one exists, else accept manual verification per the test plan below)

- [ ] **Step 1: Locate and read the dashboard route**

Read `backend/src/routes/summary.ts` lines 200-260 to see the exact context. Locate the line:

```ts
const merchant = row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
```

- [ ] **Step 2: Write a regression test (if a test file already exists)**

Run: `find backend/test -name '*summary*' -o -name '*dashboard*' 2>/dev/null`

- If a test file exists, append a test that seeds two transactions where `merchantCanonical = 'Amazon'` but `merchantClean` differs (`AMZN MKTP CA` vs `AMAZON.CA`), hits `/api/summary/dashboard`, and asserts they collapse to a single `Amazon` entry in `merchantSummaries`.
- If no test file exists, skip this step and rely on manual verification in Step 5.

- [ ] **Step 3: Edit the grouping key**

In `backend/src/routes/summary.ts`, change the line (around 230):

```ts
const merchant = row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
```

to:

```ts
const merchant = row.merchantCanonical?.trim() || row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
```

- [ ] **Step 4: Verify type access**

The SQL/Sequelize row in scope must actually return `merchantCanonical`. Read the SELECT/attribute list a few lines above the changed line to confirm `merchant_canonical` is included. If it's not, add `'merchantCanonical'` to the attributes list (column already exists on the Transaction model; see `backend/src/models/Transaction.ts`).

- [ ] **Step 5: Run tests + manual smoke**

Run: `cd backend && yarn test`
Expected: PASS.

Manual: start dev backend (`yarn workspace backend dev`) and hit `GET /api/summary/dashboard` against your local DB. Eyeball the `merchantSummaries` array — Amazon variants should now appear as a single row.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/summary.ts backend/test/summary.test.ts  # if a test was added
git commit -m "fix(dashboard): group merchant summary by canonical when present"
```

---

### Task 9: Re-run enrichment backfill via the existing Settings UI

After Tasks 1-8 land, existing transactions still have the OLD `merchantClean` and possibly null `merchantCanonical`. The Settings page **already has a UI** for this: an "Enrichment maintenance" section that calls `POST /api/transactions/enrichment/backfill` with NDJSON streaming progress.

**Files:**
- No code changes. UI: `frontend/src/pages/SettingsPage.tsx:1425-1552`. Endpoint: `backend/src/routes/transactions.ts:784-886`.

- [ ] **Step 1: Open Settings → Enrichment maintenance**

In the running app, navigate to Settings. Find the "Enrichment maintenance" section.

- [ ] **Step 2: Dry run**

Click **Dry run**. The button streams per-row events (`{kind: "progress", merchantRaw, merchantClean, merchantCanonical, ...}`) followed by a summary (`{kind: "summary", processed, updated, ...}`). Eyeball the diff sample for sanity:
- Are Amazon variants collapsing to `Amazon`?
- Are DOORDASH* glued forms collapsing to `DoorDash`?
- Are WS investment txns picking up `XEQT — Buy`, `DOT — Stake reward`, `Money transfer in`?

- [ ] **Step 3: Run backfill**

If dry-run looks right, click **Run backfill**. Same stream + summary; this one writes.

The endpoint guards against concurrent runs (returns 409 if a backfill is already in flight for the household).

- [ ] **Step 4: Verify dashboard**

Open the Dashboard merchant view. Expected reductions:
- `AMZN MKTP CA*XXXX`, `AMAZON.CA*XXXX`, `AMZN MKTP CA` → one `Amazon` row
- `DOORDASHTHESAFFRONI`, `DOORDASHBARBURRITO`, `DOORDASHMCDONALDS`, `DOORDASHPOPEYESLOUI`, `DOORDASHMUCHOBURRIT` → one `DoorDash` row
- `STARBUCKS`, `STARBUCKS 04747 GUELPH` → one `Starbucks` row
- All `XEQT - iShares ...: Bought N shares` lines → one `XEQT — Buy` row
- All `0.XXX of DOT rewards earned` lines → one `DOT — Stake reward` row
- `Money transfer into the account (executed at ...)` (many dates) → one `Money transfer in` row

- [ ] **Step 5: No commit needed**

Backfill writes to the DB, not to the repo.

---

## Self-Review Notes

- **Spec coverage:** All five components from the spec map to tasks: dashboard grouping (Task 8), normalizeMerchant extensions (Tasks 1-3), brandDictionary extensions (Tasks 4-5), wsInvestmentBrandStage (Tasks 6-7), backfill (Task 9). ✅
- **Type consistency:** `runWsInvestmentBrandStage` signature used identically in test (Task 6) and `enrich.ts` (Task 7). Signal source `'ws-investment'` added to type union (Task 6, Step 1) and used in stage impl (Task 6, Step 4) and check in pipeline (Task 7, Step 3). ✅
- **No placeholders:** every code step contains the actual code; every command is exact. ✅
- **Risk noted in spec but not in plan:** the false-positive risk in mid-string store stripping is covered by Task 1's negative-case tests (500 LOGE CLUB, single-digit). ✅

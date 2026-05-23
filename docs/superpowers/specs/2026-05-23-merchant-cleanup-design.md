# Merchant Cleanup — Design

## Context & Root Cause

The DashboardPage merchant summary shows hundreds of near-duplicate merchants because the report at `backend/src/routes/summary.ts:230` groups by `merchantClean || merchantRaw`, **not** `merchantCanonical`. The existing seed dict (`backend/src/import/enrichment/brandDictionary.ts`) already canonicalizes Starbucks/McDonald's/Amazon/etc., but that work is invisible to the user's primary view. Wealthsimple Cash/Activity CSV rows additionally pollute the view with per-trade strings carrying unique amounts/dates/FX rates (`XEQT - iShares Core Equity ETF Portfolio: Bought 0.3921 shares (executed at 2026-01-06)`), and the existing normalizer doesn't touch them.

## Scope

In scope:
- Make the dashboard report consume `merchantCanonical`.
- Extend `normalizeMerchant.ts` to strip patterns the current logic misses (mid-string store numbers, duplicate trailing city, more subprocessor prefixes).
- Extend `brandDictionary.ts` with editorial brand aliases (incl. the DoorDash word-boundary fix).
- New enrichment stage to normalize Wealthsimple investment txns to `{TICKER} — {Action}` form.
- One-off backfill via existing `runEnrichmentBackfill`.

Out of scope:
- Manual merge UI in the app (explicitly ruled out).
- DB-backed alias table.
- Changes to `merchantMemoryStage` or rule engine.

## Components

### 1. Dashboard report grouping (`backend/src/routes/summary.ts:230`)

Single-line change:
```ts
// before
const merchant = row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
// after
const merchant = row.merchantCanonical?.trim() || row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
```

Effect: every transaction with a non-null canonical (existing + newly-backfilled) collapses to one row. Rows without canonical still fall back to clean/raw — no regression on un-canonicalized data.

### 2. `normalizeMerchant.ts` extensions

Three new transformations, added to the existing pipeline in `backend/src/import/normalizeMerchant.ts`:

**2a. Mid-string store-number stripping.** Generalize the existing `TRAILING_STORE_NUMBER` regex to also fire when the store number is sandwiched between merchant words and city/state words. Pattern: a token matching `#?\d{2,}` or `[A-Z]\d{4,}` (e.g., `C12587`) that sits AFTER the first merchant word and BEFORE what looks like a city token. Targets:
- `MCDONALD'S #12164 GUELPH`
- `STARBUCKS 04747 GUELPH`
- `PETRO-CANADA 10585 GUELPH`
- `WALMART 3144 3144 GUELPH`
- `SHELL C12587 GUELPH`
- `DOMINOS PIZZA 10263 GUELPH`
- `JYSK 062 GUELPH GUELPH`
- `MARSHALLS 750 GUELPH`
- `WENDYS 6302 GUELPH`
- `Centurion Coffee 213639 GUELPH`

**2b. Duplicate trailing city.** Add a final pass: if the last two whitespace-separated tokens are equal (case-insensitive), drop the last one. Targets:
- `FARM BOY #36 GUELPH GUELPH`
- `A&W #4769 TORONTO TORONTO`
- `LCBO/RAO #0706 GUELPH GUELPH`
- `JYSK 062 GUELPH GUELPH`
- `BEERTOWN GUELPH GUELPH`

Order with the existing `stripCityStateTail` loop matters: dedupe runs BEFORE the loop, so subsequent state-tail logic sees a clean city.

**2c. Additional processor prefixes.** Append to `PROCESSOR_PREFIXES`:
- `/^IC\s*\*\s*/i` (Instacart)
- `/^CTLP\s*\*\s*/i` (Cantaloupe vending)
- `/^INTUIT\s*\*\s*/i`
- `/^PADDLE\.NET\s*\*\s*/i`
- `/^SH\s+VENDING/i` (will need a special tail-strip for the appended phone)

### 3. `brandDictionary.ts` extensions

**3a. Word-boundary fix on glued prefixes.** Current `\b(doordash|dd\s*\*doordash)\b` does NOT match `DOORDASHTHESAFFRONI` because there's no word boundary after `DOORDASH`. Change to `\b(doordash|dd\s*\*doordash)` (drop trailing `\b`). Same fix audit needed for:
- DoorDash (confirmed broken)
- Verify Uber/Amazon/Google patterns work on glued forms via test.

**3b. New brand entries.** Add to `SEED_BRANDS` array:
```ts
{ pattern: /\b(burger\s*king|bk\s*#?\d*)\b/i, canonical: 'Burger King' },
{ pattern: /\b(wendys|wendy's)\b/i, canonical: "Wendy's" },
{ pattern: /\b(dollarama)\b/i, canonical: 'Dollarama' },
{ pattern: /\b(shoppers\s*drug\s*mart|shoppers\s*dm)\b/i, canonical: 'Shoppers Drug Mart' },
{ pattern: /\b(pizza\s*pizza)\b/i, canonical: 'Pizza Pizza' },
{ pattern: /\b(pizzaville)\b/i, canonical: 'Pizzaville' },
{ pattern: /\b(a\s*&\s*w|a&w)\b/i, canonical: 'A&W' },
{ pattern: /\b(popeyes)/i, canonical: 'Popeyes' },
{ pattern: /\b(kfc\/tb)\b/i, canonical: 'KFC/Taco Bell (combo)' },
{ pattern: /\b(taco\s*bell)\b/i, canonical: 'Taco Bell' },
{ pattern: /\b(home\s*depot)\b/i, canonical: 'Home Depot' },
{ pattern: /\b(marshalls)\b/i, canonical: 'Marshalls' },
{ pattern: /\b(winners)\b/i, canonical: 'Winners' },
{ pattern: /\b(kfc)\b/i, canonical: 'KFC' },
{ pattern: /\b(booster\s*juice)\b/i, canonical: 'Booster Juice' },
{ pattern: /\b(the\s*beer\s*store|beer\s*store)\b/i, canonical: 'Beer Store' },
{ pattern: /\b(lcbo)\b/i, canonical: 'LCBO' },
{ pattern: /\b(zehrs)\b/i, canonical: 'Zehrs' },
{ pattern: /\b(farm\s*boy)\b/i, canonical: 'Farm Boy' },
{ pattern: /\b(food\s*basics)\b/i, canonical: 'Food Basics' },
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

### 4. WS investment normalizer

New file: `backend/src/import/enrichment/wsInvestmentBrandStage.ts`.

Exports `runWsInvestmentBrandStage({ merchantRaw }): Signal[]`. Tests `merchantRaw` against an ordered list of patterns; first match wins and returns a Signal setting `merchantCanonical` to `{TICKER} — {Action}`. Pattern set:

| Pattern (against raw) | Canonical |
|---|---|
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*Bought\b/i` | `{TICKER} — Buy` |
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*Sold\b/i` | `{TICKER} — Sell` |
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*Cash dividend distribution/i` | `{TICKER} — Dividend` |
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*(\d+\.\d+)\s*Shares on loan/i` | `{TICKER} — Loan out` |
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*Loan of \d+\.\d+ shares terminated/i` | `{TICKER} — Loan terminated` |
| `/^([A-Z][A-Z0-9]{1,5})\s*-\s*.+:\s*Transfer of .+ into the account/i` | `{TICKER} — Transfer in` |
| `/^([\d.]+) of ([A-Z]{2,5}) rewards earned/i` | `{TICKER} — Stake reward` |
| `/^Staked [\d.]+ of (\w+)-/i` | `{TICKER} — Stake` |
| `/^Purchase of [\d.]+\s+([A-Z]{3,5})\s/i` | `{TICKER} — Buy` |
| `/^Sale of [\d.]+\s+([A-Z]{3,5})\s/i` | `{TICKER} — Sell` |
| `/^Trading fee for (sale|purchase) of [\d.]+\s+([A-Z]{3,5})/i` | `{TICKER} — Trading fee` |
| `/^Fee paid on ([A-Z]{2,5})-.* staking reward/i` | `{TICKER} — Stake fee` |
| `/^(Tax-free\s+)?Money transfer (into|out of)/i` | `Money transfer in` / `Money transfer out` |
| `/^Contribution \(executed at /i` | `Contribution` |
| `/^Subscription fee paid for period/i` | `WS Premium fee` |
| `/^Stock lending monthly interest payment/i` | `Stock lending interest` |
| `/^Interest received \(executed at/i` | `Interest received` |

Wire-up in `backend/src/import/enrich.ts`: insert as a stage that runs **before** `runNormalizeStage`. If `wsInvestmentBrandStage` emits a signal that includes `merchantCanonical`, skip `runNormalizeStage` entirely for that row (early return) — don't rely on merge-signal precedence, since the WS canonical is authoritative and we don't want a stray brand-dict pattern to fire on a ticker symbol. `merchantClean` for these rows is whatever `normalizeMerchant(raw)` already produces in `mapRow.ts`; the WS stage only sets `merchantCanonical`.

### 5. Backfill

After code lands, run:
```
node backend/dist/import/runEnrichmentBackfill.js --household=<id> --dry-run
# review diff sample, then:
node backend/dist/import/runEnrichmentBackfill.js --household=<id>
```

The existing `runEnrichmentBackfill` deletes old signals and re-runs the pipeline, repopulating `merchant_canonical` everywhere.

## Data flow

```
CSV row
  → mapRow.ts                 (sets merchantRaw)
  → normalizeMerchant         (sets merchantClean — NEW: more stripping)
  → enrich.ts pipeline:
      → wsInvestmentBrandStage (NEW)  → if hit, sets merchantCanonical
      → normalizeStage         → seed dict lookup (EXPANDED dict)
      → ...other stages
  → Transaction row written

Display path:
  GET /api/summary/dashboard
    → groups by merchantCanonical ?? merchantClean ?? merchantRaw (FIXED)
    → returns merchantSummaries[]
```

## Testing

- Unit tests for `normalizeMerchant.ts`: extend the existing test file with cases for each new transformation (mid-string store, dup city, new prefixes). Include negative cases (don't strip legitimate numbers, don't collapse non-duplicate tails).
- Unit tests for `brandDictionary.ts`: add cases for each new entry against representative raw strings from the user's data sample. Critical: assert `DOORDASHTHESAFFRONI → DoorDash` to lock in the word-boundary fix.
- Unit tests for `wsInvestmentBrandStage.ts`: one case per pattern in the table above, plus a negative case (a normal spend string returns no signal).
- Snapshot/integration test for `GET /api/summary/dashboard`: seed a household with the mix from the user's data sample; assert that `merchantSummaries` collapses to expected canonicals.
- No DB schema changes, no migration tests.

## Risks

- **False positives in mid-string store stripping.** `FIKA SUPPLY - UNION STA` could be mis-parsed if the rule is too aggressive. Mitigate: only strip numeric tokens of ≥3 digits or `[A-Z]\d{4,}` format, never short standalone numbers.
- **Backfill rewrites historical autoCategory/notes.** The existing `runEnrichmentBackfill` deletes signals before regenerating. Confirm with `--dry-run` first; user can scope by date range if any old data is sacred.
- **WS investment patterns drift if Wealthsimple changes their CSV phrasing.** Lock in via tests; failure mode is graceful (no canonical, falls through to existing pipeline).

## Sequence

1. Land normalizer + dictionary + WS stage with tests.
2. Land the 1-line dashboard fix.
3. Backfill dry-run, inspect, then real run.
4. User verifies dashboard merchant list.

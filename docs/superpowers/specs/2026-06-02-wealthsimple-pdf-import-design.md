# Wealthsimple PDF statement import — design

**Date:** 2026-06-02
**Status:** approved design, pre-plan
**Owner:** Connor

## Goal

Import the full contents of Wealthsimple monthly statement PDFs into cashflow:

- **Credit-card** statements (`C13BRX957CAD_*_CREDIT_CARD.pdf`, ~4 pages) → cash `Transaction` rows.
- **Brokerage** statements (`HQ*…_*_BROKERAGE.pdf`, `WK*…_*_BROKERAGE.pdf`, ~5 pages) → `InvestmentActivity` rows (the Activity table) **and** `HoldingSnapshot` rows (month-end Portfolio Equities table).

Ship two reusable, registered PDF parsers (the normal cashflow feature flow: TDD, PR), then backfill all 187 local files into prod via a script that reuses the parse+commit pipeline.

Some Wealthsimple data already entered cashflow via the CSV importers, so **cross-source dedup is a hard requirement** — a PDF row for a transaction/holding already imported from CSV must not create a duplicate.

## Primitives spine check

No new primitive. This extends existing machines:

- Credit-card rows → `Transaction` (existing).
- Brokerage Activity rows → `InvestmentActivity` (existing model, populated today by the WS CSV importers).
- Month-end positions → `HoldingSnapshot` (existing model, PR #59).
- Account → `Account`, auto-created/matched by `shortCode` (existing bundle-importer pattern).

This is parser + dedup work. It is **not** a spine change.

## Existing infrastructure reused

- `backend/src/import/pdf/` registry: `PdfParser = {id, label, sniff(lines), parse(lines, ctx)}`, registered in `registry.ts`, dispatched by `findPdfParser()`.
- `extractPdfLines(buffer)` (`pdf/extractLines.ts`) — pdfjs positioned-text extraction, y-bucketed lines with per-span x-positions.
- `PdfParseResult` already carries `{transactions, investmentActivities, holdings, header, warnings, parseErrors}`.
- Reference parsers: `pdf/questrade.ts` + `pdf/rbcInvestment.ts` (brokerage: activity + holdings), `pdf/cibcCostcoMastercard.ts` (credit card).
- `commitStatementImport.ts` — persistence; `findExistingInvestmentByFuzzyMatch` (`fuzzyDedupInvestmentActivity.ts`) — activity dedup; `wealthsimpleTxnType.ts` — WS transaction-code taxonomy.
- WS account-resolution patterns: `importWsBundleFile` (filename-driven) and `importPdfBundleFile` (body-header-driven) in `runImport.ts`.

## Components

### 1. `pdf/wealthsimpleCreditCard.ts`

- **sniff:** lines contain `"Credit card statement"` and `"Wealthsimple"` (and not the brokerage marker).
- **parse:** the `Activity` table — `TRANS. DATE | POSTED DATE | TYPE | DETAILS | AMOUNT ($CAD)`.
  - Date from TRANS. DATE; the statement prints `Mon DD` with no year, so infer the year from the statement period (same approach as `cibcCostcoMastercard.ts`'s `inferYearForMonthDay`).
  - **Sign convention** → cashflow (`positive = credit, negative = charge`): `Purchase` rows are printed positive → store **negative**; `Payment`/credit rows print as `–$…` → store **positive**.
  - `merchantRaw` = the DETAILS text; `merchantClean = normalizeMerchant(...)`.
- **header:** `accountType: 'credit_card'`, `productLabel: 'Wealthsimple Credit Card'`, period from the `Mon DD — Mon DD, YYYY` range, `accountSuffix` = last-4 (`3338`) as a fallback. **Account identity for matching comes from the filename** (see Account identity).

### 2. `pdf/wealthsimpleBrokerage.ts`

- **sniff:** `"ORDER EXECUTION ONLY ACCOUNT"` + `"Account No."` + Wealthsimple address/`"Wealthsimple Investments"`. Must not collide with `questrade`/`rbcInvestment` sniffs.
- **header:** `accountSuffix` = full WS account number from the `Account No. <id>` line (e.g. `HQ6LMLTK8CAD`); `period` from `Statement Period YYYY-MM-DD - YYYY-MM-DD`; `accountType: 'investment'`; `productLabel` from the account-type label line (`Tax-Free Savings SDI Cash Account`, `Self-directed Non-Registered Margin Account`, etc.); `currency` per the account (CAD or USD suffix).
- **holdings** (`Portfolio Equities` table): columns `Symbol(name + ticker) | Total Quantity | Segregated Qty | Quantity on Loan | Market Price ($) | Market Value ($) | Book Cost ($)`, grouped under `Canadian Equities and Alternatives` / `US Equities and Alternatives`. Emit one `HoldingSnapshot` per security: `statementDate = period end`, `security{symbol, name, assetType, currency}`, `quantity = Total Quantity`, `price = Market Price`, `marketValue`, `costBasis = Book Cost`, `currency` from the section (CAD vs US). Skip the `Total` / category-subtotal lines.
- **investmentActivities** (`Activity - Current period` table): columns `Date | Transaction(code) | Description | Debit ($) | Credit ($) | Balance ($)`.
  - `activityType` is classified from the **Transaction code** column (BUY/SELL/DIV/INT/DEP/WD/CONT/TRFIN/LOAN/RECALL/FPLINT/…) via the **shared WS taxonomy** in `wealthsimpleTxnType.ts` (extend it if a code is missing), so PDF rows classify identically to CSV rows.
  - `tradeDate` = the `executed at YYYY-MM-DD` date parsed from the Description (fallback to the row Date). This matches how `wealthsimpleInvestParse.ts` derives `tradeDate`, maximizing fuzzy-dedup alignment. `settlementDate = null`.
  - `quantity` parsed from the Description (`Bought 0.0243 shares`); **null** for dividend/interest/fee types (matches the CSV parsers so the fuzzy matcher's null-matches-null rule holds).
  - `amount` from Debit/Credit; `security` from the ticker in the Description; `currency` from the active section (CAD/USD).
  - **Multi-line stitching:** pdfjs splits wrapped descriptions and (for some layouts) numeric columns onto adjacent y-buckets. Stitch continuation lines using the neighbor-y approach from `questrade.ts`/`rbcInvestment.ts`.
  - Margin/USD accounts split Activity into separate `CAD Activity` / `USD Activity` tables; parse both, tagging currency per table. CAD-only accounts have one merged `Activity` table.

### 3. WS-PDF bundle route (account identity + dedup wiring)

Mirror `importWsBundleFile`. For each PDF: resolve the `Account`, set the dedup flag, then run the existing `parseStatementFile` + `commitStatementImport`.

## Account identity (the hinge)

Cross-source dedup only fires if the PDF resolves to the **same `Account`** the CSV importers used (the fuzzy matcher hard-equals `accountId`; holdings dedup keys on `accountId`). WS CSV importers store `shortCode` = the WS account number (CSV `wsid` regex `([A-Za-z0-9]+CAD?)`, holdings `Account Number` column, activities-export `account_id`).

- **Brokerage:** use the `Account No.` from the PDF **body** — authoritative, and works for raw WS PDFs regardless of filename.
- **Credit-card:** the body prints only the masked card + last-4 (`3338`), **not** the `C13BRX957` id. Use the **filename** account id for matching.
- For raw (non-renamed) WS PDF drag-drop later: brokerage still resolves from the body; credit-card falls back to last-4. The bundle route prefers a filename-derived WS account id when the file matches the `<acctno>_<YYYY-MM>_<TYPE>.pdf` convention.

**Required first plan step (blocking gate):** query prod DB for the actual `shortCode`s of the existing WS accounts (especially the activities-export `account_id` format and the credit-card wsid). Confirm the PDF-derived ids match. If they don't, dedup silently never fires and the backfill double-counts. (Per Connor's standing rule: use prod DB, never local sqlite.)

## Dedup strategy

### Investment activities — fuzzy, cross-source

Set `crossSourceDedup: 'fuzzy-window-5d'` on the WS-PDF preview so `findExistingInvestmentByFuzzyMatch` runs in commit. It matches on `(accountId, activityType, symbol, quantity@8dp, amount@4dp, currency)` within ±5 calendar days of `tradeDate`.

- Outcomes already handled by commit: single-match → skip (+ backfill `settlementDate`); multi-match → warn + skip (review, never silent dup); no-match → insert.
- **Correctness requirement (TDD):** the PDF `amount`/`quantity` **sign and precision must match the values the CSV importers store**, or the fuzzy match misses. Verify against a known overlapping row (one account-month present in both a CSV import and its PDF). This is a required test.

### Holdings — WS-only fingerprint reuse (chosen)

Make WS PDF holdings carry the **same fingerprint** as the CSV holdings importer so they collide on the `sourceRowFingerprint` unique index:

```
stableFingerprint({ kind: 'ws_holding', accountId, statementDate, symbol: symbol.toUpperCase(), currency })
```

(matches `runImport.ts:1153`). The generic PDF path currently assigns `kind:'holding'` with a different field set (`parseStatementFile.ts`), so a small mechanism is needed: the `PdfParser` declares its holding-fingerprint scheme (e.g. an optional `holdingFingerprint: 'ws_holding'`), and `parseStatementFile` honors it when assigning fingerprints. No change to the generic scheme for other parsers.

- Overlapping month (the one CSV snapshot date): PDF holding collides → unique-index catch → marked duplicate, skipped. Correct.
- All other months: distinct `statementDate` → inserts. This is the bulk of the value (monthly history back to 2023; CSV had one current snapshot).

### Credit-card transactions

Existing cash-transaction dedup (`dedupExisting.ts`, `stableIdentityFingerprint` over accountId+date+amount+currency+merchantRaw) applies automatically in commit. No new wiring.

## Reconciliation (correctness for "fully")

The statement's Portfolio-Cash summary totals, closing balances, and per-security market values are **derived** (no table, per the spine) but used as **validation assertions** during parse:

- Sum of parsed Activity Debits/Credits should reconcile to the statement's Total Cash Paid In/Out and the Closing Cash Balance.
- Sum of holding Market Values + Cash should reconcile to Total Portfolio market value.
- Credit-card: parsed rows should reconcile to `Purchases`/`Payments`/`New balance` in the Account summary.

Mismatch beyond a small tolerance → `warnings` entry (non-blocking, surfaced in the backfill report). Cheap signal that catches parse drift across 187 heterogeneous files.

## Backfill

A script (e.g. `backend/scripts/backfillWealthsimplePdfs.ts`) that walks the local statement directory, feeds each file through the **same** `parseStatementFile` + `commitStatementImport` pipeline (no duplicated parse logic), against the prod DB.

- **Phase 1 — dry run:** parse-only. Report per-file: account resolved, row counts (txns/activities/holdings), reconciliation pass/fail, projected new vs deduped. No writes. Show Connor the diff.
- **Phase 2 — prod write:** only on Connor's explicit go-ahead. Idempotent via the dedup above → safely re-runnable.
- Avoids the 20-file multer UI limit (187 files); no change to that limit needed.

## Testing

- Unit tests per parser against fixtures derived from real statements: an empty account, a populated CAD-only account, a margin account with split CAD/USD activity, a credit-card statement with a payment + purchases, year-boundary date inference.
- Cross-source dedup test: an overlapping account-month proves a PDF row dedups against the CSV-stored row (activities fuzzy + holdings fingerprint).
- Reconciliation tests: parsed totals match stated statement summary figures.
- Sign-convention tests: credit-card purchase→negative, payment→positive.

## Out of scope

- Parsing WS's *original* (non-renamed) PDF download filenames — the brokerage body is authoritative; credit-card raw-filename support is best-effort via last-4.
- Persisting the Portfolio-Cash summary aggregates as their own rows (derived; used only for reconciliation).
- Generic (non-WS) holdings dedup — explicitly deferred per the WS-only fingerprint-reuse decision.

## Key risks

1. **Account-id mismatch** between PDF and CSV-stored `shortCode` → dedup never fires, backfill double-counts. Mitigated by the blocking prod-DB verification step.
2. **Amount/quantity sign+precision divergence** between PDF and CSV → fuzzy match misses. Mitigated by the overlapping-row test.
3. **pdfjs line-split variance** across account types (margin vs registered, CAD vs USD) → fragile column parsing. Mitigated by fixtures spanning account types + reconciliation assertions.

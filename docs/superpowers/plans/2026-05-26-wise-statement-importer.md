# Wise statement importer — implementation plan

**Goal:** Import Wise multi-currency PDF statements into cashflow. Each currency (e.g. CAD, USD) becomes its own Account, auto-created from the PDF header. FX conversion rows (`Converted X USD to Y CAD`) link as transfer pairs across the two accounts via shared `BALANCE-<id>` source reference. Corp vs personal routing derived from PDF `Account Holder` line — corp PDFs auto-create / link to the matching `Entity` row and stamp every row `autoBusiness=true`.

**Tech stack:** Existing PDF bundle importer (`backend/src/import/runImport.ts`'s `importPdfBundleFile`), PdfParser interface (`backend/src/import/pdf/`), Sequelize + Postgres in prod.

**Reference samples:** CAD + USD statement PDFs from CDG Labs Inc., June 2025 → May 2026 (not committed; format documented in kindex node `fc042394ee27`).

---

## File structure

**Backend — new files**
- `backend/src/import/pdf/wiseStatement.ts` — PdfParser. Sniff `/Wise Payments Canada Inc\./i`. Header → `accountSuffix` (last4 of account #), `productLabel` (`Wise CAD` | `Wise USD`), `accountType: 'checking'`, period, plus new fields `currency` and `accountHolder`. Body: walks lines, pairs each `<Long date> Transaction: <TXNID>[ Reference: <ref>]` line with prior description line(s); classifies Incoming/Outgoing/Balance by column-X (same approach as `rbcPersonalBanking`). Signed amount: outgoing values arrive as negative (`-14,223.53`), incoming positive — emit as-is. `sourceReference` = TXNID (e.g. `BALANCE-5207451832`).
- `backend/src/migrations/20260526000001-link-ws-corp-accounts-cdg.js` — backfill: if an Entity with `legal_name='CDG Labs Inc.'` and `kind='corp'` exists, update `accounts` rows id=13 (Wealthsimple Corporate Investing) and id=24 (Wealthsimple Corporate Chequing) to `entity_id = <CDG entity id>`. Idempotent (skip if already linked, skip if entity absent).

**Backend — new tests**
- `backend/test/pdfWiseSniff.test.ts` — registry-level sniff hits.
- `backend/test/pdfWiseHeader.test.ts` — `parseWiseStatementHeader` extracts suffix, currency, holder, period.
- `backend/test/pdfWiseBody.test.ts` — `wiseStatementParser.parse` on synthetic line array: txn count, signs, sourceReferences, FX conversion rows.
- `backend/test/runImport.wiseBundle.test.ts` — bundle integration: two PDFs → two Accounts auto-created (CAD + USD), corp Entity find-or-created, `overrideBusiness` applied, FX pair linking via shared sourceReference.

**Backend — modifications**
- `backend/src/import/pdf/types.ts` — extend `PdfStatementHeader`:
  - Add optional `currency?: string` (3-letter ISO, e.g. `'CAD'`, `'USD'`).
  - Add optional `accountHolder?: string` (legal name as printed, e.g. `'CDG Labs Inc.'`).
  - Existing fields unchanged; absence means parser doesn't surface that signal.
- `backend/src/import/pdf/registry.ts` — register `wiseStatementParser` inside `registerBuiltInPdfParsers`.
- `backend/src/import/runImport.ts` — extend `importPdfBundleFile`:
  - Add to `PDF_ACCOUNT_TEMPLATES`: `'Wise CAD' → { name: 'Wise CAD', accountType: 'checking' }` and `'Wise USD' → { name: 'Wise USD', accountType: 'checking' }`.
  - Use `header.currency ?? 'CAD'` when setting `Account.defaultCurrency` on creation (currently hardcoded `'CAD'`).
  - New helper `resolveEntityForHolder(holder: string, householdId: number): Promise<Entity | null>`:
    1. If `holder` is null/empty → return null.
    2. Try exact-match `Entity.legalName = holder` AND `householdId` → return.
    3. If `holder` matches `/(?:\bInc\.?|\bCorp\.?|\bLtd\.?|\bLLC\b|\bGmbH\b|\bPty\b|\bS\.A\.)/i` → find-or-create corp Entity (`kind='corp'`, `legalName=holder`, `householdId`).
    4. Else return null (let `Account.entityId` stay null).
  - After `findOrCreate(Account)`, if `account.entityId` is null and `entity` was resolved → `update({ entityId: entity.id })`. (Idempotent on re-upload.)
  - Pass `overrideBusiness: true` to `parseStatementFile` when resolved entity is corp.
- `backend/src/import/enrichment/detectRelationshipsStage.ts` — extend `findTransferSibling`:
  - When `input.sourceReference` is set, also include candidates that share the same `sourceReference` (cross-account, cross-currency, any amount, within `transferWindowDays`). Returned via the same `Signal` shape with `linkedTransactionId` + `autoCategory: 'Transfer'`.
  - `RelationshipCandidate` gains optional `sourceReference: string | null`.
  - `DetectRelationshipsInput` gains optional `sourceReference: string | null`.
  - Caller in `runEnrichmentBackfill.ts` / `commitStatementImport.ts` / enrichment driver must supply `sourceReference` for both the input txn and candidates (load on candidate fetch).

---

## Task 1 — Extend `PdfStatementHeader`

**Files:** `backend/src/import/pdf/types.ts`

Add optional `currency`, `accountHolder` fields. No new behavior yet. Existing parsers don't populate them; `importPdfBundleFile` reads them conditionally.

**Verify:** `yarn workspace cashflow-backend typecheck` clean.

## Task 2 — Wise PDF parser

**Files:** `backend/src/import/pdf/wiseStatement.ts`, `backend/test/pdfWiseHeader.test.ts`, `backend/test/pdfWiseBody.test.ts`, `backend/test/pdfWiseSniff.test.ts`.

TDD: write header tests first (sniff + extract). Then body tests (one synthetic line array per case: `Sent money`, `Received money`, `Converted`, `Topped up account`, `Wise bank details acquisition`). Then implement parser to satisfy.

Sniff: `lines.some(l => /Wise Payments Canada Inc\./i.test(l.text))`.

Header extraction:
- Currency: scan for `^(CAD|USD|GBP|EUR|...) statement$` first line.
- Account number: line right after `^Account number$` or `Account number\s+(\d+)`. Take last 4 as `accountSuffix`.
- Period: `(^|\s)<Long date>\s*\[GMT-04:00\]\s*-\s*<Long date>\s*\[GMT-04:00\]` — reuse `parseLongDate`.
- Account holder: line right after `^Account Holder$`. Take entire string (e.g. `CDG Labs Inc.`).
- `productLabel`: `Wise ${currency}`. `accountType`: `'checking'`.

Body parsing:
- Section starts at the currency balance line (`<CCY> on <date>...`).
- Each txn = description line + date-id line. Walk lines: maintain `pendingDescription` (last non-table-header non-empty non-balance non-amount line); when a date-id line matches, flush a txn with merchantRaw = pendingDescription, date from the match, sourceReference = TXNID, amount classified from the same line's numeric columns.
- Date-id regex: `/^(?<date>[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+Transaction:\s+(?<id>[A-Z_]+-(?:invoice-)?\d+)(?:\s+Reference:\s+(?<ref>\S+))?/`.
- Amount classification: three rightmost money tokens are Incoming, Outgoing, Amount(balance). Use X-position split (column midpoint detection like rbc). For each row choose Incoming if positive in incoming column, Outgoing (already negative) if present in outgoing column.

## Task 3 — Register parser

**Files:** `backend/src/import/pdf/registry.ts`, `backend/test/pdfWiseSniff.test.ts`.

Add lazy-require + `registerPdfParser(wiseStatementParser)`. Test that `findPdfParser` returns Wise parser when sniff line present.

## Task 4 — Bundle importer wiring

**Files:** `backend/src/import/runImport.ts`, `backend/test/runImport.wiseBundle.test.ts`.

Adjust `importPdfBundleFile`:
- `PDF_ACCOUNT_TEMPLATES`: add Wise CAD + USD entries.
- `defaultCurrency` flows from `header.currency ?? 'CAD'`.
- Implement + call `resolveEntityForHolder`.
- Apply `entityId` and `overrideBusiness` accordingly.

Integration test: feed two synthetic Wise PDFs (or stub `extractPdfLines` + register parser) → expect:
1. Two new Accounts (`Wise CAD` + `Wise USD`) under the test household.
2. One new corp Entity `CDG Labs Inc.`.
3. Both accounts have `entity_id` set to the new corp Entity.
4. All transactions stamped `autoBusiness=true`.
5. Matching `BALANCE-<id>` pairs across CAD ↔ USD have `linkedTransactionId` set on both sides (after enrichment).

## Task 5 — `sourceReference` transfer-pair link

**Files:** `backend/src/import/enrichment/detectRelationshipsStage.ts`, `backend/src/import/enrichment/types.ts`, callers that build `DetectRelationshipsInput`, unit test.

Add `sourceReference` to `RelationshipCandidate` + `DetectRelationshipsInput`. `findTransferSibling`:
- If `input.sourceReference` is set, prefer candidates where `c.sourceReference === input.sourceReference` (cross-account, any amount, within window).
- Fallback: existing amount-equality match.

Caller plumbing: enrichment must fetch `sourceReference` for both the input row and candidate rows (verify field already exists on `Transaction` model — it does, used by Wealthsimple importer already).

## Task 6 — Backfill WS corp accounts to CDG Entity

**Files:** `backend/src/migrations/20260526000001-link-ws-corp-accounts-cdg.js`, `backend/test/migrations/wiseLinkWsCorp.test.ts`.

Idempotent migration:
1. Look up Entity by `legal_name='CDG Labs Inc.'` AND `kind='corp'`.
2. If absent → noop (Wise import will create it on first upload).
3. If present → `UPDATE accounts SET entity_id=<id> WHERE id IN (13, 24) AND entity_id IS DISTINCT FROM <id>`.

Down: noop (don't unlink — destructive).

## Task 7 — End-to-end smoke

Manual upload of the two real PDFs in dev, verify in UI: both accounts created, txns visible, FX pairs linked, autoBusiness stamped.

---

## Out of scope (follow-ups)

- Personal-Wise PDF parsing path validation (corp-only fixtures in this PR; code supports personal via holder check).
- `Wise EUR` / `Wise GBP` / other currencies — template auto-falls-back to `Wise <CCY>` via `header.productLabel`.
- UI affordance for surfacing "Auto-created Entity X" in the upload result panel.

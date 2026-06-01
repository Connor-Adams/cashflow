# Interac e-Transfer counterparty recovery from email — design

**Date:** 2026-06-01
**Primitive:** Counterparty (Contact + `Transaction.counterparty_contact_id`) + Document (email as source). No new table for the core; one new `ai_suggestions` kind for the review queue.
**Builds on:** the shipped counterparty feature (PR A/B/C) — reuses `findOrCreateContactByName` / `resolveCounterpartyContact` and the `counterparty_raw` / `counterparty_contact_id` fields.

## Problem

Wealthsimple's transaction feed strips the e-transfer counterparty: 39 of Connor's prod rows are `Interac e-Transfer® Received` / `Out` with every text field blank (`merchant_raw`, `notes`, `source_reference` all empty). `extractCounterparty` cannot help — the name isn't in the bank data. But the name **is** in the Interac notification emails, which the connected Gmail (`ceeman.adams@gmail.com`, `gmail.readonly`) already receives.

**Measured feasibility (real prod data, 2026-06-01):** 19/39 nameless e-transfers matched an Interac email by amount + date (±7d) — a floor (capped at 120 emails, naive parse). Wealthsimple **does** emit Interac emails (`Wealthsimple <catch@payments.interac.ca>`), so WS e-transfers are matchable. Real names recovered: Stephen Masseur, Finnska Inc., Caelan Iten-McGrath.

**Email format** (`from: <bank> <catch@payments.interac.ca>` or `notify@payments.interac.ca`):
> subj: `Interac e-Transfer: Your $5,000.00 transfer to Caelan Iten-McGrath has been successfully deposited.`
> body: `Hi CONNOR ADAMS, ... The $5,000.00 (CAD) you sent to Caelan Iten-McGrath ... Reference Number: C1AWG5BX9Xkd`

The subject names the **recipient**. For Connor's OUT txns the recipient is the real counterparty; for IN txns that matched (`to Connor Adams`) it's a **self-transfer** (RBC→WS funding). A true inbound from another person uses a different phrasing ("\<Name\> sent you money" / "deposited into your account") — the parser must handle both.

## Decisions (from brainstorming)

1. **Auto high-confidence, review the rest.** Exact amount + tight date window + a unique candidate both ways → auto-set the counterparty. Collisions (multiple txns/emails at the same amount) or weak matches → a suggestion Connor confirms.
2. **On-demand job + auto on Gmail scan.** A dedicated sync job (first run backfills the 39); also piggybacks the existing receipt scan so future e-transfers get named.
3. **Self-transfer = raw-but-no-Contact.** When the recovered name ≈ the **account owner's** name, set `counterparty_raw` (informative) but create **no** Contact — it's internal, not a peer. Transfers to the **partner** still make a Contact.
4. **Direct Interac only; drop Chexy.** Chexy (rent service) charges Connor's Amex, not WS; its e-transfer leg never matches a WS txn (0 of the 19 matches were Chexy). Including it adds parse complexity + false-match risk for zero yield.
5. **Auto date window = ±3 days.** Tighter than the ±7d measurement to cut collisions; the matches observed were ±0–1 day.

## Architecture (units, each small + testable)

### 1. `parseInteracEmail(from, subject, body) → ParsedInteracEmail | null`
Pure function. Returns `{ name, amountCents, direction: 'sent' | 'received', emailDate, ref }` or null.
- Only fires for `from` containing `payments.interac.ca`.
- "sent" form: `Your $<amt> transfer to <Name> has been successfully deposited` (subject) / `you sent to <Name>` (body).
- "received" form: `<Name> sent you money` / `deposited into your account` / `received from <Name>`.
- Normalizes the name (collapse whitespace, dedupe doubled tokens like `FINNSKA INC. FINNSKA INC.`, title-case), parses `$<amt>` to integer cents, extracts the Reference Number when present, `emailDate` from `internalDate`.
- File: `backend/src/integrations/parsers/interac.ts`. Sibling to the existing receipt parsers.

### 2. `fetchInteracEmails(accessToken, sinceIso) → ParsedInteracEmail[]`
Reuses `gmail.ts`: `listMessageIds({ query: 'from:payments.interac.ca after:<since>' })` → `fetchMessage` → `extractMessageBody` → `parseInteracEmail`. Drops unparseable messages. File: `backend/src/integrations/interacCounterparty.ts`.

### 3. `matchEmailsToTransactions(emails, txns, ownerName) → { auto: Match[]; review: Match[] }`
- `txns` = the household's nameless e-transfer rows (`counterparty_contact_id IS NULL`, `merchant_raw ILIKE '%interac e-transfer%'`, in-scope account type).
- A candidate pairs an email to a txn when `amountCents` equal AND `|emailDate − txnDate| ≤ 3 days`. **Sign is NOT a hard filter** — a "you sent to \<self\>" email legitimately matches a *deposited* (positive/IN) WS txn (self-funding RBC→WS). Direction is used only as (a) a tie-breaker when an amount collides, and (b) an input to self-detection.
- **auto**: exactly one email ↔ one txn at that amount in the window (unique both ways).
- **review**: any amount where ≥2 txns or ≥2 emails compete, or a near-but-not-exact match.
- `Match = { txnId, name, ref, emailMessageId, isSelf }`. `isSelf = name ≈ ownerName` (normalized compare to the account owner's display name).
- Pure given its inputs. File: `backend/src/import/matchInteracCounterparty.ts`.

### 4. Apply
- **auto, not self:** `counterparty_raw = name`; `counterparty_contact_id = resolveCounterpartyContact(...)` (PR B). Guarded by `WHERE counterparty_contact_id IS NULL`.
- **auto, self:** set `counterparty_raw = name` only; no Contact.
- **review:** insert an `ai_suggestions` row `kind='counterparty_email_match'` carrying `{ txnId, name, ref, emailMessageId, isSelf }`. Accepting it (existing inbox accept path) writes the same as the auto path.
- Provenance/idempotency: store the matched `emailMessageId` (in the suggestion, and for auto matches in the txn's `notes` or a provenance field — exact column decided in planning); re-runs skip txns that already have `counterparty_contact_id`.

### 5. `runInteracCounterpartySync({ householdId, userId, dryRun }) → { processed, autoApplied, suggested, selfSkipped, elapsedMs }`
Orchestrator. Loads the user's `UserEmailIntegration` (provider `google`), refreshes the token, fetches the account owner's name, calls fetch → match → apply. Reuses the per-household in-flight lock + `ProviderJobLog` summary pattern from `counterpartyBackfill.ts`. `dryRun` computes matches without writing. File: `backend/src/integrations/interacCounterparty.ts`.

### 6. Triggers
- **On-demand:** `POST /api/transactions/interac-counterparty/sync` (streaming optional, mirror the counterparty-backfill route). A frontend button (near the existing counterparty-backfill control).
- **Auto on scan:** after `scanInbox` finishes its receipt pass (`scanReceipts.ts`), call `runInteracCounterpartySync` for the same user/household so a Gmail scan also refreshes e-transfer names.

## Error handling
- No Gmail integration / expired token with no refresh → job returns a clear status, writes nothing (mirror counterpartyBackfill's error path + `ProviderJobLog`).
- 403 insufficient scope (known prod gotcha) → surfaced in the job result so the UI can prompt re-auth.
- Per-email parse failure → skip that email, continue.
- Per-txn write failure → skip that txn, continue (don't abort the batch).

## Testing
- **Parser unit tests** (`parseInteracEmail`): real fixtures — the "sent to \<Name\> deposited" form, the doubled-name `FINNSKA INC.` form, the self `to Connor Adams` form, a "received from \<Name\>" form, and a non-Interac sender (→ null).
- **Matcher unit tests** (`matchEmailsToTransactions`): exact unique → auto; two txns same amount → review; outside ±3d → no match; sign mismatch → no match; self name → `isSelf` true.
- **Integration test**: drive `runInteracCounterpartySync` against seeded nameless e-transfer txns + a stubbed email fetch (inject `fetchInteracEmails` results) → asserts auto rows get `counterparty_raw` + Contact, self rows get raw only, collisions become `ai_suggestions`, dry-run writes nothing, re-run is idempotent.

## Out of scope
- Chexy / non-Interac senders.
- Ref-number matching (WS txns have empty `source_reference`; amount+date is the only key).
- Linking the two sides of a self-transfer (that's the existing transfer-reconciliation feature).
- A scheduled/cron trigger (on-demand + on-scan only).

## Reused vs new
- **Reused:** `gmail.ts` (listMessageIds/fetchMessage/extractMessageBody/refreshAccessToken), `symmetricEncryption.decryptSecret`, `UserEmailIntegration`, `findOrCreateContactByName`/`resolveCounterpartyContact`, the `ai_suggestions` inbox, the counterparty fields, the counterparty-backfill job pattern (lock + ProviderJobLog).
- **New:** `parsers/interac.ts`, `interacCounterparty.ts` (fetch + orchestrator), `matchInteracCounterparty.ts`, one route, one frontend button, one `ai_suggestions` kind, a hook in `scanReceipts`.

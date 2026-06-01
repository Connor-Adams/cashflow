# Interac e-Transfer Counterparty Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Recover counterparty names for nameless `Interac e-Transfer® Received/Out` transactions by matching them to Interac notification emails (amount + date), auto-applying high-confidence matches and queueing ambiguous ones for review.

**Architecture:** A pure email parser + a pure matcher feed an orchestrator (`runInteracCounterpartySync`) that reuses the Gmail integration (read/decrypt/fetch), PR B's `findOrCreateContactByName`, and the counterparty fields. Auto matches write `counterparty_raw`+`counterparty_contact_id`; ambiguous matches become `ai_suggestions` rows accepted via a dedicated route. Triggered on-demand (route + button) and after each Gmail receipt scan.

**Tech Stack:** TypeScript, Sequelize, `node:test` + `tsx`, Postgres integration tests (`setupPgTestDb`), React frontend.

**Spec:** `docs/superpowers/specs/2026-06-01-interac-email-counterparty-recovery-design.md`. Builds on the merged counterparty feature (PR A/B/C).

---

## File Structure
- Create: `backend/src/integrations/parsers/interac.ts` — `parseInteracEmail` (pure).
- Create: `backend/src/import/matchInteracCounterparty.ts` — `matchInteracCounterparty` (pure).
- Create: `backend/src/integrations/interacCounterparty.ts` — `fetchInteracEmails` + `runInteracCounterpartySync` orchestrator (lock + ProviderJobLog).
- Modify: `backend/src/models/AiSuggestion.ts` + `backend/src/ai/suggestionStore.ts` — add `'counterparty_email_match'` kind.
- Modify: `backend/src/routes/transactions.ts` — `POST /interac-counterparty/sync`, `GET /interac-counterparty/status`, `POST /:id/interac-counterparty/accept`.
- Modify: `backend/src/routes/ai.ts` — surface the new kind in `GET /api/ai/inbox`.
- Modify: `backend/src/integrations/scanReceipts.ts` — post-scan hook.
- Modify: `frontend/src/pages/.../<counterparty area>` — sync button + inbox render/accept.
- Tests: `backend/test/interacEmailParser.test.ts`, `backend/test/matchInteracCounterparty.test.ts`, `backend/test/integration/interacCounterpartySync.test.ts`.

**Backend test command** (from `backend/`): `npx tsx --import ./test/setup.ts --test test/<path>.test.ts`. Integration needs local Postgres. Typecheck `yarn typecheck`, lint `yarn lint`. Husky broken → `--no-verify`. No `Co-Authored-By`. `.js` import extensions in tests (repo convention).

---

## Task 1: `parseInteracEmail` (pure parser)

**Files:** Create `backend/src/integrations/parsers/interac.ts`; Test `backend/test/interacEmailParser.test.ts`.

- [ ] **Step 1: Write the failing tests** — fixtures are the real captured prod formats:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInteracEmail } from '../src/integrations/parsers/interac.js';

const FROM = 'Wealthsimple <catch@payments.interac.ca>';

test('parses a "sent / deposited" notification', () => {
  const r = parseInteracEmail(
    FROM,
    'Interac e-Transfer: Your $5,000.00 transfer to Caelan Iten-McGrath has been successfully deposited.',
    'Hi CONNOR ADAMS, The $5,000.00 (CAD) you sent to Caelan Iten-McGrath has been successfully deposited. Reference Number: C1AWG5BX9Xkd',
  );
  assert.deepEqual(r, { name: 'Caelan Iten-McGrath', amountCents: 500000, direction: 'sent', ref: 'C1AWG5BX9Xkd' });
});

test('dedupes a doubled name token sequence', () => {
  const r = parseInteracEmail(FROM, 'Interac e-Transfer: Your $5,000.00 transfer to FINNSKA INC. FINNSKA INC. has been successfully deposited.', '');
  assert.equal(r?.name, 'FINNSKA INC.');
  assert.equal(r?.amountCents, 500000);
});

test('keeps original casing (no title-casing)', () => {
  const r = parseInteracEmail(FROM, 'Interac e-Transfer: Your $1,791.01 transfer to STEPHEN MASSEUR has been successfully deposited.', '');
  assert.equal(r?.name, 'STEPHEN MASSEUR');
  assert.equal(r?.amountCents, 179101);
});

test('non-interac sender returns null', () => {
  assert.equal(parseInteracEmail('Chexy <concierge@chexy.co>', 'Interac e-Transfer Sent to Jenny Gao $2,850.00', ''), null);
});

test('no parseable amount returns null', () => {
  assert.equal(parseInteracEmail(FROM, 'Interac e-Transfer: reminder', 'no amount here'), null);
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd backend && npx tsx --import ./test/setup.ts --test test/interacEmailParser.test.ts`

- [ ] **Step 3: Implement** `backend/src/integrations/parsers/interac.ts`:
```ts
export type InteracDirection = 'sent' | 'received';
export interface ParsedInteracEmail {
  name: string;
  amountCents: number;
  direction: InteracDirection;
  ref: string | null;
}

const AMOUNT_RE = /\$\s?([\d,]+\.\d{2})/;
const REF_RE = /Reference\s*Number:?\s*([A-Za-z0-9]+)/i;
// "...transfer to <Name> has been/was successfully deposited"
const SENT_SUBJECT_RE = /transfer to (.+?) (?:has been|was) successfully deposited/i;
// "...you sent to <Name> has been..." (body fallback)
const SENT_BODY_RE = /you sent to (.+?) (?:has been|was|\.|,)/i;
// inbound: "<Name> sent you" / "received from <Name>"
const RECEIVED_RE = /(?:received (?:an? interac e-?transfer )?from (.+?)(?:\.|,| has)|\b(.+?) sent you (?:money|an? interac))/i;

/** Collapse whitespace and fold an exact doubled token sequence
 *  ("FINNSKA INC. FINNSKA INC." -> "FINNSKA INC."). Casing preserved. */
function cleanName(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  const words = t.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const a = words.slice(0, half).join(' ');
    const b = words.slice(half).join(' ');
    if (a.toLowerCase() === b.toLowerCase()) return a;
  }
  return t;
}

export function parseInteracEmail(
  from: string,
  subject: string,
  body: string,
): ParsedInteracEmail | null {
  if (!/payments\.interac\.ca/i.test(from)) return null;
  const text = `${subject}\n${body}`;
  const amt = text.match(AMOUNT_RE);
  if (!amt) return null;
  const amountCents = Math.round(Number(amt[1].replace(/,/g, '')) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
  const ref = text.match(REF_RE)?.[1] ?? null;

  const sent = subject.match(SENT_SUBJECT_RE) ?? body.match(SENT_BODY_RE);
  if (sent?.[1]) return { name: cleanName(sent[1]), amountCents, direction: 'sent', ref };

  const recv = text.match(RECEIVED_RE);
  const recvName = recv?.[1] ?? recv?.[2];
  if (recvName) return { name: cleanName(recvName), amountCents, direction: 'received', ref };

  return null;
}
```

- [ ] **Step 4: Run, verify PASS** (same command). `yarn typecheck` clean.

- [ ] **Step 5: Commit**
```bash
git add backend/src/integrations/parsers/interac.ts backend/test/interacEmailParser.test.ts
git commit -m "feat(interac): parse counterparty name/amount/direction from Interac emails"
```

---

## Task 2: `matchInteracCounterparty` (pure matcher)

**Files:** Create `backend/src/import/matchInteracCounterparty.ts`; Test `backend/test/matchInteracCounterparty.test.ts`.

- [ ] **Step 1: Write the failing tests**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchInteracCounterparty } from '../src/import/matchInteracCounterparty.js';

const email = (amountCents: number, name: string, date: string, ref = 'R') => ({
  name, amountCents, direction: 'sent' as const, ref, emailDate: date, messageId: `m-${name}-${amountCents}`,
});
const txn = (id: number, amount: number, date: string) => ({ id, amountCents: Math.round(Math.abs(amount) * 100), date });

test('unique exact amount within 3 days -> auto', () => {
  const r = matchInteracCounterparty(
    [email(500000, 'Stephen Masseur', '2025-06-04')],
    [txn(1, -5000, '2025-06-04')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].txnId, 1);
  assert.equal(r.auto[0].name, 'Stephen Masseur');
  assert.equal(r.auto[0].isSelf, false);
  assert.equal(r.review.length, 0);
});

test('two txns same amount -> review (collision)', () => {
  const r = matchInteracCounterparty(
    [email(500000, 'Stephen Masseur', '2025-06-04'), email(500000, 'Finnska Inc.', '2025-06-05')],
    [txn(1, -5000, '2025-06-04'), txn(2, -5000, '2025-06-05')],
    'Connor Adams',
  );
  assert.equal(r.auto.length, 0);
  assert.ok(r.review.length >= 1);
});

test('outside 3-day window -> no match', () => {
  const r = matchInteracCounterparty([email(500000, 'X', '2025-06-01')], [txn(1, -5000, '2025-06-10')], 'Connor Adams');
  assert.equal(r.auto.length + r.review.length, 0);
});

test('self name -> isSelf true', () => {
  const r = matchInteracCounterparty([email(100000, 'Connor Adams', '2025-07-15')], [txn(1, 1000, '2025-07-15')], 'Connor Adams');
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].isSelf, true);
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx tsx --import ./test/setup.ts --test test/matchInteracCounterparty.test.ts`

- [ ] **Step 3: Implement** `backend/src/import/matchInteracCounterparty.ts`:
```ts
import { normalizeContactName } from '../contacts/normalizeContactName';

export interface InteracEmailLite {
  name: string;
  amountCents: number;
  direction: 'sent' | 'received';
  ref: string | null;
  emailDate: string; // YYYY-MM-DD
  messageId: string;
}
export interface NamelessTxnLite {
  id: number;
  amountCents: number; // absolute value
  date: string; // YYYY-MM-DD
}
export interface InteracMatch {
  txnId: number;
  name: string;
  ref: string | null;
  messageId: string;
  isSelf: boolean;
}
export interface InteracMatchResult {
  auto: InteracMatch[];
  review: InteracMatch[];
}

const WINDOW_DAYS = 3;
const daysBetween = (a: string, b: string) =>
  Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function matchInteracCounterparty(
  emails: InteracEmailLite[],
  txns: NamelessTxnLite[],
  ownerName: string,
): InteracMatchResult {
  const ownerKey = normalizeContactName(ownerName);
  const auto: InteracMatch[] = [];
  const review: InteracMatch[] = [];

  // group by amount so collisions (>=2 txns OR >=2 emails at an amount) go to review
  const amounts = new Set<number>([...txns.map((t) => t.amountCents)]);
  for (const amt of amounts) {
    const txnsAt = txns.filter((t) => t.amountCents === amt);
    const emailsAt = emails.filter(
      (e) => e.amountCents === amt && txnsAt.some((t) => daysBetween(e.emailDate, t.date) <= WINDOW_DAYS),
    );
    if (txnsAt.length === 0 || emailsAt.length === 0) continue;

    const buildMatch = (txnId: number, e: InteracEmailLite): InteracMatch => ({
      txnId,
      name: e.name,
      ref: e.ref,
      messageId: e.messageId,
      isSelf: normalizeContactName(e.name) === ownerKey,
    });

    if (txnsAt.length === 1 && emailsAt.length === 1) {
      auto.push(buildMatch(txnsAt[0].id, emailsAt[0]));
    } else {
      // collision: every plausible (txn,email) pair within window -> review
      for (const t of txnsAt) {
        const cand = emailsAt.find((e) => daysBetween(e.emailDate, t.date) <= WINDOW_DAYS);
        if (cand) review.push(buildMatch(t.id, cand));
      }
    }
  }
  return { auto, review };
}
```

- [ ] **Step 4: Run, verify PASS** (same command). `yarn typecheck` clean.

- [ ] **Step 5: Commit**
```bash
git add backend/src/import/matchInteracCounterparty.ts backend/test/matchInteracCounterparty.test.ts
git commit -m "feat(interac): match Interac emails to nameless txns by amount+date(±3d), auto vs review"
```

---

## Task 3: Add the `counterparty_email_match` suggestion kind

**Files:** Modify `backend/src/models/AiSuggestion.ts`, `backend/src/ai/suggestionStore.ts`.

- [ ] **Step 1:** In `backend/src/models/AiSuggestion.ts`, add `'counterparty_email_match'` to the `AiSuggestionKind` union (after `'counterparty_promotion'`).
- [ ] **Step 2:** In `backend/src/ai/suggestionStore.ts`, add `'counterparty_email_match'` to the inline `kind` union of `createTrackedSuggestion` (the same list).
- [ ] **Step 3:** Verify `yarn typecheck` clean.
- [ ] **Step 4: Commit**
```bash
git add backend/src/models/AiSuggestion.ts backend/src/ai/suggestionStore.ts
git commit -m "feat(interac): add counterparty_email_match ai_suggestions kind"
```

---

## Task 4: Orchestrator `runInteracCounterpartySync` + Gmail fetch

**Files:** Create `backend/src/integrations/interacCounterparty.ts`; Test `backend/test/integration/interacCounterpartySync.test.ts`.

The orchestrator runs OUTSIDE a request (also called from `scanInbox`), so it takes `householdId`+`userId` explicitly and creates `ai_suggestions` via `AiSuggestion.create({...})` directly (NOT `createTrackedSuggestion`, which needs `req`). It reuses the per-household in-flight lock + `ProviderJobLog` pattern from `counterpartyBackfill.ts` (read that file for the exact lock/log shape) with a new provider const `'interac_counterparty_sync'`.

Design the module so the Gmail fetch is INJECTABLE (a `fetchEmails` option defaulting to the real `fetchInteracEmails`) so the integration test can stub it without hitting Gmail.

- [ ] **Step 1: Write the failing integration test** `backend/test/integration/interacCounterpartySync.test.ts`. Mirror the harness from `backend/test/integration/counterpartyBackfill.test.ts` (`setupPgTestDb`, `seedHousehold`, `makeAccount`, `makeTxn`). Seed: a checking account owned by the user; a nameless `Interac e-Transfer® Out` txn −$5000 on 2025-06-04; a nameless `Interac e-Transfer® Received` +$1000 on 2025-07-15. Call `runInteracCounterpartySync` with a STUBBED `fetchEmails` returning two parsed emails: `{name:'Stephen Masseur', amountCents:500000, direction:'sent', ref:'R1', emailDate:'2025-06-04', messageId:'m1'}` and `{name:'<owner display name>', amountCents:100000, direction:'sent', ref:'R2', emailDate:'2025-07-15', messageId:'m2'}`. Assert:
  - the −$5000 txn gets `counterpartyRaw='Stephen Masseur'` + a non-null `counterpartyContactId` (Contact `normalized_name='stephen masseur'`).
  - the self +$1000 txn gets `counterpartyRaw=<owner name>` but `counterpartyContactId` stays NULL (self).
  - re-running is idempotent (txns already linked are skipped; no duplicate Contact).
  - a `ProviderJobLog` row with `provider='interac_counterparty_sync'` is written.
  - dryRun writes nothing.
  - a collision case (two −$5000 txns + two sent emails same window) creates `ai_suggestions` rows `kind='counterparty_email_match'` instead of auto-applying.
  (Look up the seeded user's `displayName` via `User.findByPk(userId)` to build the self email + the `ownerName` the orchestrator will compute.)

- [ ] **Step 2: Run, verify FAIL** — `npx tsx --import ./test/setup.ts --test test/integration/interacCounterpartySync.test.ts`

- [ ] **Step 3: Implement** `backend/src/integrations/interacCounterparty.ts`. Key pieces (read `counterpartyBackfill.ts` for the lock/ProviderJobLog idioms and `scanReceipts.ts:111-124` `ensureFreshAccessToken` to copy the token logic):
```ts
import { Op } from 'sequelize';
import {
  Account, AiSuggestion, Contact, ProviderJobLog, Transaction, User,
  UserEmailIntegration, sequelize,
} from '../models';
import { decryptSecret } from '../util/symmetricEncryption';
import { listMessageIds, fetchMessage, extractMessageBody, getHeader, refreshAccessToken } from './gmail';
import { parseInteracEmail } from './parsers/interac';
import { matchInteracCounterparty, type InteracEmailLite, type NamelessTxnLite } from '../import/matchInteracCounterparty';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import { logger } from '../observability/logger';

export const INTERAC_SYNC_PROVIDER = 'interac_counterparty_sync' as const;
const inFlight = new Set<number>();
export function isInteracSyncRunning(householdId: number): boolean { return inFlight.has(householdId); }

export interface InteracSyncResult {
  processed: number; autoApplied: number; suggested: number; selfApplied: number; elapsedMs: number; dryRun: boolean;
}

async function ensureToken(integ: UserEmailIntegration): Promise<string> {
  const exp = integ.expiresAt ? integ.expiresAt.getTime() : 0;
  if (exp - Date.now() > 60_000) return decryptSecret(integ.accessTokenEncrypted);
  if (!integ.refreshTokenEncrypted) throw new Error('Gmail token expired and no refresh token');
  const r = await refreshAccessToken(decryptSecret(integ.refreshTokenEncrypted));
  return r.access_token;
}

export async function fetchInteracEmails(accessToken: string, sinceIso: string): Promise<InteracEmailLite[]> {
  const since = sinceIso.slice(0, 10).replace(/-/g, '/');
  const ids = await listMessageIds({ accessToken, query: `from:payments.interac.ca after:${since}`, maxResults: 400 });
  const out: InteracEmailLite[] = [];
  for (const s of ids) {
    try {
      const full = await fetchMessage({ accessToken, messageId: s.id });
      const from = getHeader(full.payload, 'From') ?? '';
      const subject = getHeader(full.payload, 'Subject') ?? '';
      const body = extractMessageBody(full.payload);
      const parsed = parseInteracEmail(from, subject, body);
      if (!parsed) continue;
      out.push({ ...parsed, emailDate: new Date(Number(full.internalDate)).toISOString().slice(0, 10), messageId: s.id });
    } catch (e) {
      logger.warn({ err: e, messageId: s.id, module: 'interac_sync' }, 'interac_email_fetch_failed');
    }
  }
  return out;
}

export interface RunInteracSyncOpts {
  householdId: number;
  userId: number;
  dryRun?: boolean;
  /** Injectable for tests; defaults to the real Gmail fetch. */
  fetchEmails?: (accessToken: string, sinceIso: string) => Promise<InteracEmailLite[]>;
}

export async function runInteracCounterpartySync(opts: RunInteracSyncOpts): Promise<InteracSyncResult> {
  const { householdId, userId, dryRun = false } = opts;
  if (inFlight.has(householdId)) throw new Error('Interac sync already running for this household');
  inFlight.add(householdId);
  const startedAt = Date.now();
  let processed = 0, autoApplied = 0, suggested = 0, selfApplied = 0;
  let status: 'ok' | 'error' = 'ok';
  try {
    // 1. nameless interac e-transfer txns for the household
    const txns = await Transaction.findAll({
      where: { householdId, counterpartyContactId: { [Op.is]: null }, merchantRaw: { [Op.iLike]: '%interac e-transfer%' } },
      include: [{ model: Account, as: 'account', attributes: ['accountType', 'ownerUserId'], required: true, where: { accountType: ['checking', 'savings', 'cash'] } }],
    });
    processed = txns.length;
    if (txns.length === 0) return finish();

    // 2. owner name (self detection)
    const owner = await User.findByPk(userId);
    const ownerName = owner?.displayName ?? '';

    // 3. fetch + parse emails (since the oldest nameless txn date, minus a few days)
    const integ = await UserEmailIntegration.findOne({ where: { userId, provider: 'google' } });
    if (!integ) { status = 'error'; return finish('no_gmail_integration'); }
    const token = await ensureToken(integ);
    const oldest = txns.map((t) => String(t.date)).sort()[0];
    const sinceIso = new Date(Date.parse(oldest) - 5 * 86_400_000).toISOString();
    const fetchEmails = opts.fetchEmails ?? fetchInteracEmails;
    const emails = await fetchEmails(token, sinceIso);

    // 4. match
    const txnLites: NamelessTxnLite[] = txns.map((t) => ({ id: t.id, amountCents: Math.round(Math.abs(Number(t.amount)) * 100), date: String(t.date).slice(0, 10) }));
    const { auto, review } = matchInteracCounterparty(emails, txnLites, ownerName);

    if (dryRun) { autoApplied = auto.length; suggested = review.length; return finish(); }

    // 5. apply auto (own transaction per row so one failure doesn't poison the rest)
    for (const m of auto) {
      try {
        await sequelize.transaction(async (t) => {
          const patch: Record<string, unknown> = { counterpartyRaw: m.name };
          if (!m.isSelf) {
            const contact = await findOrCreateContactByName(householdId, m.name, { transaction: t });
            patch.counterpartyContactId = contact.id;
          }
          const [n] = await Transaction.update(patch, { where: { id: m.txnId, counterpartyContactId: { [Op.is]: null } }, transaction: t });
          if (n > 0) { autoApplied++; if (m.isSelf) selfApplied++; }
        });
      } catch (e) { logger.error({ err: e, txnId: m.txnId, module: 'interac_sync' }, 'interac_auto_apply_failed'); }
    }

    // 6. queue review rows as ai_suggestions (skip duplicates for the same txn)
    for (const m of review) {
      const exists = await AiSuggestion.findOne({ where: { householdId, transactionId: m.txnId, kind: 'counterparty_email_match', status: 'suggested' } });
      if (exists) continue;
      await AiSuggestion.create({
        householdId, userId, transactionId: m.txnId, kind: 'counterparty_email_match', status: 'suggested',
        inputSnapshot: { messageId: m.messageId, ref: m.ref },
        output: { name: m.name, isSelf: m.isSelf },
        finalSnapshot: null, model: 'deterministic', promptVersion: 'interac-email-match-v1',
      } as never);
      suggested++;
    }
    return finish();
  } catch (err) {
    status = 'error';
    logger.error({ err, householdId, module: 'interac_sync' }, 'interac_sync_failed');
    return finish(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight.delete(householdId);
  }

  function finish(errorMessage?: string): InteracSyncResult {
    const elapsedMs = Date.now() - startedAt;
    const result: InteracSyncResult = { processed, autoApplied, suggested, selfApplied, elapsedMs, dryRun };
    if (!dryRun) {
      void ProviderJobLog.create({
        provider: INTERAC_SYNC_PROVIDER, function: 'sync', symbol: String(householdId),
        status, httpStatus: null,
        errorMessage: status === 'ok' ? JSON.stringify(result) : (errorMessage ?? JSON.stringify(result)),
        fetchedAt: new Date(),
      });
    }
    return result;
  }
}
```
Note: the `finish()` closure mutates the outer counters — acceptable here, but verify the counts are set before each `return finish()`. If TS complains about hoisting/`void` on the async `ProviderJobLog.create`, await it instead (make `finish` async and `return await finish()`).

- [ ] **Step 4: Run the integration test, verify PASS** (same command). Fix until green. `yarn typecheck` + `yarn lint` clean.

- [ ] **Step 5: Commit**
```bash
git add backend/src/integrations/interacCounterparty.ts backend/test/integration/interacCounterpartySync.test.ts
git commit -m "feat(interac): runInteracCounterpartySync orchestrator (auto-apply + review suggestions)"
```

---

## Task 5: Routes — sync, status, accept

**Files:** Modify `backend/src/routes/transactions.ts`.

Mirror the existing `POST /counterparty/backfill` + `GET /counterparty/backfill/status` handlers (in this same file) for the lock(409)/streaming/ProviderJobLog shape. Import `isInteracSyncRunning`, `runInteracCounterpartySync`, `INTERAC_SYNC_PROVIDER` from `../integrations/interacCounterparty`.

- [ ] **Step 1:** `POST /interac-counterparty/sync` — `const { user, household } = currentAuth(req)`; 409 if `isInteracSyncRunning(household.id)`; read `dryRun` from body; call `runInteracCounterpartySync({ householdId: household.id, userId: user.id, dryRun })`; return the result JSON (streaming optional — JSON-only is fine for v1). On a thrown "already running" message return 409.
- [ ] **Step 2:** `GET /interac-counterparty/status` — return `{ running: isInteracSyncRunning(household.id), lastRunAt, lastSummary }` by reading the latest `ProviderJobLog` where `provider=INTERAC_SYNC_PROVIDER, symbol=String(household.id)` (mirror `getLastCounterpartyBackfillRun`/`computeCounterpartyBackfillStatus`).
- [ ] **Step 3:** `POST /:id/interac-counterparty/accept` — accept a review suggestion. Body `{ suggestionId }`. Load the `AiSuggestion` (scoped to household, kind `counterparty_email_match`, status `suggested`); load the txn under `visibleTransactionWhere(req)`; set `counterpartyRaw = output.name`; if `!output.isSelf` set `counterpartyContactId = (await findOrCreateContactByName(household.id, output.name)).id`; `txn.save()`; mark the suggestion `status='accepted'`. (This is the dedicated accept route — the codebase has no generic suggestion-apply dispatch; mirror `POST /:id/counterparty/promote` in this file.)
- [ ] **Step 4: Write route integration tests** in a new `backend/test/integration/interacCounterpartyRoutes.test.ts` (mirror `transactionCounterpartyPromote.test.ts` harness): sync returns a summary; status reflects last run; accept writes counterparty + flips suggestion to accepted; reject via the existing `POST /api/ai/suggestions/:id/reject` sets rejected. Run + green.
- [ ] **Step 5: Commit**
```bash
git add backend/src/routes/transactions.ts backend/test/integration/interacCounterpartyRoutes.test.ts
git commit -m "feat(interac): sync + status + accept routes"
```

---

## Task 6: Surface the kind in the AI inbox

**Files:** Modify `backend/src/routes/ai.ts` (the `GET /api/ai/inbox` aggregator, ~lines 499–567).

- [ ] **Step 1:** Read the inbox aggregator. Add a branch that includes `ai_suggestions` rows of `kind='counterparty_email_match', status='suggested'` as `InboxItem`s, carrying the candidate `name`, the `transactionId`, and `isSelf`, with the accept action pointing at `POST /api/transactions/:id/interac-counterparty/accept` (and reject at the existing `/api/ai/suggestions/:id/reject`). Follow the existing `counterparty_promotion` item shape.
- [ ] **Step 2:** Extend the inbox integration test (`backend/test/integration/aiInbox.test.ts` if present, else add a case) asserting a seeded `counterparty_email_match` suggestion appears in `GET /api/ai/inbox`. Run + green.
- [ ] **Step 3: Commit**
```bash
git add backend/src/routes/ai.ts backend/test/integration/aiInbox.test.ts
git commit -m "feat(interac): surface counterparty_email_match suggestions in the AI inbox"
```

---

## Task 7: Auto-run after Gmail receipt scan

**Files:** Modify `backend/src/integrations/scanReceipts.ts`.

- [ ] **Step 1:** Import `runInteracCounterpartySync` from `./interacCounterparty`. In `scanInbox`, after `await integ.save()` and BEFORE the `return` (around line 580), add a best-effort call (never let it fail the scan):
```ts
  if (opts.householdId != null) {
    try {
      await runInteracCounterpartySync({ householdId: opts.householdId, userId: opts.userId });
    } catch (e) {
      logger.warn({ err: e, module: 'interac_sync' }, 'post_scan_interac_sync_failed');
    }
  }
```
- [ ] **Step 2:** Typecheck clean. (No new test required — covered by Task 4's orchestrator test; the hook is a one-line best-effort call.)
- [ ] **Step 3: Commit**
```bash
git add backend/src/integrations/scanReceipts.ts
git commit -m "feat(interac): run counterparty sync after each Gmail receipt scan"
```

---

## Task 8: Frontend — sync button + inbox accept

**Files:** Modify the transactions/counterparty settings area (find the existing counterparty-backfill button) + the AI inbox component.

- [ ] **Step 1:** Find the existing counterparty-backfill trigger UI (grep `counterparty/backfill` in `frontend/src`). Add a sibling "Sync Interac names from email" button that `POST`s `/api/transactions/interac-counterparty/sync` (via the existing `postJson` helper) and surfaces the returned summary (`autoApplied`, `suggested`, `selfApplied`). Reuse the surrounding loading/toast pattern.
- [ ] **Step 2:** In the AI inbox component (grep the component rendering `GET /api/ai/inbox` items), add a render branch for `counterparty_email_match`: show the txn + candidate name, an Accept button (`POST /api/transactions/:id/interac-counterparty/accept` with `{ suggestionId }`) and a Reject button (`POST /api/ai/suggestions/:id/reject`). Mirror the existing `counterparty_promotion` item rendering.
- [ ] **Step 3:** `cd frontend && yarn tsc --noEmit` clean; `yarn lint` clean. If a component test exists for the inbox, add a case; otherwise rely on typecheck + the manual smoke in Task 9.
- [ ] **Step 4: Commit**
```bash
git add frontend/src
git commit -m "feat(interac): sync button + inbox accept/reject for email counterparty matches"
```

---

## Task 9: Verify + PR

- [ ] **Step 1: Full backend gate** (from `backend/`): `yarn typecheck` + `yarn lint` clean; run the new tests + key regressions:
  `npx tsx --import ./test/setup.ts --test test/interacEmailParser.test.ts test/matchInteracCounterparty.test.ts test/integration/interacCounterpartySync.test.ts test/integration/interacCounterpartyRoutes.test.ts test/integration/contacts.test.ts test/integration/transactionCounterpartyPromote.test.ts` → all PASS.
- [ ] **Step 2: Frontend gate**: `cd frontend && yarn tsc --noEmit && yarn vitest run` (or at least the touched tests) → green.
- [ ] **Step 3: Real-data smoke (optional, prod, read-then-dry-run):** the probe scripts already proved the data; optionally run the sync with `dryRun:true` against prod (same `railway run` recipe used for the probes) to confirm the auto/suggested counts look right before merge.
- [ ] **Step 4: Push + PR with auto-merge (merge commit, no squash).** Push the branch with an explicit refspec (a hook blocks Bash commands containing both a push and the word "main"); create the PR + enable auto-merge with `gh` in separate commands.

---

## Self-review (completed during planning)
- **Spec coverage:** parser (T1), matcher with ±3d + collision→review + self-detect (T2), suggestion kind (T3), orchestrator with auto-apply/self/review + lock + ProviderJobLog + idempotency + injectable fetch (T4), routes incl. the dedicated accept (T5, because there's no generic suggestion-apply dispatch), inbox surface (T6), scan hook (T7), frontend (T8). Drop-Chexy + direct-Interac-only enforced by the parser's `payments.interac.ca` sender gate (T1).
- **Self-transfer:** owner-name match (`User.displayName`) → `counterparty_raw` set, no Contact (T2 `isSelf`, T4 apply branch).
- **No generic accept dispatch (grounding):** review acceptance is a dedicated route mirroring `/counterparty/promote`, not `/suggestions/:id/apply`.
- **Outside-request constraint:** orchestrator uses `AiSuggestion.create` directly (not `createTrackedSuggestion`, which needs `req`) since it also runs from `scanInbox`.
- **Idempotency:** only `counterparty_contact_id IS NULL` txns processed; auto-apply `UPDATE ... WHERE counterparty_contact_id IS NULL`; review rows de-duped per txn.
- **Type consistency:** `InteracEmailLite`/`NamelessTxnLite`/`InteracMatch` defined in T2 and imported by T4; `parseInteracEmail` return shape (T1) is spread into `InteracEmailLite` with `emailDate`+`messageId` added in T4's `fetchInteracEmails`.

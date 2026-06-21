# In-App Feedback & Bug Reporting Surface (issue #295) Implementation Plan

> **For agentic workers:** Implement task-by-task, TDD, commit frequently. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an in-app feedback surface: a `Feedback` model, `POST/GET/resolve` routes with validation + per-user rate limit + optional sanitized outbound webhook, a TopBar "Help and feedback" button opening a panel, and an owner-only Settings → Feedback inbox tab.

**Architecture:** Backend mirrors the reimbursements vertical (model + JS migration + Express router mounted under `/api` behind `requireAuth`, household-scoped via `householdWhere`). A dedicated `feedbackRateLimit` limiter keys by `req.auth.user.id` (NOT skipped in test, so AC#5 is verifiable). Frontend mounts a `FeedbackButton` in `Layout.tsx` `.topBar__right` that opens a `FeedbackPanel` Dialog; an owner-gated `FeedbackInboxTab` lists submissions.

**Tech Stack:** TypeScript, Sequelize (Postgres prod, SQLite for migration round-trip test), Express, express-rate-limit v8, React 18, TanStack-free fetch helpers (`@/lib/api`), Tailwind v4, vitest + @testing-library/react (frontend), node:test + supertest (backend).

---

## File Structure

**Backend (create):**
- `backend/src/models/Feedback.ts` — Sequelize model, columns per AC data model.
- `backend/src/migrations/20260609000000-create-feedback.js` — createTable + index `(user_id, created_at)`; reversible.
- `backend/src/routes/feedback.ts` — `POST /api/feedback`, `GET /api/feedback`, `POST /api/feedback/:id/resolve`.
- `backend/src/routes/feedbackRateLimit.ts` — per-user limiter, max=FEEDBACK_RATE_LIMIT_MAX ?? 5, no test skip.
- `backend/src/services/feedbackWebhook.ts` — sanitized outbound POST when `FEEDBACK_WEBHOOK_URL` set; never throws to caller.
- `backend/src/feedback/validate.ts` — category enum + body length validation, pure (unit-testable).

**Backend (modify):**
- `backend/src/models/index.ts` — import/init Feedback + User/Household associations + export.
- `backend/src/app.ts` — mount `feedbackRouter` under `/api` (after requireAuth).

**Backend (test):**
- `backend/test/feedbackValidate.test.ts` — unit tests for validate.ts (node:test).
- `backend/test/migrations/feedbackMigration.test.ts` — SQLite round-trip.
- `backend/test/integration/feedback.test.ts` — route integration (Postgres).

**Frontend (create):**
- `frontend/src/components/feedback/FeedbackButton.tsx` — TopBar button + owns panel open state.
- `frontend/src/components/feedback/FeedbackPanel.tsx` — Dialog with category select + textarea + submit.
- `frontend/src/pages/settings/tabs/FeedbackInboxTab.tsx` — owner-only inbox list + resolve.
- `frontend/src/components/feedback/FeedbackButton.test.tsx`
- `frontend/src/components/feedback/FeedbackPanel.test.tsx`
- `frontend/src/pages/settings/tabs/FeedbackInboxTab.test.tsx`

**Frontend (modify):**
- `frontend/src/components/Layout.tsx` — mount `<FeedbackButton />` in `.topBar__right`.
- `frontend/src/App.tsx` — add `<Route path="feedback" element={<FeedbackInboxTab />} />` under settings.
- `frontend/src/pages/settings/SettingsPage.tsx` — add `feedback` tab (owner-only) to ALL_TOP_TABS + TOP_TAB_PATHS + ownerOnly filter.

---

## Task 1: Feedback validation (pure, unit-tested)

**Files:**
- Create: `backend/src/feedback/validate.ts`
- Test: `backend/test/feedbackValidate.test.ts`

- [ ] Step 1: Write failing unit test `backend/test/feedbackValidate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback, FEEDBACK_CATEGORIES } from '../src/feedback/validate.js';

test('accepts a valid bug submission', () => {
  const v = validateFeedback({ category: 'bug', body: 'Button is broken' });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.category, 'bug');
    assert.equal(v.value.body, 'Button is broken');
  }
});

test('defaults category to "other" when omitted', () => {
  const v = validateFeedback({ body: 'hello there' });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.value.category, 'other');
});

test('rejects an unknown category with INVALID_CATEGORY', () => {
  const v = validateFeedback({ category: 'spam', body: 'hello there' });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'INVALID_CATEGORY');
});

test('rejects a body under 5 chars after trim with BODY_TOO_SHORT', () => {
  const v = validateFeedback({ category: 'bug', body: '   hi   ' });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'BODY_TOO_SHORT');
});

test('rejects a body over 2000 chars with BODY_TOO_LONG', () => {
  const v = validateFeedback({ category: 'bug', body: 'a'.repeat(2001) });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'BODY_TOO_LONG');
});

test('trims body and clamps optional currentPath/appVersion length', () => {
  const v = validateFeedback({
    category: 'feature',
    body: '  please add dark mode  ',
    currentPath: '/x'.repeat(400),
    appVersion: 'v'.repeat(100),
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.body, 'please add dark mode');
    assert.equal(v.value.currentPath?.length, 512);
    assert.equal(v.value.appVersion?.length, 64);
  }
});

test('exposes the four categories', () => {
  assert.deepEqual([...FEEDBACK_CATEGORIES], ['bug', 'feature', 'confusing', 'other']);
});
```

- [ ] Step 2: Run `yarn workspace cashflow-backend run test 2>&1 | tail -20` filtered to this file — expect FAIL (module missing).

- [ ] Step 3: Implement `backend/src/feedback/validate.ts`:

```ts
export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'confusing', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const BODY_MIN = 5;
const BODY_MAX = 2000;
const PATH_MAX = 512;
const VERSION_MAX = 64;

export type FeedbackInput = {
  category: FeedbackCategory;
  body: string;
  currentPath: string | null;
  appVersion: string | null;
};

export type ValidationResult =
  | { ok: true; value: FeedbackInput }
  | { ok: false; status: number; error: string };

function cleanOptional(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function validateFeedback(body: Record<string, unknown>): ValidationResult {
  const rawCategory = body.category;
  let category: FeedbackCategory;
  if (rawCategory == null || rawCategory === '') {
    category = 'other';
  } else if (
    typeof rawCategory === 'string' &&
    (FEEDBACK_CATEGORIES as readonly string[]).includes(rawCategory)
  ) {
    category = rawCategory as FeedbackCategory;
  } else {
    return { ok: false, status: 400, error: 'INVALID_CATEGORY' };
  }

  const rawBody = typeof body.body === 'string' ? body.body : '';
  const trimmedBody = rawBody.trim();
  if (trimmedBody.length < BODY_MIN) {
    return { ok: false, status: 400, error: 'BODY_TOO_SHORT' };
  }
  if (trimmedBody.length > BODY_MAX) {
    return { ok: false, status: 400, error: 'BODY_TOO_LONG' };
  }

  return {
    ok: true,
    value: {
      category,
      body: trimmedBody,
      currentPath: cleanOptional(body.currentPath, PATH_MAX),
      appVersion: cleanOptional(body.appVersion, VERSION_MAX),
    },
  };
}
```

- [ ] Step 4: Run the test — expect PASS.
- [ ] Step 5: Commit `feat(feedback): add feedback submission validation`.

## Task 2: Feedback model

**Files:**
- Create: `backend/src/models/Feedback.ts`
- Modify: `backend/src/models/index.ts`

- [ ] Step 1: Create `backend/src/models/Feedback.ts` (mirror Reimbursement.ts; columns: id, householdId, userId NOT NULL, category STRING(32), body TEXT, currentPath STRING(512) null, userAgent STRING(512) null, appVersion STRING(64) null, resolvedAt DATE null; timestamps). Use `FeedbackCategory` from `../feedback/validate`.
- [ ] Step 2: In `backend/src/models/index.ts`: import `{ Feedback, initFeedback }`, call `initFeedback(sequelize)`, add `User.hasMany(Feedback,{foreignKey:'user_id',as:'feedback',onDelete:'CASCADE',hooks:true})` + `Feedback.belongsTo(User,{foreignKey:'user_id',as:'user'})` + `Household.hasMany(Feedback,{foreignKey:'household_id',as:'feedback',onDelete:'CASCADE',hooks:true})` + `Feedback.belongsTo(Household,{foreignKey:'household_id',as:'household'})`, add `Feedback` to the export block.
- [ ] Step 3: `yarn workspace cashflow-backend run typecheck` — expect clean.
- [ ] Step 4: Commit `feat(feedback): add Feedback model`.

## Task 3: Migration + round-trip test

**Files:**
- Create: `backend/src/migrations/20260609000000-create-feedback.js`
- Test: `backend/test/migrations/feedbackMigration.test.ts`

- [ ] Step 1: Write `backend/test/migrations/feedbackMigration.test.ts` (mirror reimbursementsMigration.test.ts): stub households+users tables, require migration, assert `up` creates `feedback` with columns [id, household_id, user_id, category, body, current_path, user_agent, app_version, resolved_at, created_at, updated_at]; assert user_id CASCADE deletes the row; assert `down` drops it.
- [ ] Step 2: Run `yarn workspace cashflow-backend run test 2>&1 | tail -30` — expect FAIL (migration missing).
- [ ] Step 3: Write migration JS (createTable + FKs household_id/user_id CASCADE, index `feedback_user_id_created_at` on `['user_id','created_at']`, index `feedback_household_id`; down removes indexes then dropTable).
- [ ] Step 4: Run test — expect PASS.
- [ ] Step 5: Commit `feat(feedback): add feedback table migration`.

## Task 4: Rate limiter + webhook service

**Files:**
- Create: `backend/src/routes/feedbackRateLimit.ts`, `backend/src/services/feedbackWebhook.ts`

- [ ] Step 1: Write `feedbackRateLimit.ts`:

```ts
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Feedback submissions are user-scoped and flood-prone. Unlike the other
 * limiters in this app we do NOT skip in test, so the rate-limit AC can be
 * verified end-to-end (issue #295 AC#5). Keying by the authenticated user id
 * (always present — the route is behind requireAuth) means only a single
 * user's feedback POSTs share a window, so other integration tests are
 * unaffected.
 */
export const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.FEEDBACK_RATE_LIMIT_MAX ?? 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `feedback:${req.auth?.user.id ?? 'anon'}`,
  // Custom key never derives from IP, so disable the v8 IPv6 key validation.
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => {
    res.status(429).json({ error: 'RATE_LIMITED' });
  },
});
```

- [ ] Step 2: Write `feedbackWebhook.ts`:

```ts
import { logger } from '../observability/logger';
import type { FeedbackCategory } from '../feedback/validate';

export type FeedbackWebhookPayload = {
  id: number;
  category: FeedbackCategory;
  body: string;
  currentPath: string | null;
  appVersion: string | null;
  createdAt: string;
};

/**
 * Fire-and-forget POST to FEEDBACK_WEBHOOK_URL when configured. Sanitized:
 * carries no user PII (no email, no userId) — only the feedback content and
 * context. Never throws; a webhook failure must not affect the user's
 * submission (issue #295 AC#8).
 */
export async function forwardFeedback(payload: FeedbackWebhookPayload): Promise<void> {
  const url = process.env.FEEDBACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'feedback_webhook_non_ok');
    }
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'feedback_webhook_failed');
  }
}
```

- [ ] Step 3: `yarn workspace cashflow-backend run typecheck` — clean.
- [ ] Step 4: Commit `feat(feedback): add per-user rate limiter and sanitized webhook`.

## Task 5: Feedback routes + integration tests

**Files:**
- Create: `backend/src/routes/feedback.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/test/integration/feedback.test.ts`

- [ ] Step 1: Write integration test `backend/test/integration/feedback.test.ts` (mirror reimbursements.test.ts seed/agent setup). Cover: AC#2 POST writes row scoped to user (assert row.userId/householdId, response `{id}`); AC#3 invalid category → 400 INVALID_CATEGORY; AC#4 short→400 BODY_TOO_SHORT, long→400 BODY_TOO_LONG; AC#5 6th POST in window → 429 RATE_LIMITED (uses a dedicated seeded user); AC#6 GET owner-only newest-first + pagination, non-owner (member) → 403; AC#7 resolve sets resolvedAt + owner-only; AC#8 webhook fired on success + failure does not 500 (set FEEDBACK_WEBHOOK_URL to a sink, stub global fetch). NOTE: non-rate-limit tests each seed a fresh user so 5/min headroom holds. Set `process.env.FEEDBACK_RATE_LIMIT_MAX` is NOT raised (keep 5) — keep counts under 5 per user except the dedicated rate-limit test.
- [ ] Step 2: Run `yarn workspace cashflow-backend run test:integration 2>&1 | tail -40` — expect FAIL.
- [ ] Step 3: Write `backend/src/routes/feedback.ts`:
  - `POST /feedback` → `feedbackLimiter` middleware, `validateFeedback`, on invalid `res.status(v.status).json({error:v.error})`, else `Feedback.create({ householdId: auth.household.id, userId: auth.user.id, category, body, currentPath, userAgent: req.headers['user-agent']?.slice(0,512) ?? null, appVersion, resolvedAt: null })`, fire `void forwardFeedback({...})` (no await blocking the response — but await-then-respond is fine too; use `.catch` safety since forwardFeedback never throws), `res.status(201).json({ id })`.
  - `GET /feedback` → owner gate (`if (auth.role !== 'owner' && !isSuperadmin(req)) return 403 {error:'FORBIDDEN'}`), `Feedback.findAll({ where: householdWhere(req), order:[['created_at','DESC']], limit, offset })`, return `{ data, count }` (serialize each row: id, category, body, currentPath, appVersion, createdAt, resolvedAt).
  - `POST /feedback/:id/resolve` → owner gate, `Feedback.findOne({where:{id, ...householdWhere(req)}})`, 404 if none, set `resolvedAt = new Date()`, save, return serialized row.
- [ ] Step 4: Mount in `app.ts` after `requireAuth`: `app.use('/api', feedbackRouter)` near reimbursements; add import.
- [ ] Step 5: Run `yarn workspace cashflow-backend run test:integration 2>&1 | tail -40` — expect PASS.
- [ ] Step 6: Commit `feat(feedback): add feedback routes (create/list/resolve)`.

## Task 6: Frontend FeedbackPanel + FeedbackButton

**Files:**
- Create: `frontend/src/components/feedback/FeedbackPanel.tsx`, `FeedbackButton.tsx`, `FeedbackPanel.test.tsx`, `FeedbackButton.test.tsx`
- Modify: `frontend/src/components/Layout.tsx`

- [ ] Step 1: Write `FeedbackPanel.test.tsx` (vitest): renders category select with 4 options + textarea + Send (AC#10); inline validation for empty (`Tell us a bit more (at least 5 characters).`) and >2000 (`Keep it under 2000 characters.`) before submit (AC#12); submit disables button + shows `Sending…` then success toast `Thanks — we got it.` + closes (AC#11); on error shows toast `Couldn't send. Try again.` and preserves the text (AC#11). Mock `@/lib/api` postJson.
- [ ] Step 2: Run `yarn workspace frontend run test 2>&1 | tail -30` — expect FAIL.
- [ ] Step 3: Write `FeedbackPanel.tsx` (Dialog; category `NativeSelect` Bug/Feature request/This is confusing/Other; `Textarea` required placeholder copy; disclaimer; Send primary + Cancel; posts `{ category, body, currentPath: location.pathname, appVersion: FRONTEND_VERSION }` to `/api/feedback`; on 429 → toast `Slow down — try again in a moment.`). Write `FeedbackButton.tsx` (HelpCircle icon button, aria-label "Help and feedback", opens panel).
- [ ] Step 4: Write `FeedbackButton.test.tsx`: button with name/aria "Help and feedback" opens panel (panel title "Send us feedback" appears) (AC#9).
- [ ] Step 5: Mount `<FeedbackButton />` in `Layout.tsx` `.topBar__right` before `<NotificationBell />`.
- [ ] Step 6: Run `yarn workspace frontend run test` (panel+button) — expect PASS.
- [ ] Step 7: Commit `feat(feedback): add Help button and feedback panel`.

## Task 7: Feedback inbox settings tab

**Files:**
- Create: `frontend/src/pages/settings/tabs/FeedbackInboxTab.tsx`, `FeedbackInboxTab.test.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/pages/settings/SettingsPage.tsx`

- [ ] Step 1: Write `FeedbackInboxTab.test.tsx`: lists rows newest-first with a `Mark resolved` action that POSTs `/api/feedback/:id/resolve` (AC#13); empty state `No feedback yet.`. Mock useAuth owner + api.
- [ ] Step 2: Run `yarn workspace frontend run test 2>&1 | tail -30` — expect FAIL.
- [ ] Step 3: Write `FeedbackInboxTab.tsx` (heading `Feedback inbox`; GET `/api/feedback`; Card per row showing category badge + body + relative time + resolved badge; `Mark resolved` button when unresolved → postJson resolve then reload; empty state).
- [ ] Step 4: Add `<Route path="feedback" element={<FeedbackInboxTab />} />` under settings in `App.tsx`; add `{ value:'feedback', label:'Feedback', ownerOnly:true }` to `ALL_TOP_TABS`, `feedback: '/settings/feedback'` to `TOP_TAB_PATHS`, and an `ownerOnly` filter (`!t.ownerOnly || isOwner`) where `isOwner = auth.user?.household?.role === 'owner'`) in `SettingsPage.tsx`.
- [ ] Step 5: Run `yarn workspace frontend run test` (tab) — expect PASS.
- [ ] Step 6: Commit `feat(feedback): add owner-only Feedback inbox settings tab`.

## Task 8: Full verification

- [ ] `yarn workspace cashflow-backend run test` (unit + migration)
- [ ] `yarn workspace cashflow-backend run test:integration`
- [ ] `yarn workspace cashflow-backend run typecheck`
- [ ] `yarn workspace frontend run tsc -b`
- [ ] `yarn workspace cashflow-backend run lint`
- [ ] `yarn workspace frontend run lint`
- [ ] Open PR with AC→test mapping; enable auto-merge.

## AC → test mapping

| AC | Test |
| --- | --- |
| 1 migration + index reversible | feedbackMigration.test.ts |
| 2 POST writes user-scoped row | integration "writes a row scoped to the current user" |
| 3 invalid category 400 INVALID_CATEGORY | validate unit + integration |
| 4 body too short/long | validate unit + integration |
| 5 6th in 60s → 429 RATE_LIMITED | integration "rate limits the 6th submission" |
| 6 GET owner-only, non-owner 403 | integration "GET is owner-only" |
| 7 resolve sets resolvedAt, owner-only | integration "resolve" |
| 8 webhook on success, failure non-blocking | integration "webhook" |
| 9 TopBar Help button opens panel | FeedbackButton.test.tsx |
| 10 panel category select + textarea + submit | FeedbackPanel.test.tsx |
| 11 in-flight + success/error toast + text preserved | FeedbackPanel.test.tsx |
| 12 inline validation empty/too-long | FeedbackPanel.test.tsx |
| 13 inbox newest-first + resolve | FeedbackInboxTab.test.tsx |

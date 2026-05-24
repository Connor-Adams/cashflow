# AI Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing AI features discoverable by promoting the Dashboard insights tile and adding an AI Inbox surfaced via a sidebar nav item. Zero new AI capability — surfacing only.

**Architecture:** Two coordinated changes over the existing `ai_suggestions` table. Backend: 3 new endpoints (`/api/ai/inbox`, `/api/ai/inbox/count`, dismiss for rule proposals), insights deduplication via `superseded`, extension to `findRuleProposals` to filter dismissed patterns. Frontend: SeverityBadge + tile promotion + clickable transactions on the existing DashboardPage insights tile; AiInboxBadge in the Sidebar nav; AiInboxPage at `/ai/inbox` with three kind-discriminated renderers.

**Tech Stack:** Backend: Express, Sequelize (SQLite), `node:test` + `supertest`. Frontend: React 19, Vite, Vitest, React Router, Tailwind via existing `<Badge>`/`<Button>` primitives.

**Reference spec:** [docs/superpowers/specs/2026-05-23-ai-surfacing-design.md](docs/superpowers/specs/2026-05-23-ai-surfacing-design.md)

---

## File structure

### Backend
- **Modify** `backend/src/routes/ai.ts` — add 3 endpoints (`inbox`, `inbox/count`, rule-proposal `dismiss`), modify `insights` route for supersede pass
- **Modify** `backend/src/ai/ruleProposals.ts` — extend `findRuleProposals` to exclude dismissed patterns
- **Modify** `backend/src/routes/transactions.ts` — accept `?ids=` query param on the list endpoint
- **Create** `backend/test/aiInbox.test.ts` — unit tests for inbox helpers (summary builders)
- **Create** `backend/test/integration/aiInbox.test.ts` — integration tests for inbox endpoints + dismiss + supersede + ids filter

### Frontend
- **Create** `frontend/src/components/ai/SeverityBadge.tsx` — severity → Badge variant mapping
- **Create** `frontend/src/components/ai/AiInboxBadge.tsx` — sidebar nav item with count chip
- **Create** `frontend/src/hooks/useAiInboxCount.ts` — count hook with focus/interval polling
- **Create** `frontend/src/hooks/useInsightsSeen.ts` — localStorage unread state for Dashboard insights
- **Create** `frontend/src/pages/AiInboxPage.tsx` — inbox page with segmented tabs + item renderers
- **Modify** `frontend/src/pages/DashboardPage.tsx` — sort by severity, SeverityBadge, clickable IDs, "Open these transactions" button, action-severity promotion banner + tile span, unread dots
- **Modify** `frontend/src/pages/TransactionsPage.tsx` — read `?ids=` from URL and pass to backend
- **Modify** `frontend/src/components/Sidebar.tsx` — add AI Inbox nav item with badge
- **Modify** `frontend/src/App.tsx` — register `/ai/inbox` route
- **Create** `frontend/src/components/ai/SeverityBadge.test.tsx`
- **Create** `frontend/src/hooks/useInsightsSeen.test.ts`
- **Create** `frontend/src/hooks/useAiInboxCount.test.ts`
- **Create** `frontend/src/pages/AiInboxPage.test.tsx`

---

## Conventions

- **Backend tests**: `node:test` + `node:assert/strict`. Integration tests follow `backend/test/integration/*.test.ts` pattern (own SQLite db, register a household, use `supertest.agent`).
- **Frontend tests**: vitest + jsdom. For components: `renderToStaticMarkup` for static snapshots; `createRoot` + `act` for interactive.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`). One commit per task at minimum; split if a task has independent units.
- **No-skipping-hooks**: pre-commit runs lint-staged. Don't pass `--no-verify`.

---

## Task 1: Backend `GET /api/ai/inbox/count`

**Files:**
- Modify: `backend/src/routes/ai.ts` (insert new route before `export default router` at the bottom)
- Create: `backend/test/integration/aiInbox.test.ts`

This task ships the smallest useful endpoint: a count-only response the sidebar badge can poll cheaply. Establishes the test harness for subsequent inbox work.

- [ ] **Step 1: Create the integration test file with the count endpoint test**

Create `backend/test/integration/aiInbox.test.ts`:

```typescript
/**
 * Integration tests for /api/ai/inbox*. Runs in isolation (`yarn test:integration`)
 * so DATABASE_PATH is set before any Sequelize import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-ai-inbox.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'inbox@example.com',
    displayName: 'Inbox User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  householdId = register.body.user.householdId as number;
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('GET /api/ai/inbox/count returns zeros when nothing pending', async () => {
  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    total: 0,
    byKind: { transaction_audit: 0, financial_insight: 0, rule_proposal: 0 },
  });
});

test('GET /api/ai/inbox/count counts only suggested rows in the three kinds', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-05', currency: 'CAD' },
    output: [{ title: 'Dining up 18%', severity: 'action' }],
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {}, output: { issues: [{ id: 1 }] },
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'superseded',
    inputSnapshot: {}, output: [],
  } as never);

  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.byKind.financial_insight, 1);
  assert.equal(r.body.byKind.transaction_audit, 1);
  assert.equal(r.body.byKind.rule_proposal, 0);
});

test('GET /api/ai/inbox/count scopes by household', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId: 99999, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: {}, output: [],
  } as never);
  const r = await authed.get('/api/ai/inbox/count');
  assert.equal(r.status, 200);
  assert.equal(r.body.byKind.financial_insight, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/ai/inbox/count"`
Expected: tests fail with 404 (route does not exist).

- [ ] **Step 3: Implement the count endpoint**

Edit `backend/src/routes/ai.ts`. Add this new route immediately before `export default router;`:

```typescript
router.get('/inbox/count', async (req, res, next) => {
  try {
    const where = { ...aiSuggestionWhere(req), status: 'suggested' as const };
    const [auditCount, insightCount, ruleProposals] = await Promise.all([
      AiSuggestion.count({ where: { ...where, kind: 'transaction_audit' } }),
      AiSuggestion.count({ where: { ...where, kind: 'financial_insight' } }),
      findRuleProposals(isSuperadmin(req) ? null : currentAuth(req).household.id),
    ]);
    const ruleProposalCount = ruleProposals.length;
    res.json({
      total: auditCount + insightCount + ruleProposalCount,
      byKind: {
        transaction_audit: auditCount,
        financial_insight: insightCount,
        rule_proposal: ruleProposalCount,
      },
    });
  } catch (e) {
    next(e);
  }
});
```

(`findRuleProposals`, `aiSuggestionWhere`, `AiSuggestion`, `isSuperadmin`, `currentAuth` are already imported at the top of this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/ai/inbox/count"`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/ai.ts backend/test/integration/aiInbox.test.ts
git commit -m "feat(ai): add /api/ai/inbox/count endpoint for sidebar badge"
```

---

## Task 2: Backend `GET /api/ai/inbox` (audit + insight streams)

**Files:**
- Modify: `backend/src/routes/ai.ts` (add `/inbox` route)
- Modify: `backend/test/integration/aiInbox.test.ts` (extend with list tests)

This task adds the list endpoint for the two persisted streams. Rule proposals are added in Task 3.

- [ ] **Step 1: Add failing tests for the list endpoint**

Append to `backend/test/integration/aiInbox.test.ts`:

```typescript
test('GET /api/ai/inbox returns audit + insight suggested rows newest first', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  const olderInsight = await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-04', currency: 'CAD' },
    output: [{ title: 'Older insight', severity: 'info', supportingTransactionIds: [] }],
  } as never);
  const newerAudit = await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_audit', status: 'suggested',
    inputSnapshot: {},
    output: { issues: [{ id: 7, suggestedCategory: 'Dining', confidence: 'high' }, { id: 8 }] },
  } as never);

  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const items = r.body.items as Array<{ id: number; kind: string; summary: string }>;
  const ids = items.map((i) => i.id);
  assert.ok(ids.indexOf(newerAudit.id) < ids.indexOf(olderInsight.id), 'newer first');
  const audit = items.find((i) => i.id === newerAudit.id);
  assert.ok(audit);
  assert.equal(audit.kind, 'transaction_audit');
  assert.match(audit.summary, /2 issue/);
});

test('GET /api/ai/inbox excludes non-suggested status and other kinds', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId, userId: null, kind: 'financial_insight', status: 'rejected',
    inputSnapshot: {}, output: [],
  } as never);
  await AiSuggestion.create({
    householdId, userId: null, kind: 'transaction_fields', status: 'suggested',
    inputSnapshot: {}, output: {},
  } as never);
  const r = await authed.get('/api/ai/inbox');
  assert.equal(r.status, 200);
  const kinds = (r.body.items as Array<{ kind: string }>).map((i) => i.kind);
  assert.ok(!kinds.includes('transaction_fields'));
  assert.ok(!(r.body.items as Array<{ status?: string }>).some((i) => i.status === 'rejected'));
});

test('GET /api/ai/inbox scopes by household', async () => {
  const { AiSuggestion } = await import('../../src/models/index.js');
  await AiSuggestion.create({
    householdId: 99999, userId: null, kind: 'financial_insight', status: 'suggested',
    inputSnapshot: { period: '2026-05', currency: 'CAD' },
    output: [{ title: 'Other household' }],
  } as never);
  const r = await authed.get('/api/ai/inbox');
  const titles = (r.body.items as Array<{ summary: string }>).map((i) => i.summary);
  assert.ok(!titles.some((t) => t.includes('Other household')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/ai/inbox "`
Expected: tests fail with 404 / undefined `items`.

- [ ] **Step 3: Implement the list endpoint with per-kind summary helpers**

Edit `backend/src/routes/ai.ts`. Add this new route immediately before `router.get('/inbox/count', ...)`:

```typescript
type InboxItem = {
  id: number;
  kind: 'transaction_audit' | 'financial_insight' | 'rule_proposal';
  createdAt: string;
  transactionId: number | null;
  summary: string;
  severity: 'action' | 'watch' | 'info' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  output: unknown;
};

function summarizeAudit(output: unknown): string {
  const issues = (output as { issues?: unknown[] } | null)?.issues;
  const count = Array.isArray(issues) ? issues.length : 0;
  return count === 1 ? '1 issue found' : `${count} issues found`;
}

function summarizeInsight(output: unknown): { summary: string; severity: 'action' | 'watch' | 'info' | null } {
  const arr = Array.isArray(output) ? (output as Array<{ title?: unknown; severity?: unknown }>) : [];
  if (arr.length === 0) return { summary: 'No insights', severity: null };
  const first = arr[0];
  const title = typeof first?.title === 'string' ? first.title : 'Insight';
  const sev = first?.severity === 'action' || first?.severity === 'watch' || first?.severity === 'info'
    ? first.severity
    : null;
  const more = arr.length > 1 ? ` (+${arr.length - 1} more)` : '';
  return { summary: `${title}${more}`, severity: sev };
}

router.get('/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = { ...aiSuggestionWhere(req), status: 'suggested' as const };
    const rows = await AiSuggestion.findAll({
      where: { ...where, kind: ['transaction_audit', 'financial_insight'] },
      order: [['id', 'DESC']],
      limit,
    });
    const items: InboxItem[] = rows.map((row) => {
      if (row.kind === 'transaction_audit') {
        return {
          id: row.id,
          kind: 'transaction_audit',
          createdAt: row.createdAt.toISOString(),
          transactionId: row.transactionId,
          summary: summarizeAudit(row.output),
          severity: null,
          confidence: null,
          output: row.output,
        };
      }
      const { summary, severity } = summarizeInsight(row.output);
      return {
        id: row.id,
        kind: 'financial_insight',
        createdAt: row.createdAt.toISOString(),
        transactionId: row.transactionId,
        summary,
        severity,
        confidence: null,
        output: row.output,
      };
    });
    res.json({ items });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/ai/inbox "`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/ai.ts backend/test/integration/aiInbox.test.ts
git commit -m "feat(ai): add /api/ai/inbox list endpoint for audit + insight streams"
```

---

## Task 3: Rule proposal dismissal + inbox integration

**Files:**
- Modify: `backend/src/ai/ruleProposals.ts` (extend `findRuleProposals` to exclude dismissed)
- Modify: `backend/src/routes/ai.ts` (add `POST /api/ai/rule-proposals/:merchantPattern/dismiss` + include rule_proposal in inbox + count)
- Modify: `backend/test/integration/aiInbox.test.ts` (rule proposal tests)

- [ ] **Step 1: Add failing tests**

Append to `backend/test/integration/aiInbox.test.ts`:

```typescript
test('GET /api/ai/inbox includes rule_proposal items computed from transactions', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const account = await Account.create({
    householdId, name: 'Inbox Test', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId, accountId: account.id, currency: 'CAD',
      date: `2026-05-0${i + 1}`,
      merchantClean: 'INBOX SHOP', amount: -10,
      finalCategory: 'Groceries', finalBusiness: false, finalSplitType: 'me',
      reviewedAt: new Date(),
    } as never);
  }
  const r = await authed.get('/api/ai/inbox');
  const ruleItems = (r.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal');
  assert.ok(ruleItems.length >= 1);
  assert.match(ruleItems[0].summary, /INBOX SHOP/);
});

test('POST /api/ai/rule-proposals/:pattern/dismiss persists rejection', async () => {
  const r = await authed.post('/api/ai/rule-proposals/INBOX%20SHOP/dismiss');
  assert.equal(r.status, 201);
  const { AiSuggestion } = await import('../../src/models/index.js');
  const stored = await AiSuggestion.findOne({
    where: { householdId, kind: 'rule_proposal', status: 'rejected' },
  });
  assert.ok(stored);
  assert.deepEqual(stored.inputSnapshot, { merchantPattern: 'INBOX SHOP' });
});

test('GET /api/ai/inbox excludes dismissed rule proposals', async () => {
  const r = await authed.get('/api/ai/inbox');
  const ruleItems = (r.body.items as Array<{ kind: string; summary: string }>)
    .filter((i) => i.kind === 'rule_proposal');
  assert.ok(!ruleItems.some((i) => i.summary.includes('INBOX SHOP')));
});

test('GET /api/ai/inbox/count includes non-dismissed rule proposals', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const account = await Account.create({
    householdId, name: 'Inbox Test 2', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  for (let i = 0; i < 3; i += 1) {
    await Transaction.create({
      householdId, accountId: account.id, currency: 'CAD',
      date: `2026-05-1${i}`,
      merchantClean: 'COUNT ME', amount: -8,
      finalCategory: 'Coffee', finalBusiness: false, finalSplitType: 'me',
      reviewedAt: new Date(),
    } as never);
  }
  const r = await authed.get('/api/ai/inbox/count');
  assert.ok(r.body.byKind.rule_proposal >= 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace backend test:integration --test-name-pattern "rule_proposal|rule-proposal"`
Expected: 4 failures (no `rule_proposal` items returned; dismiss endpoint 404).

- [ ] **Step 3: Extend `findRuleProposals` to exclude dismissed patterns**

Edit `backend/src/ai/ruleProposals.ts`. Replace the body of `findRuleProposals` with:

```typescript
export async function findRuleProposals(householdId: number | null): Promise<RuleProposal[]> {
  const rows = await sequelize.query<RuleProposalRow>(
    `SELECT merchant_clean AS "merchantClean",
            final_category AS category,
            final_business AS "isBusiness",
            final_split_type AS "splitType",
            final_pct_me AS "pctMe",
            final_pct_partner AS "pctPartner",
            COUNT(*) AS "supportCount",
            GROUP_CONCAT(id) AS "exampleIds"
     FROM transactions
     WHERE (? IS NULL OR household_id = ?)
       AND reviewed_at IS NOT NULL
       AND final_category IS NOT NULL
       AND TRIM(merchant_clean) != ''
     GROUP BY merchant_clean, final_category, final_business, final_split_type, final_pct_me, final_pct_partner
     HAVING COUNT(*) >= 3
     ORDER BY COUNT(*) DESC, merchant_clean ASC
     LIMIT 20`,
    { replacements: [householdId, householdId], type: QueryTypes.SELECT },
  );
  const [existingRules, dismissed] = await Promise.all([
    Rule.findAll({
      where: householdId == null ? undefined : { householdId },
      attributes: ['merchantPattern'],
      raw: true,
    }),
    sequelize.query<{ pattern: string }>(
      `SELECT json_extract(input_snapshot, '$.merchantPattern') AS pattern
         FROM ai_suggestions
        WHERE kind = 'rule_proposal'
          AND status = 'rejected'
          AND (? IS NULL OR household_id = ?)`,
      { replacements: [householdId, householdId], type: QueryTypes.SELECT },
    ),
  ]);
  const existing = new Set(
    existingRules.map((r) => String(r.merchantPattern).trim().toLowerCase()),
  );
  const rejected = new Set(
    dismissed
      .map((r) => (r.pattern || '').trim().toLowerCase())
      .filter((p) => p.length > 0),
  );
  return rows
    .map(ruleProposalFromRow)
    .filter((p) => !existing.has(p.merchantPattern.toLowerCase()))
    .filter((p) => !rejected.has(p.merchantPattern.toLowerCase()));
}
```

- [ ] **Step 4: Add the dismiss endpoint and extend the inbox + count to include rule_proposal**

Edit `backend/src/routes/ai.ts`.

(a) Add dismiss route immediately after the existing `router.post('/rule-proposals/:merchantPattern/approve', ...)`:

```typescript
router.post('/rule-proposals/:merchantPattern/dismiss', async (req, res, next) => {
  try {
    const merchantPattern = decodeURIComponent(req.params.merchantPattern).trim();
    if (!merchantPattern) {
      res.status(400).json({ error: 'merchantPattern is required' });
      return;
    }
    const row = await createTrackedSuggestion({
      req,
      kind: 'rule_proposal',
      inputSnapshot: { merchantPattern },
      output: null,
      status: 'suggested',
      model: 'deterministic',
      promptVersion: 'rule-proposal-dismiss-v1',
    });
    await row.update({ status: 'rejected' });
    res.status(201).json({ ok: true, id: row.id });
  } catch (e) {
    next(e);
  }
});
```

(b) Extend the `router.get('/inbox', ...)` handler. Replace its current implementation entirely with:

```typescript
router.get('/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = { ...aiSuggestionWhere(req), status: 'suggested' as const };
    const [rows, ruleProposals] = await Promise.all([
      AiSuggestion.findAll({
        where: { ...where, kind: ['transaction_audit', 'financial_insight'] },
        order: [['id', 'DESC']],
        limit,
      }),
      findRuleProposals(isSuperadmin(req) ? null : currentAuth(req).household.id),
    ]);
    const persistedItems: InboxItem[] = rows.map((row) => {
      if (row.kind === 'transaction_audit') {
        return {
          id: row.id,
          kind: 'transaction_audit',
          createdAt: row.createdAt.toISOString(),
          transactionId: row.transactionId,
          summary: summarizeAudit(row.output),
          severity: null,
          confidence: null,
          output: row.output,
        };
      }
      const { summary, severity } = summarizeInsight(row.output);
      return {
        id: row.id,
        kind: 'financial_insight',
        createdAt: row.createdAt.toISOString(),
        transactionId: row.transactionId,
        summary,
        severity,
        confidence: null,
        output: row.output,
      };
    });
    const proposalItems: InboxItem[] = ruleProposals.map((p, idx) => ({
      id: -1 - idx,
      kind: 'rule_proposal',
      createdAt: new Date().toISOString(),
      transactionId: null,
      summary: `${p.merchantPattern} → ${p.category ?? '(no category)'} (×${p.supportCount})`,
      severity: null,
      confidence: null,
      output: p,
    }));
    res.json({ items: [...persistedItems, ...proposalItems] });
  } catch (e) {
    next(e);
  }
});
```

(c) The `/inbox/count` route already calls `findRuleProposals` from Task 1, so it picks up the dismissal exclusion automatically. No change needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn workspace backend test:integration --test-name-pattern "rule_proposal|rule-proposal|inbox"`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/ai.ts backend/src/ai/ruleProposals.ts backend/test/integration/aiInbox.test.ts
git commit -m "feat(ai): add rule-proposal dismissal + inbox integration"
```

---

## Task 4: Insights deduplication via supersede pass

**Files:**
- Modify: `backend/src/routes/ai.ts` (insights route — supersede before insert)
- Modify: `backend/test/integration/aiInbox.test.ts` (dedup test)

- [ ] **Step 1: Add a failing test**

Append to `backend/test/integration/aiInbox.test.ts`:

```typescript
test('POST /api/ai/insights supersedes prior suggested rows for same period+currency', async () => {
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');

  const { AiSuggestion } = await import('../../src/models/index.js');
  const suggested = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'suggested' },
  });
  const for2026_03_CAD = suggested.filter((row) => {
    const snap = row.inputSnapshot as { period?: string; currency?: string };
    return snap?.period === '2026-03' && snap?.currency === 'CAD';
  });
  assert.equal(for2026_03_CAD.length, 1, 'exactly one suggested row per (period, currency)');

  const superseded = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'superseded' },
  });
  const supersededFor2026_03 = superseded.filter((row) => {
    const snap = row.inputSnapshot as { period?: string; currency?: string };
    return snap?.period === '2026-03' && snap?.currency === 'CAD';
  });
  assert.equal(supersededFor2026_03.length, 2, 'two superseded rows from earlier loads');
});

test('POST /api/ai/insights does not supersede rows for a different period', async () => {
  await authed.get('/api/ai/insights?period=2026-02&currency=CAD');
  await authed.get('/api/ai/insights?period=2026-03&currency=CAD');

  const { AiSuggestion } = await import('../../src/models/index.js');
  const feb = await AiSuggestion.findAll({
    where: { householdId, kind: 'financial_insight', status: 'suggested' },
  });
  const stillSuggestedFeb = feb.filter((row) => {
    const snap = row.inputSnapshot as { period?: string };
    return snap?.period === '2026-02';
  });
  assert.equal(stillSuggestedFeb.length, 1, 'Feb row was not superseded by Mar refresh');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace backend test:integration --test-name-pattern "supersedes prior|does not supersede"`
Expected: first test fails with `actual: 3, expected: 1`.

- [ ] **Step 3: Implement the supersede pass**

Edit `backend/src/routes/ai.ts`. Replace the existing `router.get('/insights', ...)` body with:

```typescript
router.get('/insights', async (req, res, next) => {
  try {
    const period = String(req.query.period || new Date().toISOString().slice(0, 7));
    const currency = String(req.query.currency || 'CAD').toUpperCase().slice(0, 3);
    const dateFrom =
      typeof req.query.dateFrom === 'string' && req.query.dateFrom.trim()
        ? req.query.dateFrom.trim()
        : null;
    const dateTo =
      typeof req.query.dateTo === 'string' && req.query.dateTo.trim()
        ? req.query.dateTo.trim()
        : null;
    const hasExplicitRange =
      Object.prototype.hasOwnProperty.call(req.query, 'dateFrom') ||
      Object.prototype.hasOwnProperty.call(req.query, 'dateTo');
    const out = await buildFinancialInsights(
      req,
      period,
      currency,
      hasExplicitRange ? { from: dateFrom, to: dateTo } : undefined,
    );

    await AiSuggestion.update(
      { status: 'superseded' },
      {
        where: {
          ...aiSuggestionWhere(req),
          kind: 'financial_insight',
          status: 'suggested',
          [Op.and]: [
            sequelize.literal(`json_extract(input_snapshot, '$.period') = ${sequelize.escape(out.period)}`),
            sequelize.literal(`json_extract(input_snapshot, '$.currency') = ${sequelize.escape(currency)}`),
          ],
        },
      },
    );

    await createTrackedSuggestion({
      req,
      kind: 'financial_insight',
      inputSnapshot: { period: out.period, currency },
      output: out.insights,
      model: 'deterministic',
      promptVersion: 'financial-insights-v1',
      temperature: null,
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});
```

Add the missing imports at the top of `backend/src/routes/ai.ts` (extend existing import lines):

```typescript
import { Op, QueryTypes } from 'sequelize';
```

(`QueryTypes` is already imported; ensure `Op` is added to the same import.) Also add `sequelize` to the existing import from `'../models'` if not present:

```typescript
import { AiSuggestion, Rule, Transaction, sequelize } from '../models';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace backend test:integration --test-name-pattern "supersedes prior|does not supersede"`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/ai.ts backend/test/integration/aiInbox.test.ts
git commit -m "feat(ai): supersede prior insight rows for same period+currency"
```

---

## Task 5: TransactionsPage `?ids=` query param filter

**Files:**
- Modify: `backend/src/routes/transactions.ts` (accept `ids` param on list endpoint)
- Modify: `frontend/src/pages/TransactionsPage.tsx` (read `ids` from URL + pass to backend)
- Modify: `backend/test/integration/aiInbox.test.ts` (backend filter test)

Frontend tests for the filter are covered indirectly by Tasks 8 and 10. Backend gets the test.

- [ ] **Step 1: Add a failing backend test**

Append to `backend/test/integration/aiInbox.test.ts`:

```typescript
test('GET /api/transactions?ids=1,2 filters to listed ids', async () => {
  const { Transaction, Account } = await import('../../src/models/index.js');
  const account = await Account.create({
    householdId, name: 'IDs Account', owner: 'me', defaultCurrency: 'CAD',
  } as never);
  const a = await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-01', merchantClean: 'A', amount: -1,
    finalCategory: 'X', finalBusiness: false, finalSplitType: 'me',
  } as never);
  const b = await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-02', merchantClean: 'B', amount: -2,
    finalCategory: 'Y', finalBusiness: false, finalSplitType: 'me',
  } as never);
  await Transaction.create({
    householdId, accountId: account.id, currency: 'CAD',
    date: '2026-05-03', merchantClean: 'C', amount: -3,
    finalCategory: 'Z', finalBusiness: false, finalSplitType: 'me',
  } as never);

  const r = await authed.get(`/api/transactions?ids=${a.id},${b.id}`);
  assert.equal(r.status, 200);
  const ids = (r.body.data as Array<{ id: number }>).map((t) => t.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test('GET /api/transactions?ids= ignores empty/invalid entries gracefully', async () => {
  const r = await authed.get('/api/transactions?ids=abc,,999999');
  assert.equal(r.status, 200);
  assert.equal((r.body.data as unknown[]).length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/transactions\\?ids"`
Expected: tests fail (no `ids` filter; returns all transactions).

- [ ] **Step 3: Add `ids` filter to `buildTransactionFilterWhere`**

The list endpoint at `router.get('/', ...)` (line 401) and the bulk-patch-filter endpoint (line 297) both call `buildTransactionFilterWhere(req, source)` defined at `backend/src/routes/transactions.ts:60-86`. Adding the filter here covers both.

Edit `backend/src/routes/transactions.ts`. Find the `buildTransactionFilterWhere` function. Just before the closing `return where;`, add:

```typescript
if (typeof source.ids === 'string' && source.ids.length > 0) {
  const ids = source.ids
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  where.id = ids.length === 0 ? -1 : ids;
}
```

(`source` is `Record<string, unknown>` so `source.ids` is `unknown` — the `typeof === 'string'` narrows it. Setting `where.id = -1` for an empty-after-filtering list ensures `?ids=abc` returns `[]` rather than the whole list. Sequelize converts an array `where.id = [1,2]` to `IN (1, 2)`.)

The GET handler at line 401 calls `buildTransactionFilterWhere(req, req.query)` — confirm this is the call site that needs to pass `ids`. Read line 401-420 to verify:

Run: `sed -n '401,420p' backend/src/routes/transactions.ts`

If the GET handler passes `req.query` directly (which it should based on the pattern), no further change is needed — `req.query.ids` is now picked up automatically.

- [ ] **Step 4: Run the backend tests to verify they pass**

Run: `yarn workspace backend test:integration --test-name-pattern "GET /api/transactions\\?ids"`
Expected: both pass.

- [ ] **Step 5: Update the frontend to send `ids` when present in the URL**

Edit `frontend/src/pages/TransactionsPage.tsx`. Find the block around line 185-190 where URL params are read:

```typescript
const urlCategory = searchParams.get('category')
const urlCurrency = searchParams.get('currency')
const urlDateFrom = searchParams.get('dateFrom')
const urlDateTo = searchParams.get('dateTo')
const urlImportBatch = searchParams.get('importBatch')
const urlReviewFlag = searchParams.get('reviewFlag')
```

Add an additional line:

```typescript
const urlIds = searchParams.get('ids')
```

Then find the block around line 241-250 where the `URLSearchParams` is built to call `/api/transactions`. Add immediately before the existing `if (reviewOnly) qs.set('reviewFlag', 'true')` line:

```typescript
if (urlIds && urlIds.trim()) qs.set('ids', urlIds.trim())
```

Add `urlIds` to the `useEffect` dependency array that triggers the fetch (the same effect that already depends on `searchParams`). If `searchParams` is in the deps, `urlIds` is implicitly tracked — no change needed.

- [ ] **Step 6: Smoke check the frontend build**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`
Expected: lint clean, all existing frontend tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/transactions.ts frontend/src/pages/TransactionsPage.tsx backend/test/integration/aiInbox.test.ts
git commit -m "feat(transactions): add ?ids= filter on list endpoint for AI insight links"
```

---

## Task 6: SeverityBadge component + Dashboard tile severity sort

**Files:**
- Create: `frontend/src/components/ai/SeverityBadge.tsx`
- Create: `frontend/src/components/ai/SeverityBadge.test.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx` (sort + use badge)

- [ ] **Step 1: Write a failing test for SeverityBadge**

Create `frontend/src/components/ai/SeverityBadge.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SeverityBadge } from './SeverityBadge'

describe('SeverityBadge', () => {
  it('renders action severity with destructive variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="action" />)
    expect(html).toContain('action')
    expect(html.toLowerCase()).toContain('destructive')
  })

  it('renders watch severity with secondary variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="watch" />)
    expect(html).toContain('watch')
    expect(html.toLowerCase()).toMatch(/secondary|muted/)
  })

  it('renders info severity with outline variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="info" />)
    expect(html).toContain('info')
    expect(html.toLowerCase()).toContain('outline')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace frontend test --run src/components/ai/SeverityBadge.test.tsx`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement SeverityBadge**

Create `frontend/src/components/ai/SeverityBadge.tsx`:

```typescript
import { Badge } from '@/components/ui/badge'

export type InsightSeverity = 'action' | 'watch' | 'info'

const VARIANT_BY_SEVERITY: Record<InsightSeverity, 'destructive' | 'secondary' | 'outline'> = {
  action: 'destructive',
  watch: 'secondary',
  info: 'outline',
}

export function SeverityBadge({ severity }: { severity: InsightSeverity }) {
  return <Badge variant={VARIANT_BY_SEVERITY[severity]}>{severity}</Badge>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn workspace frontend test --run src/components/ai/SeverityBadge.test.tsx`
Expected: 3 tests pass.

- [ ] **Step 5: Wire the sort + badge into DashboardPage**

Edit `frontend/src/pages/DashboardPage.tsx`. Add the import near the other component imports at the top:

```typescript
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
```

Find the `aiInsights.insights.map((insight) => ...)` block (around line 1324). Replace it with a sort-then-map:

```typescript
[...aiInsights.insights]
  .sort((a, b) => {
    const order: Record<string, number> = { action: 0, watch: 1, info: 2 }
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  })
  .map((insight) => (
    <article key={`${insight.metric}-${insight.title}`} className="aiVisibilityItem">
      <div className="aiVisibilityItemHeader">
        <strong>{insight.title}</strong>
        <SeverityBadge severity={insight.severity as InsightSeverity} />
      </div>
      <p>{insight.summary}</p>
      <p className="muted">
        {insight.comparison} · {formatDashboardAmount(insight.amount)}
      </p>
      {insight.supportingTransactionIds.length > 0 ? (
        <p className="muted">
          Transactions: #{insight.supportingTransactionIds.join(', #')}
        </p>
      ) : null}
      <p className="muted">{insight.suggestedAction}</p>
    </article>
  ))
```

(The only changes from the current source: wrap in `[...].sort(...)`, replace `<span className="muted">{insight.severity}</span>` with `<SeverityBadge ...>`. Clickable IDs come in Task 7.)

- [ ] **Step 6: Smoke check**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`
Expected: lint clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ai/SeverityBadge.tsx frontend/src/components/ai/SeverityBadge.test.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat(dashboard): sort AI insights by severity with colored Badge"
```

---

## Task 7: Clickable supporting txn IDs + "Open these transactions" button

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`

This depends on Task 5 (the `?ids=` filter must exist on TransactionsPage).

- [ ] **Step 1: Add the Link import to DashboardPage**

Edit `frontend/src/pages/DashboardPage.tsx`. Find the existing `react-router-dom` import line near the top:

```typescript
import { Link } from 'react-router-dom'
```

(If `Link` is already imported, no change needed. If `react-router-dom` is imported but without `Link`, add it to the named imports.)

- [ ] **Step 2: Replace supporting-IDs text block with Links + add "Open these transactions" button**

In the insight render (the same `.map((insight) => ...)` you edited in Task 6), replace the supporting-transactions paragraph block:

```typescript
{insight.supportingTransactionIds.length > 0 ? (
  <p className="muted">
    Transactions: #{insight.supportingTransactionIds.join(', #')}
  </p>
) : null}
<p className="muted">{insight.suggestedAction}</p>
```

with:

```typescript
{insight.supportingTransactionIds.length > 0 ? (
  <p className="muted aiVisibilitySupportingIds">
    Transactions:{' '}
    {insight.supportingTransactionIds.map((id, idx) => (
      <span key={id}>
        {idx > 0 ? ', ' : null}
        <Link to={`/transactions?ids=${id}`}>#{id}</Link>
      </span>
    ))}
  </p>
) : null}
<p className="muted">{insight.suggestedAction}</p>
{insight.supportingTransactionIds.length > 0 ? (
  <Link
    to={`/transactions?ids=${insight.supportingTransactionIds.join(',')}`}
    className="aiVisibilityAction"
  >
    Open these transactions
  </Link>
) : null}
```

- [ ] **Step 3: Smoke check**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`
Expected: lint clean, all tests pass.

- [ ] **Step 4: Manual verification (browser)**

Start dev servers and confirm:
- Visit `/` (Dashboard). The AI insights tile shows transaction IDs as clickable links.
- Click any `#123` link → navigates to `/transactions?ids=123` and the list shows only that transaction.
- Click "Open these transactions" → navigates to `/transactions?ids=<csv>` and shows the full set.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit -m "feat(dashboard): clickable supporting txn IDs + Open these transactions link"
```

---

## Task 8: Action-severity promotion banner + tile span + unread state

**Files:**
- Create: `frontend/src/hooks/useInsightsSeen.ts`
- Create: `frontend/src/hooks/useInsightsSeen.test.ts`
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Write a failing test for `useInsightsSeen`**

This codebase doesn't use `@testing-library/react`. Tests use React 19's native `act` + `createRoot` (pattern in `frontend/src/components/ui/localPrimitives.test.tsx`).

Create `frontend/src/hooks/useInsightsSeen.test.tsx`:

```typescript
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useInsightsSeen } from './useInsightsSeen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type HookValue = ReturnType<typeof useInsightsSeen>

function Probe({
  userId,
  onMount,
}: {
  userId: string
  onMount: (v: HookValue) => void
}) {
  const v = useInsightsSeen(userId)
  useEffect(() => {
    onMount(v)
  })
  return null
}

describe('useInsightsSeen', () => {
  it('reports all insights unseen when storage is empty', () => {
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured = v }} />)
    })
    expect(captured!.isSeen('2026-05', 'spend', 'Dining up')).toBe(false)
  })

  it('persists seen signatures across renders and instances', () => {
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured = v }} />)
    })
    act(() => {
      captured!.markSeen('2026-05', 'spend', 'Dining up')
    })
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    let captured2: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured2 = v }} />)
    })
    expect(captured2!.isSeen('2026-05', 'spend', 'Dining up')).toBe(true)
  })

  it('isolates seen state by userId', () => {
    let first: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { first = v }} />)
    })
    act(() => {
      first!.markSeen('2026-05', 'spend', 'Dining up')
    })
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    let other: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u2" onMount={(v) => { other = v }} />)
    })
    expect(other!.isSeen('2026-05', 'spend', 'Dining up')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace frontend test --run src/hooks/useInsightsSeen.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement `useInsightsSeen`**

Create `frontend/src/hooks/useInsightsSeen.ts`:

```typescript
import { useCallback, useState } from 'react'

function storageKey(userId: string): string {
  return `cashflow:ai-insights:lastSeen:${userId}`
}

function readSeen(userId: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeSeen(userId: string, seen: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  const arr = Array.from(seen).slice(-100)
  localStorage.setItem(storageKey(userId), JSON.stringify(arr))
}

function signature(period: string, metric: string, title: string): string {
  return `${period}::${metric}::${title}`
}

export function useInsightsSeen(userId: string) {
  const [seen, setSeen] = useState<Set<string>>(() => readSeen(userId))

  const isSeen = useCallback(
    (period: string, metric: string, title: string): boolean =>
      seen.has(signature(period, metric, title)),
    [seen],
  )

  const markSeen = useCallback(
    (period: string, metric: string, title: string) => {
      setSeen((prev) => {
        const next = new Set(prev)
        next.add(signature(period, metric, title))
        writeSeen(userId, next)
        return next
      })
    },
    [userId],
  )

  return { isSeen, markSeen }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn workspace frontend test --run src/hooks/useInsightsSeen.test.tsx`
Expected: 3 tests pass.

- [ ] **Step 5: Wire promotion + unread into DashboardPage**

Edit `frontend/src/pages/DashboardPage.tsx`.

(a) Add the hook import near other imports:

```typescript
import { useInsightsSeen } from '@/hooks/useInsightsSeen'
import { useAuth } from '@/lib/useAuth'
```

(`useAuth` is likely already imported elsewhere — check first; if so, skip.)

(b) Inside the `DashboardPage` component body, near the other `useState`/`useEffect` hooks, add:

```typescript
const auth = useAuth()
const userIdForSeen = String(auth.user?.id ?? 'anon')
const { isSeen, markSeen } = useInsightsSeen(userIdForSeen)
const sortedInsights = aiInsights
  ? [...aiInsights.insights].sort((a, b) => {
      const order: Record<string, number> = { action: 0, watch: 1, info: 2 }
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
    })
  : []
const hasActionSeverity = sortedInsights.some((i) => i.severity === 'action')
```

(c) The Bento grid is wrapped in a parent element. Locate the opening of the Bento grid container (the parent of the `<BentoTile>` tiles). Just before the first child tile, add the banner:

```typescript
{hasActionSeverity ? (
  <div className="aiActionBanner" role="status">
    AI flagged {sortedInsights.filter((i) => i.severity === 'action').length} action item(s) this month.{' '}
    <a href="#ai-insights-tile">Jump to insights</a>
  </div>
) : null}
```

(d) Find the AI insights `<BentoTile>` (the one with `label="AI insights"`). Change `span={4}` to `span={hasActionSeverity ? 6 : 4}` and add `id="ai-insights-tile"`:

```typescript
<BentoTile
  span={hasActionSeverity ? 6 : 4}
  rows={2}
  aria-busy={loading}
  label="AI insights"
  id="ai-insights-tile"
  description={
    aiInsights
      ? `${aiInsights.currency} · ${aiInsights.period}`
      : 'Awaiting fetch'
  }
>
```

(If `<BentoTile>` doesn't forward arbitrary props like `id`, wrap the tile in a `<div id="ai-insights-tile">` instead. Check the BentoTile signature:)

Run: `grep -n "export.*BentoTile\|type.*BentoTileProps" frontend/src/components/dashboard/BentoTile.tsx 2>/dev/null || grep -rn "function BentoTile" frontend/src/components | head -3`

(e) Replace the `aiInsights.insights.map(...)` block (now the sort-then-map from Task 6) with a version that uses `sortedInsights` and adds the unread dot. Find the existing block — the entire `.map((insight) => (<article ...>))` — and replace it with:

```typescript
sortedInsights.map((insight) => {
  const unread = !isSeen(aiInsights!.period, insight.metric, insight.title)
  return (
    <article
      key={`${insight.metric}-${insight.title}`}
      className={`aiVisibilityItem${unread ? ' is-unread' : ''}`}
      onClick={() => markSeen(aiInsights!.period, insight.metric, insight.title)}
    >
      <div className="aiVisibilityItemHeader">
        {unread ? <span className="unreadDot" aria-label="New" /> : null}
        <strong>{insight.title}</strong>
        <SeverityBadge severity={insight.severity as InsightSeverity} />
      </div>
      <p>{insight.summary}</p>
      <p className="muted">
        {insight.comparison} · {formatDashboardAmount(insight.amount)}
      </p>
      {insight.supportingTransactionIds.length > 0 ? (
        <p className="muted aiVisibilitySupportingIds">
          Transactions:{' '}
          {insight.supportingTransactionIds.map((id, idx) => (
            <span key={id}>
              {idx > 0 ? ', ' : null}
              <Link to={`/transactions?ids=${id}`}>#{id}</Link>
            </span>
          ))}
        </p>
      ) : null}
      <p className="muted">{insight.suggestedAction}</p>
      {insight.supportingTransactionIds.length > 0 ? (
        <Link
          to={`/transactions?ids=${insight.supportingTransactionIds.join(',')}`}
          className="aiVisibilityAction"
        >
          Open these transactions
        </Link>
      ) : null}
    </article>
  )
})
```

(f) Add minimal CSS for unread dot + banner. Open `frontend/src/App.css` (or whichever file owns the `aiVisibilityItem` class — check with `grep -rn "aiVisibilityItem" frontend/src --include="*.css" | head -3`). Append:

```css
.aiActionBanner {
  background: var(--destructive, #fee2e2);
  color: var(--destructive-foreground, #7f1d1d);
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.aiActionBanner a {
  color: inherit;
  text-decoration: underline;
}
.aiVisibilityItem.is-unread {
  border-left: 3px solid var(--brand, #f59e0b);
  padding-left: 0.5rem;
}
.unreadDot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand, #f59e0b);
  margin-right: 0.5rem;
  vertical-align: middle;
}
```

- [ ] **Step 6: Smoke check + manual verify**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`
Expected: lint clean, all tests pass.

Then in the browser: Dashboard shows unread dots on first visit; clicking an insight clears its dot; reloading remembers seen. When an `action`-severity insight is present, the red banner appears above the grid and the insights tile widens.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useInsightsSeen.ts frontend/src/hooks/useInsightsSeen.test.ts frontend/src/pages/DashboardPage.tsx frontend/src/App.css
git commit -m "feat(dashboard): action-severity banner + tile promotion + unread state"
```

---

## Task 9: `useAiInboxCount` hook + `AiInboxBadge` in Sidebar

**Files:**
- Create: `frontend/src/hooks/useAiInboxCount.ts`
- Create: `frontend/src/hooks/useAiInboxCount.test.ts`
- Modify: `frontend/src/components/Sidebar.tsx` (add AI Inbox nav item with badge)

- [ ] **Step 1: Write a failing test for `useAiInboxCount`**

Create `frontend/src/hooks/useAiInboxCount.test.tsx`:

```typescript
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiInboxCount } from './useAiInboxCount'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

type HookValue = ReturnType<typeof useAiInboxCount>

function Probe({ onUpdate }: { onUpdate: (v: HookValue) => void }) {
  const v = useAiInboxCount()
  useEffect(() => {
    onUpdate(v)
  })
  return null
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useAiInboxCount', () => {
  it('updates count after fetch resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ total: 4, byKind: {} }), { status: 200 }),
    )
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe onUpdate={(v) => { captured = v }} />)
    })
    await flush()
    await flush()
    expect(captured!.count).toBe(4)
    expect(captured!.loading).toBe(false)
  })

  it('returns 0 on fetch failure (silent)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe onUpdate={(v) => { captured = v }} />)
    })
    await flush()
    await flush()
    expect(captured!.count).toBe(0)
    expect(captured!.loading).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace frontend test --run src/hooks/useAiInboxCount.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement `useAiInboxCount`**

Create `frontend/src/hooks/useAiInboxCount.ts`:

```typescript
import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

type CountResponse = {
  total: number
  byKind: { transaction_audit: number; financial_insight: number; rule_proposal: number }
}

const POLL_MS = 5 * 60 * 1000

export function useAiInboxCount(): { count: number; loading: boolean } {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchCount() {
      try {
        const r = await getJson<CountResponse>('/api/ai/inbox/count')
        if (!cancelled) setCount(r.total)
      } catch {
        if (!cancelled) setCount(0)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchCount()
    const interval = setInterval(() => void fetchCount(), POLL_MS)
    const onFocus = () => void fetchCount()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return { count, loading }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn workspace frontend test --run src/hooks/useAiInboxCount.test.tsx`
Expected: 2 tests pass.

- [ ] **Step 5: Add AI Inbox nav item to Sidebar**

Edit `frontend/src/components/Sidebar.tsx`.

(a) Add the import near the top with other lucide-react icons:

```typescript
import { Sparkles } from 'lucide-react'
```

(Pick any icon that exists in lucide-react. `Sparkles` is a reasonable choice; `Inbox` is another. If unsure, run `grep -E "^import" frontend/src/components/Sidebar.tsx` and reuse the import style.)

(b) Add a hook import:

```typescript
import { useAiInboxCount } from '@/hooks/useAiInboxCount'
```

(c) Add a new nav item to the existing `navItems` array. Insert after the `Rules` entry:

```typescript
{ to: '/ai/inbox', label: 'AI Inbox', icon: Sparkles },
```

(d) Modify `SidebarNavLink` to render a count badge when the link is for AI Inbox. Replace the existing `SidebarNavLink` function with:

```typescript
function SidebarNavLink({
  item,
  onClick,
}: {
  item: NavItem
  onClick: () => void
}) {
  const Icon = item.icon
  const isAiInbox = item.to === '/ai/inbox'
  const { count } = useAiInboxCount()
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={navLinkClass}
    >
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
      {isAiInbox && count > 0 ? (
        <Badge variant="secondary" className="sidebar__navBadge">
          {count}
        </Badge>
      ) : null}
    </NavLink>
  )
}
```

(`Badge` is already imported at the top of the file.)

(e) The hook now runs on EVERY nav link (one instance per `SidebarNavLink`). That's wasteful (10+ fetches per Sidebar render). Lift it: replace the per-link hook with one shared call in `SidebarNavList`:

Replace `SidebarNavList` with:

```typescript
function SidebarNavList({
  items,
  onItemClick,
}: {
  items: NavItem[]
  onItemClick: () => void
}) {
  const { count: aiInboxCount } = useAiInboxCount()
  return (
    <nav className="sidebar__nav" aria-label="Main">
      {items.map((item) => (
        <SidebarNavLink
          key={item.to}
          item={item}
          onClick={onItemClick}
          badgeCount={item.to === '/ai/inbox' ? aiInboxCount : 0}
        />
      ))}
    </nav>
  )
}
```

And update `SidebarNavLink` to take `badgeCount` instead of calling the hook itself:

```typescript
function SidebarNavLink({
  item,
  onClick,
  badgeCount,
}: {
  item: NavItem
  onClick: () => void
  badgeCount: number
}) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={navLinkClass}
    >
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
      {badgeCount > 0 ? (
        <Badge variant="secondary" className="sidebar__navBadge">
          {badgeCount}
        </Badge>
      ) : null}
    </NavLink>
  )
}
```

- [ ] **Step 6: Smoke check**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`
Expected: lint clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useAiInboxCount.ts frontend/src/hooks/useAiInboxCount.test.ts frontend/src/components/Sidebar.tsx
git commit -m "feat(sidebar): add AI Inbox nav item with poll-based count badge"
```

---

## Task 10: `AiInboxPage` shell + route + segmented tabs + renderers

**Files:**
- Create: `frontend/src/pages/AiInboxPage.tsx`
- Create: `frontend/src/pages/AiInboxPage.test.tsx`
- Modify: `frontend/src/App.tsx` (register route)

- [ ] **Step 1: Write a failing test for the page**

Create `frontend/src/pages/AiInboxPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AiInboxPage } from './AiInboxPage'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('AiInboxPage', () => {
  it('renders an empty state when there are no items', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    )
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    expect(html).toContain('AI Inbox')
  })
})
```

(Interactive tests for click → dismiss can be added later via the act-based pattern; this is a smoke test that the component renders.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace frontend test --run src/pages/AiInboxPage.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement `AiInboxPage`**

Create `frontend/src/pages/AiInboxPage.tsx`:

```typescript
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '@/lib/api'

type InboxItem = {
  id: number
  kind: 'transaction_audit' | 'financial_insight' | 'rule_proposal'
  createdAt: string
  transactionId: number | null
  summary: string
  severity: 'action' | 'watch' | 'info' | null
  confidence: 'high' | 'medium' | 'low' | null
  output: unknown
}

type InboxResponse = { items: InboxItem[] }

type Tab = 'all' | 'transaction_audit' | 'financial_insight' | 'rule_proposal'

export function AiInboxPage() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [errorById, setErrorById] = useState<Record<number, string | null>>({})

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<InboxResponse>('/api/ai/inbox')
      setItems(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchItems()
  }, [fetchItems])

  const visible = tab === 'all' ? items : items.filter((i) => i.kind === tab)

  async function dismissPersisted(item: InboxItem) {
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/suggestions/${item.id}/reject`)
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  async function dismissProposal(item: InboxItem) {
    const output = item.output as { merchantPattern?: string } | null
    const pattern = output?.merchantPattern || ''
    if (!pattern) return
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/rule-proposals/${encodeURIComponent(pattern)}/dismiss`)
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  async function approveProposal(item: InboxItem) {
    const output = item.output as {
      merchantPattern?: string
      category?: string | null
      isBusiness?: boolean
      splitType?: string
      pctMe?: string | null
      pctPartner?: string | null
    } | null
    const pattern = output?.merchantPattern || ''
    if (!pattern) return
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/rule-proposals/${encodeURIComponent(pattern)}/approve`, {
        category: output?.category ?? null,
        isBusiness: output?.isBusiness ?? false,
        splitType: output?.splitType ?? 'me',
        pctMe: output?.pctMe ?? null,
        pctPartner: output?.pctPartner ?? null,
      })
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  function txnIdsFor(item: InboxItem): string {
    if (item.kind === 'transaction_audit') {
      const issues = (item.output as { issues?: Array<{ id?: number }> } | null)?.issues || []
      return issues.map((i) => i.id).filter((n): n is number => typeof n === 'number').join(',')
    }
    if (item.kind === 'financial_insight') {
      const arr = Array.isArray(item.output) ? (item.output as Array<{ supportingTransactionIds?: number[] }>) : []
      const ids = arr.flatMap((i) => i.supportingTransactionIds || [])
      return ids.join(',')
    }
    if (item.kind === 'rule_proposal') {
      const out = item.output as { exampleTransactionIds?: number[] } | null
      return (out?.exampleTransactionIds || []).join(',')
    }
    return ''
  }

  return (
    <main className="aiInboxPage">
      <header>
        <h1>AI Inbox</h1>
        <p className="muted">{items.length} pending</p>
      </header>
      <nav className="aiInboxTabs" aria-label="Filter by kind">
        {(['all', 'transaction_audit', 'financial_insight', 'rule_proposal'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={tab === t ? 'isActive' : ''}
          >
            {t === 'all' ? 'All' : t.replace('_', ' ')}
          </button>
        ))}
      </nav>
      {err ? <p className="error">{err}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && visible.length === 0 ? (
        <p className="emptyState">
          Nothing here. <Link to="/">Back to Dashboard</Link>
        </p>
      ) : null}
      <ul className="aiInboxList">
        {visible.map((item) => {
          const ids = txnIdsFor(item)
          const itemErr = errorById[item.id]
          return (
            <li key={`${item.kind}:${item.id}`} className="aiInboxItem">
              <div className="aiInboxItemSummary">
                <strong>{item.summary}</strong>
                <span className="muted"> · {item.kind.replace('_', ' ')}</span>
              </div>
              <div className="aiInboxItemActions">
                {item.kind === 'rule_proposal' ? (
                  <>
                    <Button type="button" onClick={() => void approveProposal(item)}>
                      Approve
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => void dismissProposal(item)}>
                      Dismiss
                    </Button>
                  </>
                ) : (
                  <>
                    {ids ? (
                      <Link to={`/transactions?ids=${ids}`} className="buttonLikeLink">
                        Open transactions
                      </Link>
                    ) : null}
                    <Button type="button" variant="secondary" onClick={() => void dismissPersisted(item)}>
                      Dismiss
                    </Button>
                  </>
                )}
              </div>
              {itemErr ? <p className="error">{itemErr}</p> : null}
            </li>
          )
        })}
      </ul>
    </main>
  )
}
```

- [ ] **Step 4: Register the route**

Edit `frontend/src/App.tsx`. Add the import:

```typescript
import { AiInboxPage } from './pages/AiInboxPage'
```

Add the route inside the existing `<Route path="/" element={<Layout />}>` block, after the `<Route path="settings" ...>` line:

```typescript
<Route path="ai/inbox" element={<AiInboxPage />} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn workspace frontend test --run src/pages/AiInboxPage.test.tsx`
Expected: 1 test passes.

- [ ] **Step 6: Smoke check + manual verification**

Run: `yarn workspace frontend lint && yarn workspace frontend test --run`

Then manually:
- Click "AI Inbox" in sidebar → page loads.
- With items present: each kind renders with appropriate actions.
- Click Dismiss → item disappears, sidebar badge decrements after the next poll (within 5 min, or on focus change).
- Click "Open transactions" → navigates to `/transactions?ids=...` showing the filtered list.
- Approve a rule proposal → it disappears + a new Rule appears on the Rules page.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/AiInboxPage.tsx frontend/src/pages/AiInboxPage.test.tsx frontend/src/App.tsx
git commit -m "feat(ai-inbox): add AiInboxPage with segmented tabs, kind-specific actions, optimistic dismiss"
```

---

## Task 11: End-to-end verification

**Files:** none.

Run the full test suite once and exercise the feature manually.

- [ ] **Step 1: Backend unit + integration tests**

```bash
yarn workspace backend test
yarn workspace backend test:integration
```

Expected: all green.

- [ ] **Step 2: Frontend tests + lint**

```bash
yarn workspace frontend test --run
yarn workspace frontend lint
yarn workspace frontend type-check
```

(Substitute `tsc --noEmit` if `type-check` script isn't defined — run `yarn workspace frontend run` to list scripts.)
Expected: all green.

- [ ] **Step 3: Manual scenarios**

Start dev servers and walk through:

1. **Dashboard tile**
   - Load Dashboard with no insights → tile shows "No insights available yet."
   - Load Dashboard with only `info` insights → tile is `span=4`, no banner, badges colored neutral, all marked unread first time.
   - Click an insight → its dot clears, persists across reload.
   - Click a `#123` link → navigates to `/transactions?ids=123` showing one row.
   - Load Dashboard with at least one `action` insight → banner appears at top, tile widens to `span=6`, action items sorted to top.

2. **Sidebar badge**
   - With 0 pending → nav item present, no badge.
   - With pending items → badge with count.
   - Click → navigates to `/ai/inbox`.

3. **AI Inbox**
   - Tabs filter the list.
   - "Open transactions" links to TransactionsPage with `?ids=`.
   - "Dismiss" optimistically removes item; Sidebar badge updates on next focus/poll.
   - "Approve" on a rule_proposal creates a Rule (verify on Rules page) and removes from inbox.
   - Empty state shows when nothing pending.

4. **Insights dedup**
   - Load Dashboard 3× → only one `suggested` row remains in `ai_suggestions` for that period+currency (use `sqlite3 backend/data/cashflow.sqlite "select count(*) from ai_suggestions where kind='financial_insight' and status='suggested'"`).

- [ ] **Step 4: Final commit (if any incidental fixes needed)**

If manual testing surfaces small fixes, address them and commit individually with descriptive messages.

---

## Out of scope (deferred per spec)

- Subcategory or tags fields on `transactions`.
- New SignalSource entries in the precedence ladder.
- Audit cron / scheduled AI runs.
- Push notifications / email digests.
- Inline AI hints on individual TransactionsPage rows.
- Import-cleanup in inbox.
- Structured `suggestedAction` schema with action verbs + endpoints.

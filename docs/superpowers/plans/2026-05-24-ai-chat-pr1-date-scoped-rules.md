# AI Chat — PR1: Date-Scoped Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `effective_from` / `effective_to` to the `rules` table and make import-time rule selection honor them. This is PR1 of the AI Chat for Transactions feature (spec: `docs/superpowers/specs/2026-05-24-ai-chat-transactions-design.md`). PR1 ships independently of any chat surface and is fully backwards-compatible (existing dateless rules keep working).

**Architecture:** One additive Sequelize migration adds two nullable DATEONLY columns to `rules`. The `findBestRule` selector gains an optional `txnDate` parameter that filters out rules whose effective window excludes the date. All callers (enrichment pipeline, `suggestTransaction`) thread the transaction's date through. The `/api/rules` route accepts the new fields in POST/PATCH so PR2's chat tool can write date-scoped rules later. The existing rules UI is unchanged — the new fields render as `null` and the UI doesn't display them yet.

**Tech Stack:** Node 20+, TypeScript 5.9, Sequelize 6 (sqlite + postgres), Express 4, `node:test` via `tsx`. Migrations are CommonJS (`*.cjs`-style but written as `.js` in this repo per existing convention).

**Spec section this plan implements:** "Data model — schema changes" (rules columns) and the proposal lifecycle prerequisite that date-scoped rules exist.

**Out of scope for this PR (deferred to PR2/PR3):** chat tables (`chat_threads`/`chat_messages`/`chat_proposals`), chat routes, OpenAI chat client, `/chat` page, rules UI updates to surface effective dates.

---

## File Structure

**Modified:**
- `backend/src/migrations/20260524180000-rule-effective-dates.js` (NEW)
- `backend/src/models/Rule.ts` — add `effectiveFrom` / `effectiveTo` fields
- `backend/src/import/applyRules.ts` — extend `RuleRow`, extend `findBestRule(rules, merchantClean, txnDate?)`
- `backend/src/import/enrichment/applyRuleStage.ts` — add `txnDate` to `ApplyRuleInput`, forward to `findBestRule`
- `backend/src/import/enrich.ts` — forward `input.raw.date` into the apply-rule stage
- `backend/src/ai/suggestTransaction.ts` — pass `txn.date` to `findBestRule`
- `backend/src/routes/rules.ts` — accept `effectiveFrom` / `effectiveTo` in POST + PATCH
- `shared/api-types.ts` — add `effectiveFrom` / `effectiveTo` to `Rule` type
- `backend/test/applyRules.test.ts` — add date-scoping tests

**No frontend changes in PR1.** The existing rules UI ignores the new fields. They can be added in a follow-up or alongside PR3.

---

### Task 1: Migration — add effective_from / effective_to to rules

**Files:**
- Create: `backend/src/migrations/20260524180000-rule-effective-dates.js`

The latest existing migration is `20260524022515-fx-rates.js`; our timestamp must be later.

- [ ] **Step 1: Create the migration file**

Write `backend/src/migrations/20260524180000-rule-effective-dates.js`:

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('rules', 'effective_from', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('rules', 'effective_to', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('rules', 'effective_to');
    await queryInterface.removeColumn('rules', 'effective_from');
  },
};
```

- [ ] **Step 2: Run the migration**

Run: `yarn workspace cashflow-backend run db:migrate`
Expected: Output ending with `== 20260524180000-rule-effective-dates: migrated`.

- [ ] **Step 3: Verify the columns exist**

Run: `sqlite3 backend/data/cashflow.sqlite ".schema rules"`
Expected: schema includes `effective_from DATE` and `effective_to DATE` lines (both nullable).

- [ ] **Step 4: Verify the down migration works**

Run: `yarn workspace cashflow-backend run db:migrate:undo`
Expected: Output ending with `== 20260524180000-rule-effective-dates: reverted`.

Re-check schema: `sqlite3 backend/data/cashflow.sqlite ".schema rules"`
Expected: the two columns are gone.

- [ ] **Step 5: Re-apply for subsequent tasks**

Run: `yarn workspace cashflow-backend run db:migrate`
Expected: re-migrates cleanly.

- [ ] **Step 6: Commit**

```bash
git add backend/src/migrations/20260524180000-rule-effective-dates.js
git commit -m "feat(rules): migration adds effective_from/effective_to columns"
```

---

### Task 2: Add effective_from / effective_to to the Rule model

**Files:**
- Modify: `backend/src/models/Rule.ts`

- [ ] **Step 1: Add the field declarations**

In `backend/src/models/Rule.ts`, add these two `declare` lines inside the `Rule` class, after `pctPartner` and before the timestamps:

```ts
  /** Inclusive lower bound on Transaction.date; null = "always". */
  declare effectiveFrom: string | null;
  /** Exclusive upper bound on Transaction.date; null = "forever". */
  declare effectiveTo: string | null;
```

So the class block becomes:

```ts
  declare pctMe: string | null;
  declare pctPartner: string | null;
  /** Inclusive lower bound on Transaction.date; null = "always". */
  declare effectiveFrom: string | null;
  /** Exclusive upper bound on Transaction.date; null = "forever". */
  declare effectiveTo: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
```

- [ ] **Step 2: Add to the Sequelize init attribute map**

In the same file, in the `Rule.init({...})` attributes object, add after `pctPartner`:

```ts
      effectiveFrom: {
        type: DataTypes.DATEONLY,
        field: 'effective_from',
        allowNull: true,
      },
      effectiveTo: {
        type: DataTypes.DATEONLY,
        field: 'effective_to',
        allowNull: true,
      },
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Run existing tests**

Run: `yarn workspace cashflow-backend run test`
Expected: PASS. Existing rule tests do not exercise these fields and should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/Rule.ts
git commit -m "feat(rules): add effectiveFrom/effectiveTo to Rule model"
```

---

### Task 3: Extend `RuleRow` type + shared `Rule` API type

**Files:**
- Modify: `backend/src/import/applyRules.ts` (the `RuleRow` interface)
- Modify: `shared/api-types.ts` (the `Rule` type)

`loadAllRules` already returns `row.toJSON() as RuleRow`. Once Sequelize knows about the columns (Task 2), `toJSON()` includes them automatically. We just need to widen the type so consumers can use them.

- [ ] **Step 1: Extend `RuleRow` in `backend/src/import/applyRules.ts`**

Add two fields at the end of the interface:

```ts
export interface RuleRow {
  id: number;
  merchantPattern: string;
  priority: number;
  matchKind: string;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  /** Inclusive lower bound on Transaction.date (YYYY-MM-DD); null = "always". */
  effectiveFrom: string | null;
  /** Exclusive upper bound on Transaction.date (YYYY-MM-DD); null = "forever". */
  effectiveTo: string | null;
}
```

- [ ] **Step 2: Extend `Rule` in `shared/api-types.ts`**

Update the type:

```ts
export type Rule = {
  id: number
  merchantPattern: string
  matchKind: string
  priority: number
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  usageCount?: number
}
```

- [ ] **Step 3: Typecheck both workspaces**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run tsc -b`
Expected: PASS. If the frontend fails because something constructs a `Rule` literal without the new fields, find the literal and add `effectiveFrom: null, effectiveTo: null` to it. (Likely test fixtures only; real code reads `Rule` from the API.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/import/applyRules.ts shared/api-types.ts
git commit -m "feat(rules): expose effectiveFrom/effectiveTo on RuleRow + shared Rule type"
```

---

### Task 4: Add date-scoped selection to `findBestRule` (TDD)

**Files:**
- Modify: `backend/src/import/applyRules.ts` (extend `findBestRule`)
- Modify: `backend/test/applyRules.test.ts` (new tests)

Add an optional `txnDate?: string` (YYYY-MM-DD) parameter. When provided, a rule is in-scope iff:

- `effectiveFrom == null || txnDate >= effectiveFrom`
- `effectiveTo == null || txnDate < effectiveTo`  (exclusive upper bound, per spec)

When `txnDate` is omitted, no date filter is applied (backwards-compatible).

Comparisons use string compare on `YYYY-MM-DD` strings — lexicographic order matches chronological order for ISO dates.

- [ ] **Step 1: Write failing tests**

Append to `backend/test/applyRules.test.ts`:

```ts
function makeRule(over: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 1,
    merchantPattern: 'GROCER',
    priority: 1,
    matchKind: 'substring',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...over,
  };
}

test('findBestRule excludes rules whose effective_from is after txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-11-30');
  assert.equal(rule, null);
});

test('findBestRule includes rules with effective_from on or before txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule?.id, 1);
});

test('findBestRule excludes rules whose effective_to equals txnDate (exclusive upper bound)', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveTo: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule, null);
});

test('findBestRule includes rules whose effective_to is after txnDate', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveTo: '2026-12-02' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER', '2026-12-01');
  assert.equal(rule?.id, 1);
});

test('findBestRule with null effective bounds matches any txnDate', () => {
  const rules: RuleRow[] = [makeRule({ id: 1 })];
  const a = findBestRule(rules, 'GROCER', '1999-01-01').rule;
  const b = findBestRule(rules, 'GROCER', '2099-01-01').rule;
  assert.equal(a?.id, 1);
  assert.equal(b?.id, 1);
});

test('findBestRule omits date filter when txnDate is undefined (backwards-compatible)', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, effectiveFrom: '2026-12-01' }),
  ];
  const { rule } = findBestRule(rules, 'GROCER');
  assert.equal(rule?.id, 1);
});

test('findBestRule picks the date-scoped rule when both a dateless and a date-scoped rule match', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, priority: 5, effectiveFrom: null, pctMe: '1.0000' }),
    makeRule({ id: 2, priority: 5, effectiveFrom: '2026-12-01', pctMe: '0.6000' }),
  ];
  // Tie-breaker stays as it is in the existing implementation (priority, then
  // pattern length, then id). With same priority and same pattern length, the
  // higher id wins. Both are in-scope on this date.
  const { rule, ambiguous } = findBestRule(rules, 'GROCER', '2026-12-15');
  // Both same priority + same pattern length → ambiguous in the existing logic.
  assert.equal(ambiguous, true);
  assert.equal(rule, null);
});

test('findBestRule resolves cleanly when only the date-scoped rule is in scope', () => {
  const rules: RuleRow[] = [
    makeRule({ id: 1, priority: 5, effectiveFrom: '2027-01-01', pctMe: '1.0000' }),
    makeRule({ id: 2, priority: 5, effectiveFrom: '2026-12-01', pctMe: '0.6000' }),
  ];
  const { rule, ambiguous } = findBestRule(rules, 'GROCER', '2026-12-15');
  assert.equal(ambiguous, false);
  assert.equal(rule?.id, 2);
});
```

- [ ] **Step 2: Run the new tests; expect failures**

Run: `yarn workspace cashflow-backend exec -- tsx --test test/applyRules.test.ts`
Expected: the new tests fail — most will report a wrong rule id or wrong null/non-null because `findBestRule` does not yet honor the date bounds. The two backwards-compat tests (`null effective bounds match any txnDate`, `omits date filter when txnDate is undefined`) may pass even before changes because the field exists but is ignored. That is fine; rerun after Step 3.

- [ ] **Step 3: Implement date filtering in `findBestRule`**

Edit `backend/src/import/applyRules.ts`. Change the function signature and add a date-scope check at the top of the matching loop:

```ts
export function findBestRule(
  rulesAll: RuleRow[],
  merchantClean: string,
  txnDate?: string
): { rule: RuleRow | null; ambiguous: boolean } {
  const candidates: RuleRow[] = [];
  for (const rule of rulesAll) {
    if (txnDate != null) {
      if (rule.effectiveFrom != null && txnDate < rule.effectiveFrom) continue;
      if (rule.effectiveTo != null && txnDate >= rule.effectiveTo) continue;
    }
    const pattern = rule.merchantPattern || '';
    let ok = false;
    if (rule.matchKind === 'regex') {
      try {
        const re = new RegExp(pattern, 'i');
        ok = re.test(merchantClean);
      } catch {
        ok = false;
      }
    } else {
      ok = merchantClean.toLowerCase().includes(pattern.toLowerCase());
    }
    if (ok) candidates.push(rule);
  }
  if (candidates.length === 0) return { rule: null, ambiguous: false };

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const la = (a.merchantPattern || '').length;
    const lb = (b.merchantPattern || '').length;
    if (lb !== la) return lb - la;
    return b.id - a.id;
  });

  const best = candidates[0];
  const second = candidates[1];
  if (second) {
    const samePriority = second.priority === best.priority;
    const sameLen =
      (second.merchantPattern || '').length === (best.merchantPattern || '').length;
    if (samePriority && sameLen) {
      return { rule: null, ambiguous: true };
    }
  }
  return { rule: best, ambiguous: false };
}
```

- [ ] **Step 4: Run tests; expect all pass**

Run: `yarn workspace cashflow-backend exec -- tsx --test test/applyRules.test.ts`
Expected: all tests PASS, including the new ones from Step 1 and the two original tests at the top of the file.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/applyRules.ts backend/test/applyRules.test.ts
git commit -m "feat(rules): findBestRule honors effective_from/effective_to"
```

---

### Task 5: Thread `txnDate` through the enrichment pipeline

**Files:**
- Modify: `backend/src/import/enrichment/applyRuleStage.ts` — add `txnDate` to `ApplyRuleInput`
- Modify: `backend/src/import/enrich.ts` — forward `input.raw.date`

- [ ] **Step 1: Update `ApplyRuleInput` and `runApplyRuleStage`**

Edit `backend/src/import/enrichment/applyRuleStage.ts`:

```ts
import { findBestRule, applyRuleToAuto, type RuleRow } from '../applyRules';
import type { Signal } from './types';

export interface ApplyRuleInput {
  merchantClean: string;
  rules: RuleRow[];
  /** YYYY-MM-DD; used to filter rules by effective_from/effective_to. */
  txnDate: string;
}

export function runApplyRuleStage(input: ApplyRuleInput): Signal[] {
  const { rule, ambiguous } = findBestRule(input.rules, input.merchantClean, input.txnDate);
  if (!rule || ambiguous) return [];

  const auto = applyRuleToAuto(rule);
  return [
    {
      source: 'rule',
      confidence: 'high',
      fields: {
        autoCategory: auto.autoCategory,
        autoBusiness: auto.autoBusiness,
        autoSplitType: auto.autoSplitType,
        autoPctMe: auto.autoPctMe,
        autoPctPartner: auto.autoPctPartner,
        appliedRuleId: rule.id,
      },
      rationale: `matched rule pattern "${rule.merchantPattern}"`,
    },
  ];
}
```

- [ ] **Step 2: Update the call site in `enrich.ts`**

Edit `backend/src/import/enrich.ts` around line 101. Change:

```ts
  // Stage 4: apply-rule
  signals.push(...safeStage('apply-rule', () => runApplyRuleStage({
    merchantClean,
    rules: input.rules,
  }), []));
```

to:

```ts
  // Stage 4: apply-rule
  signals.push(...safeStage('apply-rule', () => runApplyRuleStage({
    merchantClean,
    rules: input.rules,
    txnDate: input.raw.date,
  }), []));
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS. The `txnDate` field is now required on `ApplyRuleInput`, so any other callers would fail typecheck — there are none beyond `enrich.ts`, but the typecheck confirms that.

- [ ] **Step 4: Run all backend tests**

Run: `yarn workspace cashflow-backend run test`
Expected: PASS. If `enrichApplyRule.test.ts` constructs `ApplyRuleInput` literals, add `txnDate: '2026-01-01'` (or similar) to each. Likely you'll need to update that file — run the test and follow the typecheck errors to fix.

- [ ] **Step 5: Run integration tests**

Run: `yarn workspace cashflow-backend run test:integration`
Expected: PASS. Same fix-up may be needed in any integration helper that builds `ApplyRuleInput`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/enrichment/applyRuleStage.ts backend/src/import/enrich.ts backend/test
git commit -m "feat(enrich): pass txn date into apply-rule stage for date-scoped rules"
```

---

### Task 6: Pass `txn.date` into `findBestRule` from `suggestTransaction`

**Files:**
- Modify: `backend/src/ai/suggestTransaction.ts` (line 215 area)

`suggestTransaction` runs against an existing `Transaction`. Its `txn` parameter already has `.date`.

- [ ] **Step 1: Inspect the call site**

Run: `grep -n "findBestRule" backend/src/ai/suggestTransaction.ts`
Expected: one line around `:215` like:

```ts
  const matching = findBestRule(rules, txn.merchantClean);
```

- [ ] **Step 2: Pass the txn date**

Edit `backend/src/ai/suggestTransaction.ts`:

```ts
  const matching = findBestRule(rules, txn.merchantClean, txn.date);
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 4: Run AI suggestion tests**

Run: `yarn workspace cashflow-backend exec -- tsx --test test/aiSuggestion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/suggestTransaction.ts
git commit -m "feat(ai): suggestTransaction passes txn.date to findBestRule"
```

---

### Task 7: Update `/api/rules` route to accept effective_from / effective_to

**Files:**
- Modify: `backend/src/routes/rules.ts`

Validate dates as `YYYY-MM-DD`. Reject invalid formats with `400`. `null` is allowed (explicit clear). Omitted = no change (PATCH) / default null (POST).

- [ ] **Step 1: Add a date-string validator at the top of the file**

In `backend/src/routes/rules.ts`, after the imports and before `const router = Router();`, add:

```ts
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses an `effective_from` / `effective_to` body field.
 * Returns `{ ok: true, value }` for null, undefined, or a valid YYYY-MM-DD
 * string. Returns `{ ok: false, error }` otherwise.
 */
function parseEffectiveDate(
  raw: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !DATE_ONLY_RE.test(raw)) {
    return { ok: false, error: 'must be YYYY-MM-DD or null' };
  }
  return { ok: true, value: raw };
}
```

- [ ] **Step 2: Extend the POST handler**

Replace the body of `router.post('/', ...)` so the create call includes both fields. After the existing `if (!b.merchantPattern)` check, add:

```ts
    const fromParsed = parseEffectiveDate(b.effectiveFrom);
    if (!fromParsed.ok) {
      res.status(400).json({ error: `effectiveFrom ${fromParsed.error}` });
      return;
    }
    const toParsed = parseEffectiveDate(b.effectiveTo);
    if (!toParsed.ok) {
      res.status(400).json({ error: `effectiveTo ${toParsed.error}` });
      return;
    }
    if (
      fromParsed.value != null &&
      toParsed.value != null &&
      fromParsed.value >= toParsed.value
    ) {
      res.status(400).json({ error: 'effectiveFrom must be < effectiveTo' });
      return;
    }
```

Then extend the `Rule.create({...})` call:

```ts
    const row = await Rule.create({
      merchantPattern: String(b.merchantPattern),
      householdId: household.id,
      createdByUserId: user.id,
      matchKind: (b.matchKind as string) || 'substring',
      priority: b.priority != null ? Number(b.priority) : 0,
      category: (b.category as string | null) ?? null,
      isBusiness: Boolean(b.isBusiness),
      splitType: (b.splitType as string) || 'me',
      pctMe: b.pctMe != null ? String(b.pctMe) : null,
      pctPartner: b.pctPartner != null ? String(b.pctPartner) : null,
      effectiveFrom: fromParsed.value,
      effectiveTo: toParsed.value,
    });
```

- [ ] **Step 3: Extend the PATCH handler**

In `router.patch('/:id', ...)`, after the `row` is loaded and before the existing `fields` loop, add:

```ts
    if (Object.prototype.hasOwnProperty.call(b, 'effectiveFrom')) {
      const p = parseEffectiveDate(b.effectiveFrom);
      if (!p.ok) {
        res.status(400).json({ error: `effectiveFrom ${p.error}` });
        return;
      }
      row.set('effectiveFrom', p.value);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'effectiveTo')) {
      const p = parseEffectiveDate(b.effectiveTo);
      if (!p.ok) {
        res.status(400).json({ error: `effectiveTo ${p.error}` });
        return;
      }
      row.set('effectiveTo', p.value);
    }
    // Post-condition check using the post-set values:
    const newFrom = row.get('effectiveFrom') as string | null;
    const newTo = row.get('effectiveTo') as string | null;
    if (newFrom != null && newTo != null && newFrom >= newTo) {
      res.status(400).json({ error: 'effectiveFrom must be < effectiveTo' });
      return;
    }
```

(GET returns the full row via `r.toJSON()`, so `effectiveFrom` / `effectiveTo` are already exposed after Task 2.)

- [ ] **Step 4: Add an integration test**

Create `backend/test/integration/rulesEffectiveDates.test.ts`:

```ts
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, loginDemo } from './helpers';
// ^ Use whatever helpers other integration tests use. Look at any existing
// file in backend/test/integration/ for the canonical setup pattern and copy
// it. Common pattern: an `app` returned from createTestApp(), and a logged-in
// agent. If no helpers exist, inline the equivalent of demo-login here.

let app: ReturnType<typeof createTestApp>;
let agent: request.SuperAgentTest;

before(async () => {
  app = await createTestApp();
  agent = await loginDemo(app);
});

after(async () => {
  // Whatever teardown the other integration tests use.
});

test('POST /api/rules accepts effectiveFrom and effectiveTo', async () => {
  const res = await agent
    .post('/api/rules')
    .send({
      merchantPattern: 'GROCER',
      matchKind: 'substring',
      splitType: 'shared',
      pctMe: '0.5000',
      pctPartner: '0.5000',
      effectiveFrom: '2026-12-01',
      effectiveTo: null,
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.effectiveFrom, '2026-12-01');
  assert.equal(res.body.effectiveTo, null);
});

test('POST /api/rules rejects malformed effectiveFrom', async () => {
  const res = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'X', effectiveFrom: 'tomorrow' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveFrom/);
});

test('POST /api/rules rejects effectiveFrom >= effectiveTo', async () => {
  const res = await agent
    .post('/api/rules')
    .send({
      merchantPattern: 'X',
      effectiveFrom: '2026-12-01',
      effectiveTo: '2026-12-01',
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveFrom must be < effectiveTo/);
});

test('PATCH /api/rules/:id can clear effectiveFrom by passing null', async () => {
  const created = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'GROCER', effectiveFrom: '2026-12-01' });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ effectiveFrom: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.effectiveFrom, null);
});
```

**Before writing this file:** open one existing `backend/test/integration/*.test.ts` and copy its setup/teardown imports verbatim — the helper paths (`./helpers`, `./testServer`, etc.) and the import style differ across repos and you must match what is already in the tree. Do not invent helper functions that don't exist; use whatever the neighboring integration test uses.

- [ ] **Step 5: Run the integration test**

Run: `yarn workspace cashflow-backend exec -- tsx --test test/integration/rulesEffectiveDates.test.ts`
Expected: all four tests PASS.

- [ ] **Step 6: Run all backend tests + integration tests + typecheck**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test && yarn workspace cashflow-backend run test:integration`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/rules.ts backend/test/integration/rulesEffectiveDates.test.ts
git commit -m "feat(api): /api/rules accepts effectiveFrom/effectiveTo with YYYY-MM-DD validation"
```

---

### Task 8: End-to-end smoke + final CI run

**Files:**
- None to write. This task verifies the whole PR1 surface works together.

- [ ] **Step 1: Start the dev server**

Run: `yarn dev`
Expected: both backend (port 3001) and frontend (port 5173) start without error.

- [ ] **Step 2: Create a date-scoped rule via curl**

In a separate terminal, log in as the demo user and create a rule:

```bash
curl -i -c /tmp/cashflow.cookies -X POST \
  http://localhost:3001/api/auth/demo-login \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -i -b /tmp/cashflow.cookies -X POST \
  http://localhost:3001/api/rules \
  -H 'Content-Type: application/json' \
  -d '{
    "merchantPattern": "GROCER",
    "matchKind": "substring",
    "splitType": "shared",
    "pctMe": "0.5000",
    "pctPartner": "0.5000",
    "effectiveFrom": "2026-12-01"
  }'
```

Expected: the second response is `201` and the body contains `"effectiveFrom":"2026-12-01"` and `"effectiveTo":null`.

- [ ] **Step 3: Verify the dateless GET still works**

```bash
curl -s -b /tmp/cashflow.cookies http://localhost:3001/api/rules | head -c 400
```

Expected: a JSON array; the rule you just created appears with `effectiveFrom` and `effectiveTo` keys.

- [ ] **Step 4: Stop the dev server**

Ctrl-C in the `yarn dev` window.

- [ ] **Step 5: Run the full CI script**

Run: `yarn ci`
Expected: PASS (typecheck + tests + integration tests + frontend tests + builds, all green).

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin "$(git branch --show-current)"
```

Then open a PR titled `feat(rules): date-scoped rules (AI chat PR1)`. Body:

```
PR1 of the AI chat for transactions feature.
Spec: docs/superpowers/specs/2026-05-24-ai-chat-transactions-design.md

Adds effective_from / effective_to (DATEONLY, nullable) to the rules
table and makes import-time rule selection honor them. Backwards-
compatible: existing dateless rules keep matching every date. The
/api/rules POST and PATCH accept the new fields; the existing rules UI
is unchanged for now.

No chat surface yet — PR2 wires up the chat backend; PR3 the /chat
page.

## Test plan
- [ ] yarn ci passes
- [ ] Manual: create a rule with effectiveFrom in the future via the API
- [ ] Manual: import a transaction dated before effectiveFrom; verify the rule
      does NOT apply (no appliedRuleId)
- [ ] Manual: import a transaction dated on/after effectiveFrom; verify the
      rule DOES apply
```

---

## Self-review

**Spec coverage:**
- Schema: `rules.effective_from` + `rules.effective_to` (Tasks 1, 2). ✓
- Rule selection at import: "highest-priority rule whose pattern matches AND (effective_from IS NULL OR date >= effective_from) AND (effective_to IS NULL OR date < effective_to). Ties broken by priority then by id." Implemented in Task 4; tested explicitly. The existing tie-breaker uses `priority → pattern length → id` (not just priority → id). The spec wording is paraphrased; the existing tie-breaker is preserved as-is — it is already the documented behavior in `applyRules.ts:37-43` and changing it is out of scope for date-scoping. ✓ (with note)
- Rules CRUD accepts new fields: Task 7. ✓
- Shared type: Task 3. ✓
- Chat tables (`chat_threads`/`chat_messages`/`chat_proposals`): **deferred to PR2**, as stated in the plan's out-of-scope list and called out in the spec's "Suggested PR split" section. ✓
- Backwards compatibility: explicit tests in Task 4. ✓

**Placeholder scan:** No TBD / TODO / "implement later". Every step shows the code to write or the command to run. The integration-test step instructs the engineer to copy the helper-setup pattern from an existing integration test rather than referencing fabricated helpers — this is a real instruction, not a placeholder.

**Type consistency:**
- `RuleRow.effectiveFrom: string | null` (Task 3) is read in `findBestRule` (Task 4) and set in `applyRuleStage` via passthrough (Task 5). ✓
- `Rule` model field name is `effectiveFrom` (camelCase) with DB column `effective_from` (snake_case) — matches existing model conventions. ✓
- API body fields are `effectiveFrom` / `effectiveTo` (camelCase). Existing rules.ts route uses camelCase body fields (`merchantPattern`, `matchKind`, etc.) — consistent. ✓
- `ApplyRuleInput.txnDate: string` (required after Task 5) — the lone existing caller (`enrich.ts`) is updated in the same task, so no orphan callers.

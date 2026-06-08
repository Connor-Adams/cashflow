# Cashflow Dev-Tools Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a project-level `.claude/` toolkit for Cashflow — a canonical `conventions.md`, non-blocking guardrail hooks, a fleet-status skill — and fix the convention-drift bugs in the three global loop skills.

**Architecture:** Facts live in the repo (`.claude/conventions.md`), behavior reads them. Two pure-function Node hooks (`guard-spine.mjs`, `guard-bash.mjs`) wired via `.claude/settings.json` inject `additionalContext` (non-blocking) and hard-`deny` only for unambiguous commit mistakes — so they never stall a headless background worker. The global skills get a "the file wins" header note plus targeted drift fixes.

**Tech Stack:** Node ESM (`.mjs`, zero deps, `node:test`), Claude Code PreToolUse hooks, yarn-1 monorepo, markdown skills.

**Spec:** `docs/superpowers/specs/2026-06-05-cashflow-devtools-design.md`

---

## ⚠️ Worktree commit note (applies to EVERY commit step)

This branch is a `.claude/worktrees/` checkout with **no `node_modules`**, so a bare
`git commit` fails at husky→lint-staged (code 127). **Prefix every commit:**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"
```

(This is the exact gotcha `guard-bash.mjs` G1c warns about — we dogfood the fix.)

## Two zones

- **Tasks 1–4** create files under `.claude/` in THIS repo → committed to branch
  `claude/friendly-solomon-c14a5a`.
- **Tasks 5–8** edit/create files under `~/.claude/skills/` (your dotfiles, a
  DIFFERENT git root) → **no cashflow-repo commit**; verify by grep. If you track
  `~/.dotfiles`, commit there separately (out of scope for this PR).

## File structure

| File | Zone | Responsibility |
|---|---|---|
| `.claude/conventions.md` | repo | Single source of truth (workspaces, tests, verify, worktree, spine, commit, board IDs) |
| `.claude/hooks/guard-spine.mjs` | repo | G2 — nudge the spine rule on a new model/migration/route file |
| `.claude/hooks/guard-spine.test.mjs` | repo | Unit tests for `classifySpine` |
| `.claude/hooks/guard-bash.mjs` | repo | G1 (worktree) + G4 (commit hygiene) |
| `.claude/hooks/guard-bash.test.mjs` | repo | Unit tests for `classifyBash` |
| `.claude/settings.json` | repo | Wire both hooks into PreToolUse |
| `~/.claude/skills/cashflow-issue-worker/SKILL.md` | global | Fix line-93 test dir + db:rollback drift; add note |
| `~/.claude/skills/cashflow-tackle/SKILL.md` | global | Add note + board-ID pointer |
| `~/.claude/skills/cashflow-product-design/SKILL.md` | global | Add note |
| `~/.claude/skills/cashflow-fleet-status/SKILL.md` | global | New read-only fleet snapshot skill |

---

### Task 1: `conventions.md` (the backbone)

**Files:**
- Create: `.claude/conventions.md`

- [ ] **Step 1: Create the file** with this exact content:

```markdown
# Cashflow conventions (canonical)

> This file is the single source of truth for how to work in this repo. Skills and
> hooks defer to it. If a global skill (cashflow-issue-worker / cashflow-tackle /
> cashflow-product-design) contradicts this file, **this file wins** — it versions
> with the code; the skills do not.

## Workspaces (yarn-1 monorepo, run everything from repo root)

| Workspace | yarn name | Notes |
|---|---|---|
| backend | `cashflow-backend` | NOT `backend`. Express + Sequelize. |
| frontend | `frontend` | Vite + React 19. **No `typecheck` script** — use `tsc -b`. |
| shared | `shared` | One file `shared/api-types.ts`, imported as `@cashflow/shared`. |

## Tests

- Backend: **`node:test` via `tsx`** (no vitest, no `--run` flag). Tests are
  **auto-discovered**: `backend/scripts/run-unit-tests.sh` → `backend/test/list-unit-tests.mjs`
  finds every `backend/test/**/*.test.ts` **except** `test/integration/**`.
  - Backend tests live in **`backend/test/`** (flat tree), NOT `backend/src/**/__tests__/`.
  - All backend unit: `yarn workspace cashflow-backend run test`
  - One file: `cd backend && yarn tsx --import ./test/setup.ts --test test/<file>.test.ts`
  - Filter by name: append `--test-name-pattern '<regex>'`
  - Integration (needs Postgres, `TEST_DATABASE_URL`): `yarn workspace cashflow-backend run test:integration`
- Frontend: **vitest**. One file: `yarn workspace frontend run test <Name>`.
- Everything: `yarn test` (backend unit + backend integration + frontend).

## Verify suite (before claiming done / opening a PR)

Prefer the full gate: **`yarn ci`** (= test:workflows + backend typecheck + backend
unit + backend integration + backend build + frontend test + frontend build).

Partial / faster:
- Backend typecheck: `yarn workspace cashflow-backend run typecheck` (`tsc --noEmit`)
- Frontend typecheck: `yarn workspace frontend run tsc -b` (no `typecheck` script)
- Backend lint: `yarn workspace cashflow-backend run lint` (`eslint src --ext .ts`)
- Frontend lint: `yarn workspace frontend run lint` (`eslint .`)
- Migration round-trip: `yarn workspace cashflow-backend run db:migrate` then
  `yarn workspace cashflow-backend run db:migrate:undo` then re-migrate.
  (The undo script is **`db:migrate:undo`** — there is no `db:rollback`.)

## Worktree gotchas (.claude/worktrees/<name>)

- A fresh worktree may have **no `node_modules`** (or only a partial one). Consequences:
  - `yarn install` / `yarn setup` fails under a worktree (vite-link error). Install from
    the **main checkout** (`/Users/connoradams/Developer/cashflow`).
  - `git commit` fails at husky→lint-staged (code 127) because the binary isn't on PATH.
    Fix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …`.
  - To run eslint/tsc/tsx in a worktree, prefix the same PATH or call the binary from the
    main checkout's `node_modules/.bin/`.
- An **absolute** `/Users/connoradams/Developer/cashflow/{backend,frontend,shared}/…`
  path used while inside a worktree points at the **main checkout, not your branch**.

## Primitives spine (READ before adding any model / route / page)

Full rule: `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`.

The 13: **Transaction, Expectation, Account, Holding, Principal, Counterparty,
Scenario, Budget, Goal, Proposal, Observation, Document, Period.**

Before a new model/route/page, answer 3 checks:
1. Which of the 13 does this extend? Exactly one → extend it (type/kind field or column).
   None → new primitive (RARE — justify in PR). Multiple → a relation/view, not a thing.
2. Persistent or derived? Derived → no table, add a query. Persistent → which primitive owns it?
3. Shape mirrors an existing primitive under a new name? → STOP, fold via a discriminator.

Mount order is load-bearing and locked by `backend/test/appRouteOrder.test.ts`; routes
mount via the declarative `backend/src/routeRegistry.ts`.

## Commit / PR

- **Sole author** — never add `Co-Authored-By` trailers.
- Never `--no-verify`; never `--amend` after a hook failure (make a new commit).
- Never commit `*.sqlite` / `*.sqlite-journal` / `node_modules/` / `backend/data/`.
- Merge style: **auto-merge with a merge commit, never squash**
  (`gh pr merge <N> --auto --merge --delete-branch`). Flip `allow_auto_merge` if rejected.

## GitHub Project board (canonical IDs)

- Board: https://github.com/users/Connor-Adams/projects/1 (user-scoped, owner `Connor-Adams`)
- Project node ID: `PVT_kwHOAVVoss4BY3pN`

| Field | Field ID | Options (option ID) |
|---|---|---|
| Pipeline | `PVTSSF_lAHOAVVoss4BY3pNzhT6VwQ` | Triage `2abd1768` · Backlog `6ba82814` · Up Next `2f793326` · In Flight `affc6f81` · Shipped `e3cf823b` |
| Phase | `PVTSSF_lAHOAVVoss4BY3pNzhT6Vxk` | Foundation · Surface · Polish |
| Epic | `PVTSSF_lAHOAVVoss4BY3pNzhT6VzQ` | 14 clusters + (none) |
| Priority | `PVTSSF_lAHOAVVoss4BY3pNzhT6Xx0` | P0 `30b35486` · P1 `341906c0` · P2 `53db02f4` |

Dependencies use GitHub **Sub-issues** (parent → tracked sub-issues); a sub-issue is
blocked iff its parent is open. Project Pipeline is the canonical pick order; body
`Depends on X` lines are legacy fallback only.
```

- [ ] **Step 2: Verify** the file exists and key facts are present.

Run: `grep -c "db:migrate:undo\|cashflow-backend\|PVT_kwHOAVVoss4BY3pN" .claude/conventions.md`
Expected: `3` or more (each canonical fact present).

- [ ] **Step 3: Commit**

```bash
git add .claude/conventions.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(devtools): add canonical .claude/conventions.md"
```

---

### Task 2: `guard-spine.mjs` (G2 — spine reminder) with tests

**Files:**
- Create: `.claude/hooks/guard-spine.test.mjs`
- Create: `.claude/hooks/guard-spine.mjs`

- [ ] **Step 1: Write the failing test** at `.claude/hooks/guard-spine.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpine } from './guard-spine.mjs';

test('warns on a NEW backend model file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/models/Foo.ts', fileExists: false });
  assert.match(warning, /primitives spine/i);
  assert.match(warning, /Transaction, Expectation/);
});

test('silent when the model file already exists (edit, not new)', () => {
  assert.deepEqual(classifySpine({ filePath: '/x/backend/src/models/Foo.ts', fileExists: true }), {});
});

test('silent on a non-matching path', () => {
  assert.deepEqual(classifySpine({ filePath: '/x/frontend/src/pages/Foo.tsx', fileExists: false }), {});
});

test('warns on a NEW route file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/tax/routes/scenarios.ts', fileExists: false });
  assert.match(warning, /route/);
});

test('warns on a NEW migration file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/migrations/20260605-foo.js', fileExists: false });
  assert.match(warning, /migration/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .claude/hooks/guard-spine.test.mjs`
Expected: FAIL — `Cannot find module './guard-spine.mjs'` (or "classifySpine is not a function").

- [ ] **Step 3: Write the implementation** at `.claude/hooks/guard-spine.mjs`:

```javascript
#!/usr/bin/env node
// PreToolUse(Write) guardrail (G2): nudge the 13-primitive build rule when a NEW
// model / migration / route file is created. Pure-inform — never blocks.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SPINE_SPEC = 'docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md';
const PRIMITIVES =
  'Transaction, Expectation, Account, Holding, Principal, Counterparty, Scenario, ' +
  'Budget, Goal, Proposal, Observation, Document, Period';

// Pure. Caller supplies fileExists. Returns { warning } or {}.
export function classifySpine({ filePath, fileExists }) {
  if (!filePath || fileExists) return {}; // only nudge on a NEW file
  const isModel = /\/backend\/src\/models\/[^/]+\.[tj]s$/.test(filePath);
  const isMigration = /\/backend\/src\/migrations\/[^/]+\.(c|m)?js$/.test(filePath);
  const isRoute = /\/backend\/(?:[^/]+\/)*routes\/[^/]+\.ts$/.test(filePath);
  if (!isModel && !isMigration && !isRoute) return {};
  const kind = isModel ? 'model' : isMigration ? 'migration' : 'route';
  return {
    warning:
      `Cashflow primitives spine — new ${kind} file. Answer the 3 checks before building:\n` +
      `1. Which of the 13 does this extend? Exactly one → extend it (type/kind field or column). ` +
      `None → new primitive (RARE, justify in the PR). Multiple → a relation/view, not a thing.\n` +
      `2. Persistent or derived? Derived → no table, add a query. Persistent → which primitive owns it?\n` +
      `3. Shape mirrors an existing primitive under a new name? → STOP, fold via a discriminator field.\n` +
      `The 13: ${PRIMITIVES}.\n` +
      `Full rule: ${SPINE_SPEC} and .claude/conventions.md.`,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try { payload = JSON.parse((await readStdin()) || '{}'); }
  catch { process.exit(0); } // never break the tool on a parse error
  const filePath = payload?.tool_input?.file_path;
  const { warning } = classifySpine({ filePath, fileExists: filePath ? existsSync(filePath) : true });
  if (warning) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning },
    }));
  }
  process.exit(0);
}

// Run main() only when executed directly, so tests can import classifySpine.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .claude/hooks/guard-spine.test.mjs`
Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/guard-spine.mjs .claude/hooks/guard-spine.test.mjs
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(devtools): add guard-spine.mjs PreToolUse hook (G2)"
```

---

### Task 3: `guard-bash.mjs` (G1 worktree + G4 commit hygiene) with tests

**Files:**
- Create: `.claude/hooks/guard-bash.test.mjs`
- Create: `.claude/hooks/guard-bash.mjs`

- [ ] **Step 1: Write the failing test** at `.claude/hooks/guard-bash.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBash, REPO_ROOT } from './guard-bash.mjs';

const WT = `${REPO_ROOT}/.claude/worktrees/feat-x`;

test('G4a denies staging a sqlite file', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: ['backend/data/cashflow.sqlite'], worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.match(r.deny, /never be committed/);
});

test('G4a denies staging node_modules', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: ['frontend/node_modules/foo/index.js'], worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.ok(r.deny);
});

test('clean commit: no deny, no warnings', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: REPO_ROOT,
    stagedFiles: ['backend/src/models/Foo.ts'], worktreeRoot: null, worktreeHasNodeModules: null });
  assert.equal(r.deny, undefined);
  assert.deepEqual(r.warnings, []);
});

test('G4b warns when routeRegistry.ts is staged', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: REPO_ROOT,
    stagedFiles: ['backend/src/routeRegistry.ts'], worktreeRoot: null, worktreeHasNodeModules: null });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /mount-order/);
});

test('G1a warns on yarn install under a worktree', () => {
  const r = classifyBash({ command: 'yarn install', cwd: WT,
    stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: false });
  assert.ok(r.warnings.some((w) => /vite-link/.test(w)));
});

test('G1a silent on yarn install in the main checkout', () => {
  const r = classifyBash({ command: 'yarn install', cwd: REPO_ROOT,
    stagedFiles: null, worktreeRoot: null, worktreeHasNodeModules: null });
  assert.deepEqual(r.warnings, []);
});

test('G1a does NOT match yarn test', () => {
  const r = classifyBash({ command: 'yarn test', cwd: WT,
    stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.ok(!r.warnings.some((w) => /vite-link/.test(w)));
});

test('G1c warns on git commit in a worktree without node_modules', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: [], worktreeRoot: WT, worktreeHasNodeModules: false });
  assert.ok(r.warnings.some((w) => /husky|lint-staged|127/.test(w)));
});

test('G1c silent when the worktree has node_modules', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: [], worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.ok(!r.warnings.some((w) => /husky/.test(w)));
});

test('G1b warns on a main-checkout path used inside a worktree', () => {
  const r = classifyBash({ command: `cat ${REPO_ROOT}/backend/src/app.ts`, cwd: WT,
    stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.ok(r.warnings.some((w) => /MAIN checkout/.test(w)));
});

test('G1b silent on a worktree-internal path', () => {
  const r = classifyBash({ command: `cat ${WT}/backend/src/app.ts`, cwd: WT,
    stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.ok(!r.warnings.some((w) => /MAIN checkout/.test(w)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .claude/hooks/guard-bash.test.mjs`
Expected: FAIL — `Cannot find module './guard-bash.mjs'`.

- [ ] **Step 3: Write the implementation** at `.claude/hooks/guard-bash.mjs`:

```javascript
#!/usr/bin/env node
// PreToolUse(Bash) guardrail: G1 (worktree) + G4 (commit hygiene).
// Default to non-blocking additionalContext; hard-deny ONLY for unambiguous commit
// mistakes (G4a). Never use ask/deny otherwise — it would stall headless background
// workers (the cashflow autonomous loop).
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = '/Users/connoradams/Developer/cashflow';
const FORBIDDEN_STAGED = /(\.sqlite(-journal)?$)|(^|\/)node_modules\/|(^|\/)backend\/data\//;

// Pure classifier. Caller supplies stagedFiles (or null when not a git commit/add)
// and worktree facts. Returns { deny?: string, warnings: string[] }.
export function classifyBash({ command, stagedFiles, worktreeRoot, worktreeHasNodeModules }) {
  const warnings = [];
  const inWorktree = !!worktreeRoot;
  const isGitCommit = /\bgit\s+commit\b/.test(command);

  // G4a — hard deny: staging files that must never be committed.
  if (Array.isArray(stagedFiles)) {
    const bad = stagedFiles.filter((f) => FORBIDDEN_STAGED.test(f));
    if (bad.length) {
      return {
        deny: `Refusing commit — these must never be committed: ${bad.join(', ')}. ` +
          `Run \`git restore --staged ${bad.join(' ')}\` first.`,
        warnings,
      };
    }
  }

  // G4b — warn: route registry / app.ts changed → run the mount-order test.
  if (Array.isArray(stagedFiles) &&
      stagedFiles.some((f) => /routeRegistry\.ts$|(^|\/)backend\/src\/app\.ts$/.test(f))) {
    warnings.push(
      'routeRegistry.ts/app.ts staged — run the mount-order regression test before merge: ' +
      '`cd backend && yarn tsx --import ./test/setup.ts --test test/appRouteOrder.test.ts`.');
  }

  // G1a — warn: yarn install/setup (or bare yarn) under a worktree fails (vite-link).
  if (inWorktree &&
      (/\byarn\s+(install|setup)\b/.test(command) || /^\s*yarn\s*(&&|;|\|\||$)/.test(command))) {
    warnings.push(
      `yarn install/setup fails under .claude/worktrees (vite-link). Install from the main ` +
      `checkout, or run binaries via \`PATH=${REPO_ROOT}/node_modules/.bin:$PATH …\`.`);
  }

  // G1c — warn: git commit in a worktree with no node_modules → husky/lint-staged fails (127).
  if (inWorktree && isGitCommit && worktreeHasNodeModules === false) {
    warnings.push(
      `This worktree has no node_modules — \`git commit\` will fail at husky→lint-staged ` +
      `(code 127). Prefix with \`PATH=${REPO_ROOT}/node_modules/.bin:$PATH git commit …\`.`);
  }

  // G1b — warn: absolute main-checkout path used inside a worktree.
  if (inWorktree) {
    const escaped = REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mainPathRe = new RegExp(`${escaped}/(backend|frontend|shared)/`);
    if (mainPathRe.test(command) && !command.includes(worktreeRoot)) {
      warnings.push(
        `A path points at the MAIN checkout (${REPO_ROOT}/…), not this worktree (${worktreeRoot}). ` +
        `Edits/reads there won't reflect your branch — use a path under the worktree.`);
    }
  }

  return { warnings };
}

function worktreeRootOf(cwd) {
  const m = (cwd || '').match(/^(.*\/\.claude\/worktrees\/[^/]+)/);
  return m ? m[1] : null;
}

function gitStagedFiles(cwd) {
  try {
    return execSync('git diff --cached --name-only', { cwd, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try { payload = JSON.parse((await readStdin()) || '{}'); }
  catch { process.exit(0); }
  const command = payload?.tool_input?.command || '';
  const cwd = payload?.cwd || process.cwd();
  const worktreeRoot = worktreeRootOf(cwd);
  const isGit = /\bgit\s+(commit|add)\b/.test(command);
  const stagedFiles = isGit ? gitStagedFiles(cwd) : null;
  const worktreeHasNodeModules = worktreeRoot ? existsSync(`${worktreeRoot}/node_modules`) : null;

  const { deny, warnings } = classifyBash({
    command, stagedFiles, worktreeRoot, worktreeHasNodeModules,
  });

  if (deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny,
      },
    }));
  } else if (warnings.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warnings.join('\n\n') },
    }));
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .claude/hooks/guard-bash.test.mjs`
Expected: PASS — 11 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/guard-bash.mjs .claude/hooks/guard-bash.test.mjs
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(devtools): add guard-bash.mjs PreToolUse hook (G1+G4)"
```

---

### Task 4: Wire the hooks via `settings.json` + end-to-end smoke

**Files:**
- Create: `.claude/settings.json`

- [ ] **Step 1: Create** `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-spine.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Smoke-test `main()` wiring** (the unit tests cover the pure function;
  this proves stdin→stdout JSON works end-to-end). The G1a path is deterministic
  (no git needed):

Run:
```bash
echo '{"tool_input":{"command":"yarn install"},"cwd":"/tmp/demo/.claude/worktrees/x"}' \
  | node .claude/hooks/guard-bash.mjs
```
Expected (one JSON line): contains `"additionalContext"` and `vite-link`.

- [ ] **Step 3: Smoke-test the spine hook**

Run:
```bash
echo '{"tool_input":{"file_path":"/tmp/demo/backend/src/models/NewThing.ts"}}' \
  | node .claude/hooks/guard-spine.mjs
```
Expected (one JSON line): contains `"additionalContext"` and `primitives spine`.
(`/tmp/demo/...` does not exist, so `fileExists` is false → the nudge fires.)

- [ ] **Step 4: Confirm valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(devtools): wire guard hooks via project settings.json"
```

> After this commit, the hooks are live for any Claude session in this repo. Inspect
> with `/hooks`; opt out with `"disableAllHooks": true` in personal settings. They
> also fire for the autonomous workers (and never block them — warn-only except the
> two G4a deny cases).

---

### Task 5: Fix drift in `cashflow-issue-worker` (global)

**Files:**
- Modify: `~/.claude/skills/cashflow-issue-worker/SKILL.md`

> Two confirmed drift bugs + a source-of-truth note. These are dotfiles edits — no
> cashflow-repo commit.

- [ ] **Step 1: Add the source-of-truth note.** Find the line `# Cashflow — Single-Issue Worker` and insert immediately AFTER it (before `## Overview`):

```markdown

> **Source of truth:** before acting, read
> `/Users/connoradams/Developer/cashflow/.claude/conventions.md` — the canonical,
> version-with-the-code reference for workspace names, test layout, the verify suite,
> worktree gotchas, and the GitHub Project board IDs. If anything in this skill
> contradicts that file, the file wins.
```

- [ ] **Step 2: Fix the test-dir drift (line ~93).** Replace:

```
- Backend: write the integration test in `backend/src/<area>/__tests__/` first. Run with `yarn workspace cashflow-backend run test` (uses `tsx --test`).
```

with:

```
- Backend: write the test in `backend/test/` (flat, auto-discovered `backend/test/**/*.test.ts`; integration under `test/integration/`). Run with `yarn workspace cashflow-backend run test` (runs `scripts/run-unit-tests.sh`; node:test via tsx).
```

- [ ] **Step 3: Fix the `db:rollback` drift (line ~122).** In the migration round-trip
  block, replace the line:

```
yarn workspace cashflow-backend run db:rollback   # confirm reversibility
```

with:

```
yarn workspace cashflow-backend run db:migrate:undo   # confirm reversibility (no db:rollback script)
```

- [ ] **Step 4: Verify** both bugs are gone and the note is present.

Run:
```bash
grep -n "src/<area>/__tests__\|db:rollback" ~/.claude/skills/cashflow-issue-worker/SKILL.md
grep -c "conventions.md" ~/.claude/skills/cashflow-issue-worker/SKILL.md
```
Expected: first grep prints **nothing** (both removed); second prints `1` or more.

---

### Task 6: Add note + board-ID pointer to `cashflow-tackle` (global)

**Files:**
- Modify: `~/.claude/skills/cashflow-tackle/SKILL.md`

> Deviation from spec (intentional): the spec said "replace the hardcoded board-ID
> table with a reference." But `cashflow-tackle` needs those IDs **inline** for its
> GraphQL mutations — deleting them would break the skill. Board-ID drift is also
> low-risk (a wrong ID fails loudly with a GraphQL error, unlike the silent test-dir
> drift). So: keep the IDs inline, mark `conventions.md` canonical, add a pointer.

- [ ] **Step 1: Add the source-of-truth note.** Find `# Cashflow — Tackle Open Issues` and insert immediately AFTER it:

```markdown

> **Source of truth:** before acting, read
> `/Users/connoradams/Developer/cashflow/.claude/conventions.md`. The GitHub Project
> board IDs below are mirrored there (canonical copy). If a GraphQL write 404s,
> reconcile against that file. If anything else here contradicts it, the file wins.
```

- [ ] **Step 2: Verify**

Run: `grep -c "conventions.md" ~/.claude/skills/cashflow-tackle/SKILL.md`
Expected: `1` or more.

---

### Task 7: Add note to `cashflow-product-design` (global)

**Files:**
- Modify: `~/.claude/skills/cashflow-product-design/SKILL.md`

- [ ] **Step 1: Add the source-of-truth note.** Find `# Cashflow — Product Design (Issue Author)` and insert immediately AFTER it:

```markdown

> **Source of truth:** before acting, read
> `/Users/connoradams/Developer/cashflow/.claude/conventions.md` — canonical for
> workspace names, test layout, verify suite, and the GitHub Project board IDs. If
> anything in this skill contradicts that file, the file wins.
```

- [ ] **Step 2: Verify**

Run: `grep -c "conventions.md" ~/.claude/skills/cashflow-product-design/SKILL.md`
Expected: `1` or more.

---

### Task 8: New `cashflow-fleet-status` skill (global, L3)

**Files:**
- Create: `~/.claude/skills/cashflow-fleet-status/SKILL.md`

- [ ] **Step 1: Create the skill file** with this exact content:

```markdown
---
name: cashflow-fleet-status
description: Use when Connor says "cashflow fleet status", "check cashflow workers", "what are my cashflow workers doing", "are any cashflow PRs stuck", or "/cashflow-fleet-status" — a READ-ONLY snapshot of the autonomous-loop fleet: active worktrees, open claude/issue-* PRs, their CI/merge state, and which are orphaned (untended). Reports only; never spawns workers or fixes PRs (that is cashflow-tackle's job). Not for non-cashflow repos.
---

# Cashflow — Fleet Status (read-only)

## Overview

A one-shot health snapshot of the `cashflow-tackle` fleet. Answers "what are my
workers doing, and is anything stuck?" without touching anything. To actually FIX
orphans, run `cashflow-tackle` — it owns dispatch + the orphan sweep.

## When to use

- Connor asks for fleet/worker status, or whether any cashflow PRs are stuck.
- Triggers: "cashflow fleet status", "check cashflow workers", "are cashflow PRs stuck", `/cashflow-fleet-status`.

When NOT to use:
- Connor wants to START or FIX work → `cashflow-tackle`.
- A specific single issue → `cashflow-issue-worker`.
- Non-cashflow repo.

## Source of truth

Read `/Users/connoradams/Developer/cashflow/.claude/conventions.md` for the repo path
and GitHub Project board IDs. Do not restate those facts here.

## Steps

1. **Worktrees** (from the main checkout):

   ```bash
   git -C /Users/connoradams/Developer/cashflow worktree list
   ```

2. **Open worker PRs** with CI + merge state:

   ```bash
   gh pr list --repo Connor-Adams/cashflow --state open --search "head:claude/issue-" \
     --json number,title,headRefName,mergeable,autoMergeRequest,statusCheckRollup,updatedAt
   ```

3. **Join** worktree ↔ PR by branch name (`headRefName` vs the branch checked out in
   each worktree from step 1).

4. **Classify each PR** (same rules as `cashflow-tackle` §9 orphan sweep). Mark
   **orphan** if ANY:
   - `mergeable == "CONFLICTING"` (needs rebase)
   - `autoMergeRequest == null` (auto-merge off / disengaged)
   - any `statusCheckRollup` conclusion `== "FAILURE"` and `updatedAt` > ~10 min ago
   - `updatedAt` > ~30 min ago and not merged (stale)

5. **Print one compact table**: PR# · issue# · branch · worktree? · CI (pass/fail/pending)
   · auto-merge? · orphan-reason · age. Sort orphans first.

6. If any orphans: end with one line — "N orphan(s); run `cashflow-tackle` to sweep."
   Otherwise: "fleet healthy."

## Anti-patterns

- ❌ Spawning workers or babysitters — this skill is read-only. That's `cashflow-tackle`.
- ❌ Force-pushing, re-arming auto-merge, or resolving conflicts here.
- ❌ Restating board IDs / repo paths instead of reading `conventions.md`.
- ❌ Polling in a loop — this is a one-shot snapshot. Re-invoke to refresh.
```

- [ ] **Step 2: Verify** the frontmatter is valid and the file is discoverable.

Run:
```bash
head -4 ~/.claude/skills/cashflow-fleet-status/SKILL.md
grep -c "read-only\|gh pr list\|orphan" ~/.claude/skills/cashflow-fleet-status/SKILL.md
```
Expected: frontmatter shows `name: cashflow-fleet-status`; grep ≥ `3`.

---

## Final verification

- [ ] **Repo tests pass:** `node --test .claude/hooks/*.test.mjs` → all 20 spine + bash tests green. (`node --test <dir>` does NOT recurse in this Node setup — use the glob.)
- [ ] **Repo committed cleanly:** `git log --oneline -5` shows the four `feat(devtools)` commits; `git status` clean.
- [ ] **Global edits verified:** the four grep checks in Tasks 5–8 pass.
- [ ] **Live hook check (manual, optional):** in a fresh session rooted at the repo,
  run `/hooks` and confirm two `[Project]` PreToolUse entries (Bash, Write) appear.

## Self-review notes (deviations from spec, surfaced for the reviewer)

1. **Extra drift fixed:** the spec named only the line-93 test-dir bug; implementation
   also fixes a second bug in the same skill — `db:rollback` → `db:migrate:undo`
   (Task 5, Step 3). No `db:rollback` script exists.
2. **Board IDs kept inline in `cashflow-tackle`** rather than deleted (Task 6 note) —
   the GraphQL mutations need them; `conventions.md` is the canonical mirror.
3. **Hooks designed as pure `classify*` functions** + a thin `main()` stdin wrapper,
   so the test suite is fast and side-effect-free (git/fs facts are injected).
4. **Post-implementation code-review fixes (applied during execution):** removed an
   unused `cwd` param from `classifyBash`; anchored the G4b `app.ts` regex and the
   guard-spine `isRoute` regex to `backend/` (they were matching any workspace's
   `app.ts` / `routes/`); strengthened the suite to 20 tests (added frontend-route
   and non-backend-`app.ts` negatives, a top-level backend route, a `.cjs` migration).
   Run hook tests with `node --test .claude/hooks/*.test.mjs` (the `<dir>` form does
   not recurse here).
```


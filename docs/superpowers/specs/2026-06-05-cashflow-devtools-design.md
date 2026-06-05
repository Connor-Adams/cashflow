# Cashflow Dev-Tools Toolkit

**Date:** 2026-06-05
**Status:** Approved (pending spec review)
**Type:** Tooling / developer-experience (not a product feature)

## Problem

All Cashflow-specific Claude tooling today is **global skills** (`~/.claude/skills`
via dotfiles) aimed at one job: the autonomous issue→PR→merge loop
(`cashflow-issue-worker`, `cashflow-tackle`, `cashflow-product-design`). The
project's own `.claude/` holds **zero** skills/hooks/agents — only `worktrees/`.
Two gaps follow from that:

1. **No cashflow-aware guardrails.** Nothing catches cashflow-specific mistakes:
   running `yarn install` under `.claude/worktrees` (fails with a vite-link error),
   using an absolute *main-checkout* path while inside a worktree (silently hits the
   wrong tree), adding a new model/route/migration without applying the 13-primitive
   build rule, or staging `cashflow.sqlite` / `node_modules` into a commit.

2. **Convention drift.** Because the global skills *restate* repo facts instead of
   *reading* them, they go stale. Confirmed bug: `cashflow-issue-worker` SKILL.md
   line 93 tells workers to write backend tests in `backend/src/<area>/__tests__/`,
   but the repo moved to a flat, auto-discovered `backend/test/**/*.test.ts` tree.
   `cashflow-tackle` hardcodes GitHub Projects v2 field/option IDs and both skills
   hand-list the verify suite — same drift risk.

The disease behind (2) is duplication of truth. The fix principle is **facts live in
the repo; skills and hooks read them, never restate them.**

## Scope

In scope ("Recommended core"):

- **Backbone** — a committed `conventions.md` single source of truth; fix the
  line-93 drift bug; point the three global skills at the file.
- **Guardrail hooks** — G1 worktree, G2 primitives-spine, G4 commit hygiene.
- **L3 observability** — a new read-only `cashflow-fleet-status` skill.

Out of scope (honest follow-ups, deferred by decision):

- **G3 dual-dialect SQL** detection — heuristic, false-positive-prone, low ROI.
- **Heavy L1 worker stay-alive** via a `SubagentStop` guard — can infinite-loop;
  risky. The drift fix + fleet-status already attack worker reliability from the
  safe side.

## Design principles

1. **Facts in the repo.** Volatile facts (workspace names, test dir, verify suite,
   board IDs, spine rule) live in `.claude/conventions.md`, committed and reviewed in
   PRs. Skills/hooks defer to it.
2. **Hooks must never deadlock a headless worker.** A `PreToolUse` returning `ask`
   or `deny` with no human present stalls a background agent. Therefore guardrail
   hooks **default to non-blocking `additionalContext`** (inject a reminder, let the
   tool proceed). Hard `deny` is reserved for the two *unambiguous* mistakes
   (staging `*.sqlite` or `node_modules`). Because committed project hooks ride in
   each worktree checkout and fire for subagents, this also protects the autonomous
   loop — which is exactly why they must not block.

## Component 1 — `conventions.md` (the backbone)

New committed file: `.claude/conventions.md`. Authoritative cheat-sheet. The three
global skills get a header note: *"Before acting, read
`<repo>/.claude/conventions.md`. If this skill contradicts it, the file wins."*

Sections:

- **Workspaces.** `cashflow-backend` (NOT `backend`); `frontend` (no `typecheck`
  script — use `tsc -b`); `shared` → `@cashflow/shared`.
- **Tests.** `node:test` via `tsx`; backend tests live in `backend/test/**/*.test.ts`
  (auto-discovered by `run-unit-tests.sh` → `list-unit-tests.mjs`; `test/integration/**`
  excluded). All: `yarn test`. One file: `cd backend && yarn tsx --import
  ./test/setup.ts --test test/<f>.test.ts`. Name filter: `--test-name-pattern`.
  Frontend uses vitest. No `--run` flag on backend.
- **Verify suite.** Prefer `yarn ci` (typecheck + tests + both builds). Individual
  commands listed for partial runs. Migration round-trip: `db:migrate` /
  `db:migrate:undo`.
- **Worktree gotcha.** `yarn install`/`setup` fails under `.claude/worktrees`
  (vite-link). Run installs from the main checkout, or invoke binaries via
  `PATH=<repo>/node_modules/.bin:$PATH`.
- **Primitives spine.** Pointer to
  `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`, the 13 names,
  and the 3-check build rule, verbatim from CLAUDE.md.
- **Commit / PR.** Sole author, no Co-Authored-By; auto-merge with merge commit,
  never squash; never commit `*.sqlite` / `node_modules` / `backend/data/`.
- **GitHub Project board.** URL, project node ID `PVT_kwHOAVVoss4BY3pN`, the field
  IDs + option IDs — **moved here** from `cashflow-tackle` so there is one copy.

> During implementation, every command string copied into `conventions.md` is
> verified against root `package.json` + `backend/package.json` (script names may
> differ from what the skills currently assume — e.g. confirm `cashflow-backend`'s
> `test`/`typecheck`/`lint`/`db:*` script names).

## Component 2 — Guardrail hooks

Two Node ESM scripts (zero deps; `node` is guaranteed in this monorepo) under
`.claude/hooks/`. Each reads the PreToolUse JSON on stdin and writes one JSON object
on stdout (exit 0). Hook stdin shape (verified against current docs):
`{session_id, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id}`
where Bash `tool_input = {command, description?, timeout?, run_in_background?}` and
Write `tool_input = {file_path, content}`.

Output contracts (verified):

- **Non-blocking inject:** exit 0 +
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}`
- **Deny with reason:** exit 0 +
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
- **No objection:** exit 0, no stdout.

### `guard-bash.mjs` — matcher `Bash` (covers G1 + G4)

Parse `tool_input.command` and `cwd`. Apply, in order:

| Rule | Condition | Action |
|---|---|---|
| **G4a** commit hygiene | command is `git commit` (or `git add` of an offending path); `git diff --cached --name-only` (run with `cwd`) contains a path matching `\.sqlite$`, `(^|/)node_modules/`, or `(^|/)backend/data/` | **deny** — "Refusing: `<files>` must not be committed. `git restore --staged <file>` first." |
| **G4b** mount-order | command is `git commit`; staged set includes `routeRegistry.ts` or `src/app.ts` | **warn** — "routeRegistry/app.ts changed — run `appRouteOrder.test.ts` before merge." |
| **G1a** worktree install | `cwd` contains `/.claude/worktrees/` and command matches `yarn\s+(install|setup)\b` or a bare `yarn` with no subcommand (`yarn test`/`yarn dev`/etc. must NOT match) | **warn** — vite-link failure + PATH workaround. |
| **G1b** main-path-in-worktree | `cwd` is under `/.claude/worktrees/<name>/` and command contains an absolute `<repo>/(backend\|frontend\|shared)/…` path that is NOT under the current worktree | **warn** — "that path hits the MAIN checkout, not this worktree." |

Precedence: if **G4a** matches, emit the `deny` and stop (deny short-circuits the
tool). Otherwise concatenate any warnings (G4b/G1a/G1b) into one `additionalContext`
string. The `git diff --cached` call runs **only** when the command involves `git
commit`/`git add` — never on unrelated Bash.

### `guard-spine.mjs` — matcher `Write` (G2)

Parse `tool_input.file_path`. Fire only for a **new** file
(`!fs.existsSync(file_path)`) whose path matches one of:
`backend/src/models/…`, `backend/src/migrations/…`, or `…/routes/<name>.ts`.
Action: **warn** (`additionalContext`) with the 3-check spine rule (condensed) + the
13 primitive names + pointers to the spine spec and `conventions.md`. Editing an
existing file does not fire — a new status machine arrives as a new file. Never
blocks.

## Component 3 — `settings.json` wiring

New committed `.claude/settings.json` with two PreToolUse entries:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command",
          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs\"",
          "timeout": 10 }] },
      { "matcher": "Write",
        "hooks": [{ "type": "command",
          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-spine.mjs\"",
          "timeout": 10 }] }
    ]
  }
}
```

These **merge** with the user's existing global hooks (both run). Project hooks
auto-load with **no approval prompt**; inspect via `/hooks`, opt out via
`"disableAllHooks": true` in personal settings.

## Component 4 — Skill edits (kill the drift)

Edit the three global skills under `~/.claude/skills/`:

- **`cashflow-issue-worker`** — fix line 93 (`backend/src/<area>/__tests__/` →
  `backend/test/`); reconcile every command reference with `conventions.md`; add the
  "Source of truth" header note. Update the kindex-gotchas block (lines ~330-338) to
  point at `conventions.md` instead of restating.
- **`cashflow-tackle`** — replace the hardcoded board-ID table with a reference to
  the GitHub Project section of `conventions.md`; add the header note.
- **`cashflow-product-design`** — add the header note.

The note (all three):

> **Source of truth:** before acting, read
> `/Users/connoradams/Developer/cashflow/.claude/conventions.md`. If anything in this
> skill contradicts that file, the file wins — it versions with the code; this skill
> does not.

## Component 5 — `cashflow-fleet-status` skill (L3)

New **global** skill `~/.claude/skills/cashflow-fleet-status/SKILL.md` (kept global so
it is invokable from any session, like `cashflow-tackle`). Read-only — it reports,
never spawns or fixes.

- **Triggers:** "cashflow fleet status", "check cashflow workers", "what are my
  cashflow workers doing", `/cashflow-fleet-status`.
- **Steps:** read `conventions.md` for repo path + board IDs; `git worktree list`
  (from the main checkout); `gh pr list --repo Connor-Adams/cashflow --state open
  --search "head:claude/issue-" --json
  number,title,headRefName,mergeable,autoMergeRequest,statusCheckRollup,updatedAt`;
  join worktree↔PR by branch name; classify orphans using `cashflow-tackle` §9
  (CONFLICTING / auto-merge off / CI-failed >10 min / stale >30 min).
- **Output:** one compact table — PR#, issue, branch, worktree?, CI rollup,
  auto-merge?, orphan-reason, age — plus a one-line suggestion to run
  `cashflow-tackle` if orphans exist. Cost/token telemetry is a future add, not in
  this pass.

## Testing

Hooks are pure stdin→stdout, so test by fixture. Colocate `guard-bash.test.mjs` and
`guard-spine.test.mjs` beside the hooks, using `node:test`; run with
`node --test .claude/hooks/`. Cover, at minimum:

- G4a denies a `git commit` with a staged `*.sqlite` / `node_modules` path; allows a
  clean commit.
- G4b warns when `routeRegistry.ts` is staged; silent otherwise.
- G1a warns on `yarn install` when `cwd` is a worktree; silent when `cwd` is the main
  checkout.
- G2 warns on a new `backend/src/models/Foo.ts`; silent on an edit to an existing
  model and on a non-matching path.

Not wired to CI in this pass (dev tooling); a root `yarn hooks:test` script is an
optional follow-up.

## File manifest

Create (committed to repo, this branch):

- `.claude/conventions.md`
- `.claude/settings.json`
- `.claude/hooks/guard-bash.mjs`
- `.claude/hooks/guard-spine.mjs`
- `.claude/hooks/guard-bash.test.mjs`
- `.claude/hooks/guard-spine.test.mjs`

Create (global, outside the repo):

- `~/.claude/skills/cashflow-fleet-status/SKILL.md`

Edit (global, outside the repo):

- `~/.claude/skills/cashflow-issue-worker/SKILL.md`
- `~/.claude/skills/cashflow-tackle/SKILL.md`
- `~/.claude/skills/cashflow-product-design/SKILL.md`

## Open questions

- Exact `cashflow-backend` script names (`test`/`typecheck`/`lint`/`db:*`) — verify
  against `package.json` during implementation; `conventions.md` records the verified
  truth.
- Whether to derive the repo root in hook warnings dynamically vs. hardcode
  `/Users/connoradams/Developer/cashflow` (current skills hardcode it; matching that
  for now).

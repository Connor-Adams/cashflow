import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBash, addedOrModifiedFromNameStatus, invokesGit, REPO_ROOT } from './guard-bash.mjs';

const WT = `${REPO_ROOT}/.claude/worktrees/feat-x`;

test('addedOrModifiedFromNameStatus keeps A/M/R but drops D (deletions)', () => {
  // Untracking a forbidden file is a DELETION — it must not be reported as staged,
  // otherwise G4a would block the very cleanup it exists to encourage (issue #824).
  const out = [
    'D\tbackend/data/cashflow.sqlite.pre-reimport-backup',
    'M\t.gitignore',
    'A\tbackend/src/models/Foo.ts',
    'R100\told/path.ts\tnew/path.ts',
  ].join('\n');
  assert.deepEqual(addedOrModifiedFromNameStatus(out), [
    '.gitignore',
    'backend/src/models/Foo.ts',
    'new/path.ts',
  ]);
});

test('G4a does NOT deny when the sqlite file is only being deleted', () => {
  // Simulate what gitStagedFiles now returns for a `git rm --cached` of the backup:
  // the deletion is filtered out, leaving only the gitignore edit.
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: ['.gitignore'], worktreeRoot: WT, worktreeHasNodeModules: true });
  assert.equal(r.deny, undefined);
});

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

test('G4b does NOT warn on a non-backend src/app.ts', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: REPO_ROOT,
    stagedFiles: ['frontend/src/app.ts'], worktreeRoot: null, worktreeHasNodeModules: null });
  assert.deepEqual(r.warnings, []);
});

test('yarn install inside a worktree is NOT warned about (Yarn 4: the worktree is its own install root)', () => {
  // The old G1a claimed `yarn install` fails under .claude/worktrees (a Yarn-1
  // vite-link bug) and pointed at the main checkout. Under Yarn 4 that advice is
  // wrong — see .claude/conventions.md "Worktree gotchas".
  for (const command of ['corepack yarn install', 'yarn install', 'yarn setup', 'grep -rn "yarn install" docs']) {
    const r = classifyBash({ command, cwd: WT,
      stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: false });
    assert.deepEqual(r.warnings, [], command);
  }
});

test('G1c warns on git commit in a worktree without node_modules', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: [], worktreeRoot: WT, worktreeHasNodeModules: false });
  assert.ok(r.warnings.some((w) => /husky|lint-staged|127/.test(w)));
});

test('G1c advises installing in the worktree, never the main checkout', () => {
  const r = classifyBash({ command: 'git commit -m x', cwd: WT,
    stagedFiles: [], worktreeRoot: WT, worktreeHasNodeModules: false });
  const w = r.warnings.find((x) => /husky/.test(x));
  assert.match(w, /corepack yarn install/);
  assert.ok(w.includes(WT));
  assert.ok(!w.includes(`${REPO_ROOT}/node_modules`), 'must not point at the main checkout node_modules');
});

test('G1c ignores text that merely mentions git commit', () => {
  const r = classifyBash({ command: 'grep -rn "git commit" docs', cwd: WT,
    stagedFiles: null, worktreeRoot: WT, worktreeHasNodeModules: false });
  assert.deepEqual(r.warnings, []);
});

test('invokesGit matches real invocations only', () => {
  assert.ok(invokesGit('git commit -m x', 'commit'));
  assert.ok(invokesGit('cd backend && git commit -m x', 'commit'));
  assert.ok(invokesGit('FOO=1 git -C /tmp/wt commit -m x', 'commit'));
  assert.ok(invokesGit('git add -A; git commit -m x', 'add'));
  assert.ok(!invokesGit('grep "git commit" README.md', 'commit'));
  assert.ok(!invokesGit('echo use git add here', 'add'));
  assert.ok(!invokesGit('git commit-tree abc', 'commit'));
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBash, addedOrModifiedFromNameStatus, REPO_ROOT } from './guard-bash.mjs';

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

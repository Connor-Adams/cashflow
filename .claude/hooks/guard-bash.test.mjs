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

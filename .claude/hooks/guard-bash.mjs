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
export function classifyBash({ command, cwd, stagedFiles, worktreeRoot, worktreeHasNodeModules }) {
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
      stagedFiles.some((f) => /routeRegistry\.ts$|(^|\/)src\/app\.ts$/.test(f))) {
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
    command, cwd, stagedFiles, worktreeRoot, worktreeHasNodeModules,
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

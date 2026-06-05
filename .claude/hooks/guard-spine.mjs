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

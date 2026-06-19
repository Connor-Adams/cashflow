#!/usr/bin/env node
/**
 * Diffs current fallow dead-code findings against the committed baseline
 * (audit-baseline.json) and creates one GitHub `chore` issue per new finding.
 *
 * Modes:
 *   node scripts/audit-issues.cjs              — diff + create issues (CI use)
 *   node scripts/audit-issues.cjs --baseline   — print baseline JSON from current
 *                                                reports (run once after setup)
 *   node scripts/audit-issues.cjs --dry-run    — print new findings without
 *                                                creating issues
 *
 * Required env vars (for issue creation):
 *   GITHUB_TOKEN       — GITHUB_TOKEN or PAT with issues:write
 *   GITHUB_REPOSITORY  — "owner/repo"  (set automatically by GitHub Actions)
 *   GITHUB_SHA         — commit SHA    (set automatically by GitHub Actions)
 *   GITHUB_SERVER_URL  — e.g. https://github.com (set automatically)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { githubRequest: rawGithubRequest, ensureLabel: rawEnsureLabel } = require('./github-rest.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEADCODE_JSON = path.join(ROOT, 'reports', 'fallow-deadcode.json');
// Tracked at repo root (NOT under .fallow/, which is gitignored and carries
// fallow's own auto-generated `.gitignore: *` that would un-track the file).
const BASELINE_JSON = path.join(ROOT, 'audit-baseline.json');

const DRY_RUN = process.argv.includes('--dry-run');
const WRITE_BASELINE = process.argv.includes('--baseline');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('{');
    return JSON.parse(start > 0 ? raw.slice(start) : raw);
  } catch {
    return null;
  }
}

/**
 * Extract individual dead-code findings from the fallow JSON report.
 * Returns an array of { key, category, name, file, line }.
 *
 * The fallow JSON structure is:
 *   { summary: { unused_exports: N, ... }, unused_exports: [...], unused_files: [...], ... }
 *
 * Item shapes vary by category — we normalise to { name, file, line? }.
 */
function extractFindings(dc) {
  if (!dc) return [];

  const results = [];

  function add(category, name, file, line) {
    const key = `${category}:${file}:${name}`;
    results.push({ key, category, name, file, line: line ?? null });
  }

  // unused_exports / unused_types / unused_class_members / unused_enum_members
  for (const cat of ['unused_exports', 'unused_types', 'unused_class_members', 'unused_enum_members']) {
    const items = dc[cat];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const name = item.name ?? item.symbol ?? String(item);
      const file = item.file ?? item.path ?? '(unknown)';
      add(cat, name, file, item.line ?? item.start_line);
    }
  }

  // unused_files — the item itself is the file
  const unusedFiles = dc.unused_files;
  if (Array.isArray(unusedFiles)) {
    for (const item of unusedFiles) {
      const file = item.path ?? item.file ?? String(item);
      add('unused_file', file, file, null);
    }
  }

  // circular_dependencies — pairs of files
  const circular = dc.circular_dependencies;
  if (Array.isArray(circular)) {
    for (const item of circular) {
      // Typically { from: 'a.ts', to: 'b.ts' } or similar
      const from = item.from ?? item.file ?? String(item);
      const to = item.to ?? '';
      const name = to ? `${from} → ${to}` : from;
      add('circular_dependency', name, from, item.line ?? null);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

function loadBaseline() {
  const data = readJson(BASELINE_JSON);
  if (!data || !Array.isArray(data.findings)) return new Set();
  return new Set(data.findings);
}

/**
 * Return the findings whose `key` is not present in the baseline set.
 * Pure — the diff is what decides which findings become NEW chore issues.
 *
 * @param {Array<{key: string}>} findings
 * @param {Set<string>} baseline
 * @returns {Array<{key: string}>}
 */
function diffFindings(findings, baseline) {
  return findings.filter((f) => !baseline.has(f.key));
}

// ---------------------------------------------------------------------------
// GitHub API (thin wrappers over the shared scripts/github-rest.cjs client)
// ---------------------------------------------------------------------------

const githubRequest = (method, urlPath, body) =>
  rawGithubRequest(method, urlPath, body, 'cashflow-audit-issues');

const ensureLabel = (repo, name, color, description) =>
  rawEnsureLabel(githubRequest, repo, name, color, description);

async function createIssue(repo, title, body, labels) {
  return githubRequest('POST', `/repos/${repo}/issues`, { title, body, labels });
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

const RULE_LABELS = {
  unused_exports: 'unused-export',
  unused_types: 'unused-type',
  unused_class_members: 'unused-class-member',
  unused_enum_members: 'unused-enum-member',
  unused_file: 'unused-file',
  circular_dependency: 'circular-dependency',
};

const REMEDIATION = {
  unused_exports: 'Remove the export, or add `// fallow-ignore-unused-exports` with a one-line justification if it is intentionally public.',
  unused_types: 'Remove the type export, or add `// fallow-ignore-unused-exports` if it is part of a public API.',
  unused_class_members: 'Remove the member, or mark it with `// fallow-ignore-unused-members` if it is part of a serialized format.',
  unused_enum_members: 'Remove the enum member, or mark it with `// fallow-ignore-unused-members`.',
  unused_file: 'Delete the file or wire it into the dependency graph (import it from an active module).',
  circular_dependency: 'Break the cycle by extracting shared types to a separate module or inverting a dependency direction.',
};

function buildIssueBody(finding, sha, serverUrl, repo) {
  const { category, name, file, line } = finding;
  const rule = RULE_LABELS[category] ?? category;
  const remedy = REMEDIATION[category] ?? 'Remove or document this finding.';

  const blobBase = `${serverUrl}/${repo}/blob/${sha ?? 'main'}`;
  const fileLink = line
    ? `[${file}](${blobBase}/${file}#L${line})`
    : `[${file}](${blobBase}/${file})`;

  return `Fallow flagged \`${name}\` as a **${rule}**.

**File:** ${fileLink}
**Rule:** \`${rule}\`

## Remediation

- [ ] ${remedy}

---
_Auto-created by the [code-audit workflow](${serverUrl}/${repo}/actions/workflows/audit-issues.yml) on commit \`${(sha ?? 'unknown').slice(0, 8)}\`. Update [audit-baseline.json](${serverUrl}/${repo}/blob/main/audit-baseline.json) after this is resolved._`;
}

function buildIssueTitle(finding) {
  const { category, name, file } = finding;
  const rule = RULE_LABELS[category] ?? category;
  // Trim long file paths to the last two segments
  const shortFile = file.split('/').slice(-2).join('/');
  return `[chore] ${rule} \`${name}\` in ${shortFile}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dc = readJson(DEADCODE_JSON);
  if (!dc) {
    console.log('No fallow dead-code report found at', DEADCODE_JSON, '— skipping.');
    process.exit(0);
  }

  const findings = extractFindings(dc);
  console.log(`Found ${findings.length} total dead-code findings.`);

  if (WRITE_BASELINE) {
    const baseline = { version: 1, findings: findings.map((f) => f.key) };
    fs.writeFileSync(BASELINE_JSON, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Wrote baseline with ${findings.length} entries to ${BASELINE_JSON}`);
    return;
  }

  const known = loadBaseline();
  const newFindings = diffFindings(findings, known);
  console.log(`${newFindings.length} new findings not in baseline.`);

  if (newFindings.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    for (const f of newFindings) {
      console.log(' NEW:', f.key);
    }
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';

  if (!repo) {
    console.error('GITHUB_REPOSITORY not set — cannot create issues.');
    process.exit(1);
  }

  // Ensure the labels we need exist
  await ensureLabel(repo, 'chore', 'C5DEF5', 'Maintenance / cleanup task');
  await ensureLabel(repo, 'code-audit', '0075CA', 'Found by automated code audit');
  await ensureLabel(repo, 'audit:dead-code', 'E4E669', 'Dead-code finding from fallow');

  let created = 0;
  for (const finding of newFindings) {
    const title = buildIssueTitle(finding);
    const body = buildIssueBody(finding, sha, serverUrl, repo);
    const labels = ['chore', 'code-audit', 'audit:dead-code'];

    console.log(`Creating issue: ${title}`);
    try {
      const issue = await createIssue(repo, title, body, labels);
      console.log(`  → #${issue.number} ${issue.html_url}`);
      created++;
      // Polite rate-limit backoff between requests
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.error(`  Failed to create issue for ${finding.key}:`, e.message);
    }
  }

  console.log(`Done — created ${created} issue(s).`);
}

module.exports = {
  extractFindings,
  diffFindings,
  buildIssueTitle,
  buildIssueBody,
  RULE_LABELS,
  REMEDIATION,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

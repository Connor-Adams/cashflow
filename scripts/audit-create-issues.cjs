#!/usr/bin/env node
/**
 * Diffs the current fallow dead-code report against a committed baseline and
 * emits a JSON array of new findings to stdout. The CI workflow (ci.yml
 * `audit-create-issues` job) pipes this output into `actions/github-script`
 * to create one GitHub issue per new finding.
 *
 * The baseline is stored in .fallow/baseline.json (committed) and updated
 * automatically on every push to main. First-run baseline is empty: no issues
 * fire for pre-existing findings on bootstrap.
 *
 * Usage (CI):
 *   node scripts/audit-create-issues.cjs > /tmp/new-findings.json
 *
 * Exit codes:
 *   0  — success (even if there are new findings; the caller creates the issues)
 *   1  — fatal error reading report or baseline
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const DEADCODE_JSON = path.join(ROOT, 'reports', 'fallow-deadcode.json');
const BASELINE_JSON = path.join(ROOT, '.fallow', 'baseline.json');

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('{');
    return JSON.parse(start > 0 ? raw.slice(start) : raw);
  } catch {
    return null;
  }
}

const EMPTY_BASELINE = {
  unused_exports: [],
  unused_files:   [],
  unused_types:   [],
  version: 1,
};

// Returns a Set of "file:name" dedup keys from a list of unused export items.
function exportKeys(items) {
  return new Set((items || []).map((e) => `${e.file || ''}:${e.name || ''}`));
}

// Returns a Set of file paths from a list of unused file items.
function fileKeys(items) {
  return new Set((items || []).map((f) => String(f.path || f.file || f)));
}

function blobUrl(filePath, line) {
  const rel = filePath.replace(/^\/+/, '');
  const lineFragment = line ? `#L${line}` : '';
  return `https://github.com/Connor-Adams/cashflow/blob/main/${rel}${lineFragment}`;
}

const report   = readJson(DEADCODE_JSON);
const baseline = readJson(BASELINE_JSON) || EMPTY_BASELINE;

if (!report) {
  process.stderr.write('audit-create-issues: dead-code report not found; skipping.\n');
  process.stdout.write('[]\n');
  process.exit(0);
}

const newFindings = [];

// Unused exports: new keys not in baseline.
const baseExportKeys = exportKeys(baseline.unused_exports);
for (const item of report.unused_exports || []) {
  const key = `${item.file || ''}:${item.name || ''}`;
  if (!baseExportKeys.has(key)) {
    newFindings.push({
      type: 'unused-export',
      title: `[chore] unused export \`${item.name}\` in ${item.file}`,
      body: [
        `**Rule:** unused export (fallow dead-code)`,
        `**File:** [${item.file}${item.line ? `:${item.line}` : ''}](${blobUrl(item.file, item.line)})`,
        `**Symbol:** \`${item.name}\``,
        '',
        '**Suggested fix:** Remove the export if unused, or add `// fallow-ignore-unused-export` if intentional.',
        '',
        '- [ ] Remove or document',
      ].join('\n'),
      labels: ['chore', 'code-audit', 'audit:dead-code'],
    });
  }
}

// Unused files: new paths not in baseline.
const baseFileKeys = fileKeys(baseline.unused_files);
for (const item of report.unused_files || []) {
  const filePath = String(item.path || item.file || item);
  if (!baseFileKeys.has(filePath)) {
    newFindings.push({
      type: 'unused-file',
      title: `[chore] unused file ${filePath}`,
      body: [
        `**Rule:** unused file (fallow dead-code)`,
        `**File:** [${filePath}](${blobUrl(filePath, null)})`,
        '',
        '**Suggested fix:** Delete the file if it is no longer needed.',
        '',
        '- [ ] Remove or document',
      ].join('\n'),
      labels: ['chore', 'code-audit', 'audit:dead-code'],
    });
  }
}

process.stdout.write(JSON.stringify(newFindings, null, 2) + '\n');

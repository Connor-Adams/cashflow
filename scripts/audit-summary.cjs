#!/usr/bin/env node
/**
 * Builds a concise Markdown summary of the code-audit results for posting as a
 * pull-request comment. Sources:
 *   - reports/fallow-deadcode.json  (`fallow dead-code --format json`)
 *   - reports/fallow-health.json    (`fallow health --format json`)
 *   - reports/jscpd/jscpd-report.json (`jscpd --reporters json`)
 *
 * Usage: node scripts/audit-summary.cjs > comment.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEADCODE_JSON = path.join(ROOT, 'reports', 'fallow-deadcode.json');
const HEALTH_JSON = path.join(ROOT, 'reports', 'fallow-health.json');
const JSCPD_JSON = path.join(ROOT, 'reports', 'jscpd', 'jscpd-report.json');

const MARKER = '<!-- code-audit-summary -->';
const MISSING = (tool) => `> ⚠️ ${tool} report not found — see the workflow logs.`;

// Dead-code summary fields worth surfacing, in display order.
const DEADCODE_CATEGORIES = [
  ['unused_files', 'Unused files'],
  ['unused_exports', 'Unused exports'],
  ['unused_types', 'Unused exported types'],
  ['unused_class_members', 'Unused class members'],
  ['unused_enum_members', 'Unused enum members'],
  ['duplicate_exports', 'Duplicate exports'],
  ['unused_dependencies', 'Unused dependencies'],
  ['unlisted_dependencies', 'Unlisted dependencies'],
  ['unresolved_imports', 'Unresolved imports'],
  ['circular_dependencies', 'Circular dependencies'],
  ['private_type_leaks', 'Private type leaks'],
];

// Tolerant of a leading CLI banner (e.g. yarn's "$ fallow ...") before the JSON.
function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('{');
    return JSON.parse(start > 0 ? raw.slice(start) : raw);
  } catch {
    return null;
  }
}

function deadcodeRows(summary) {
  const rows = [];
  for (const [key, label] of DEADCODE_CATEGORIES) {
    const n = summary[key];
    if (n) rows.push(`| ${label} | ${n} |`);
  }
  return rows;
}

function renderUnusedFiles(files) {
  if (!files || files.length === 0) return '';
  const list = files.map((f) => `- \`${f.path}\``).join('\n');
  return `\n\n<details><summary>Unused files (${files.length})</summary>\n\n${list}\n\n</details>`;
}

function summarizeDeadcode(dc) {
  if (!dc || !dc.summary) return MISSING('fallow dead-code');
  const rows = deadcodeRows(dc.summary);
  if (rows.length === 0) return '✅ **No dead code found.**';
  const table = `| Category | Count |\n| :--- | ---: |\n${rows.join('\n')}`;
  return table + renderUnusedFiles(dc.unused_files);
}

function maxCyclomatic(findings) {
  let max = 0;
  for (const f of findings || []) {
    if (f.cyclomatic > max) max = f.cyclomatic;
  }
  return max;
}

function summarizeHealth(h) {
  const s = h && h.summary;
  if (!s) return MISSING('fallow health');
  return (
    `**${s.severity_critical_count}** critical · **${s.severity_high_count}** high · ` +
    `${s.severity_moderate_count} moderate complexity findings ` +
    `(of ${s.functions_analyzed} functions, max cyclomatic ${maxCyclomatic(h.findings)})`
  );
}

function jscpdFormatRows(formats) {
  return Object.entries(formats || {})
    .map(([name, data]) => {
      const s = data.total;
      return `| ${name} | ${s.sources} | ${s.clones} | ${s.duplicatedLines} (${s.percentage}%) |`;
    })
    .join('\n');
}

function summarizeJscpd(jscpd) {
  const total = jscpd && jscpd.statistics && jscpd.statistics.total;
  if (!total) return MISSING('jscpd');
  const header =
    `**${total.clones}** clones · **${total.duplicatedLines}** duplicated lines ` +
    `(**${total.percentage}%**) · ${total.duplicatedTokens} tokens (${total.percentageTokens}%)`;
  const rows = jscpdFormatRows(jscpd.statistics.formats);
  return `${header}\n\n| Format | Files | Clones | Dup. lines |\n| :--- | ---: | ---: | ---: |\n${rows}`;
}

function healthBadge(h) {
  const score = h && h.health_score;
  if (!score) return '';
  return `  ·  Health **${score.grade}** (${score.score}/100)`;
}

// ── Baseline diff mode ────────────────────────────────────────────────────
// Usage: node scripts/audit-summary.cjs --diff-issues <baseline.json>
//
// Reads current audit reports, diffs against the baseline, and writes JSON to
// stdout: { newFindings: [...], baseline: {...} }
// where each finding is { type, title, body, labels: string[] }.
// The caller (audit-new-findings.yml) iterates newFindings to open issues.
//
// Baseline schema: { unusedFiles: string[], categoryCounts: Record<string,number> }

function buildBaseline(dc, h, jscpdData) {
  const unusedFiles = (dc && dc.unused_files || []).map((f) => f.path);
  const categoryCounts = {};
  for (const [key] of DEADCODE_CATEGORIES) {
    if (key !== 'unused_files') {
      categoryCounts[key] = (dc && dc.summary && dc.summary[key]) || 0;
    }
  }
  // Health: critical + high
  const s = h && h.summary;
  categoryCounts['health_critical'] = (s && s.severity_critical_count) || 0;
  categoryCounts['health_high']     = (s && s.severity_high_count)     || 0;
  // jscpd clone count
  const tot = jscpdData && jscpdData.statistics && jscpdData.statistics.total;
  categoryCounts['jscpd_clones'] = (tot && tot.clones) || 0;
  return { unusedFiles, categoryCounts };
}

function diffFindings(prev, curr, dc, h, jscpdData, sha, repoUrl) {
  const findings = [];
  const blobBase = sha ? `${repoUrl}/blob/${sha}/` : null;

  // New unused files
  const prevFiles = new Set(prev.unusedFiles || []);
  for (const f of (dc && dc.unused_files || [])) {
    if (!prevFiles.has(f.path)) {
      const fileUrl = blobBase ? `${blobBase}${f.path}` : f.path;
      findings.push({
        type: 'dead-code',
        title: `[chore] unused file \`${f.path}\``,
        body: `**Rule:** unused file\n**File:** ${fileUrl}\n\nThis file has no importers. Remove it or add a \`// fallow-ignore-unused-files\` suppression if it is intentionally kept.`,
        labels: ['chore', 'code-audit', 'audit:dead-code'],
      });
    }
  }

  // Category count increases
  const categoryLabels = {
    unused_exports:       ['chore', 'code-audit', 'audit:dead-code'],
    unused_types:         ['chore', 'code-audit', 'audit:dead-code'],
    unused_class_members: ['chore', 'code-audit', 'audit:dead-code'],
    unused_enum_members:  ['chore', 'code-audit', 'audit:dead-code'],
    duplicate_exports:    ['chore', 'code-audit', 'audit:dead-code'],
    unused_dependencies:  ['chore', 'code-audit', 'audit:dead-code'],
    unlisted_dependencies:['chore', 'code-audit', 'audit:dead-code'],
    unresolved_imports:   ['chore', 'code-audit', 'audit:dead-code'],
    circular_dependencies:['chore', 'code-audit', 'audit:dead-code'],
    private_type_leaks:   ['chore', 'code-audit', 'audit:dead-code'],
  };
  for (const [key, labels] of Object.entries(categoryLabels)) {
    const prevCount = (prev.categoryCounts && prev.categoryCounts[key]) || 0;
    const currCount = (curr.categoryCounts && curr.categoryCounts[key]) || 0;
    if (currCount > prevCount) {
      const label = DEADCODE_CATEGORIES.find(([k]) => k === key)?.[1] ?? key;
      findings.push({
        type: 'dead-code',
        title: `[chore] ${currCount - prevCount} new ${label.toLowerCase()} finding(s)`,
        body: `**Rule:** ${key}\n**Count before:** ${prevCount}\n**Count after:** ${currCount}\n**Delta:** +${currCount - prevCount}\n\nRun \`yarn audit:code\` locally and inspect the fallow dead-code report for the specific symbols.`,
        labels,
      });
    }
  }

  // Health regression (new critical or high findings)
  const prevCrit = (prev.categoryCounts && prev.categoryCounts['health_critical']) || 0;
  const currCrit = (curr.categoryCounts && curr.categoryCounts['health_critical']) || 0;
  const prevHigh = (prev.categoryCounts && prev.categoryCounts['health_high'])     || 0;
  const currHigh = (curr.categoryCounts && curr.categoryCounts['health_high'])     || 0;
  if (currCrit > prevCrit || currHigh > prevHigh) {
    findings.push({
      type: 'complexity',
      title: `[chore] new complexity findings (critical: +${currCrit - prevCrit}, high: +${currHigh - prevHigh})`,
      body: `**Rule:** cyclomatic complexity\n**Critical before/after:** ${prevCrit} → ${currCrit}\n**High before/after:** ${prevHigh} → ${currHigh}\n\nRun \`yarn audit:code\` locally and inspect the fallow health report for the specific functions.`,
      labels: ['chore', 'code-audit', 'audit:complexity'],
    });
  }

  // jscpd clone increase
  const prevClones = (prev.categoryCounts && prev.categoryCounts['jscpd_clones']) || 0;
  const currClones = (curr.categoryCounts && curr.categoryCounts['jscpd_clones']) || 0;
  if (currClones > prevClones) {
    findings.push({
      type: 'duplication',
      title: `[chore] ${currClones - prevClones} new code duplication clone(s)`,
      body: `**Rule:** jscpd duplication\n**Clones before:** ${prevClones}\n**Clones after:** ${currClones}\n**Delta:** +${currClones - prevClones}\n\nRun \`yarn jscpd\` locally and inspect the HTML report in \`reports/jscpd/\` for the specific duplicate blocks.`,
      labels: ['chore', 'code-audit', 'audit:dupe'],
    });
  }

  return findings;
}

const diffFlagIdx = process.argv.indexOf('--diff-issues');
if (diffFlagIdx !== -1) {
  const baselineFile = process.argv[diffFlagIdx + 1];
  const sha     = process.env.GITHUB_SHA     ?? '';
  const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : 'https://github.com/Connor-Adams/cashflow';

  const deadcode = readJson(DEADCODE_JSON);
  const health   = readJson(HEALTH_JSON);
  const jscpd    = readJson(JSCPD_JSON);

  let prev = { unusedFiles: [], categoryCounts: {} };
  if (baselineFile) {
    try { prev = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch { /* first run */ }
  }

  const curr         = buildBaseline(deadcode, health, jscpd);
  const newFindings  = diffFindings(prev, curr, deadcode, health, jscpd, sha, repoUrl);

  process.stdout.write(JSON.stringify({ newFindings, baseline: curr }, null, 2) + '\n');
  process.exit(0);
}

// ── Normal markdown-summary mode ──────────────────────────────────────────

const deadcode = readJson(DEADCODE_JSON);
const health = readJson(HEALTH_JSON);
const jscpd = readJson(JSCPD_JSON);

const body = `${MARKER}
## 🔍 Code audit${healthBadge(health)}

### 🧹 Dead code — [fallow](https://github.com/fallow-rs/fallow)

${summarizeDeadcode(deadcode)}

### 🧩 Complexity — [fallow](https://github.com/fallow-rs/fallow)

${summarizeHealth(health)}

### 🧬 Duplication — [jscpd](https://github.com/kucherenko/jscpd)

${summarizeJscpd(jscpd)}

---
<sub>Whole-repo snapshot — informational, does not block merge. Run locally with \`yarn audit:code\`. Full duplication report is in the **jscpd-report** workflow artifact; inline review comments come from fallow.</sub>`;

process.stdout.write(body + '\n');

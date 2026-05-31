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

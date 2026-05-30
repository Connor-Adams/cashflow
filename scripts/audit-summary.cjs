#!/usr/bin/env node
/**
 * Builds a concise Markdown summary of the code-audit results (knip + jscpd)
 * for posting as a pull-request comment. Reads the JSON reports produced by
 * `yarn deadcode --reporter json` and `yarn dupes --reporters json`.
 *
 * Usage: node scripts/audit-summary.cjs > comment.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNIP_JSON = path.join(ROOT, 'reports', 'knip-report.json');
const JSCPD_JSON = path.join(ROOT, 'reports', 'jscpd', 'jscpd-report.json');

const MARKER = '<!-- code-audit-summary -->';
const KNIP_MISSING = '> ⚠️ knip report not found — see the workflow logs.';
const JSCPD_MISSING = '> ⚠️ jscpd report not found — see the workflow logs.';

// Knip emits one entry per file; each has arrays per issue category.
const KNIP_CATEGORIES = [
  ['files', 'Unused files'],
  ['exports', 'Unused exports'],
  ['types', 'Unused exported types'],
  ['duplicates', 'Duplicate exports'],
  ['enumMembers', 'Unused enum members'],
  ['classMembers', 'Unused class members'],
  ['dependencies', 'Unused dependencies'],
  ['devDependencies', 'Unused devDependencies'],
  ['unlisted', 'Unlisted dependencies'],
  ['binaries', 'Unlisted binaries'],
  ['unresolved', 'Unresolved imports'],
];

// Tolerant of a leading CLI banner (e.g. yarn's "$ knip ...") before the JSON.
function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('{');
    return JSON.parse(start > 0 ? raw.slice(start) : raw);
  } catch {
    return null;
  }
}

function countCategory(issues, key) {
  let n = 0;
  for (const issue of issues) {
    const arr = issue[key];
    if (arr) n += arr.length;
  }
  return n;
}

function collectUnusedFiles(issues) {
  const files = [];
  for (const issue of issues) {
    for (const f of issue.files) files.push(f.name);
  }
  return files;
}

function buildKnipRows(issues) {
  const rows = [];
  let total = 0;
  for (const [key, label] of KNIP_CATEGORIES) {
    const n = countCategory(issues, key);
    if (n) {
      rows.push(`| ${label} | ${n} |`);
      total += n;
    }
  }
  return { rows, total };
}

function renderKnipBody(rows, unusedFiles) {
  const table = `| Category | Count |\n| :--- | ---: |\n${rows.join('\n')}`;
  if (unusedFiles.length === 0) return table;
  const list = unusedFiles.map((f) => `- \`${f}\``).join('\n');
  return `${table}\n\n<details><summary>Unused files (${unusedFiles.length})</summary>\n\n${list}\n\n</details>`;
}

function summarizeKnip(knip) {
  if (!knip || !Array.isArray(knip.issues)) return KNIP_MISSING;
  const { rows, total } = buildKnipRows(knip.issues);
  if (total === 0) return '✅ **No dead code found.**';
  return renderKnipBody(rows, collectUnusedFiles(knip.issues));
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
  if (!total) return JSCPD_MISSING;
  const header =
    `**${total.clones}** clones · **${total.duplicatedLines}** duplicated lines ` +
    `(**${total.percentage}%**) · ${total.duplicatedTokens} tokens (${total.percentageTokens}%)`;
  const rows = jscpdFormatRows(jscpd.statistics.formats);
  return `${header}\n\n| Format | Files | Clones | Dup. lines |\n| :--- | ---: | ---: | ---: |\n${rows}`;
}

const body = `${MARKER}
## 🔍 Code audit

### 🧹 Dead code — [knip](https://knip.dev)

${summarizeKnip(readJson(KNIP_JSON))}

### 🧬 Duplication — [jscpd](https://github.com/kucherenko/jscpd)

${summarizeJscpd(readJson(JSCPD_JSON))}

---
<sub>Informational only — does not block merge. Run locally with \`yarn audit:code\`. Full duplication report is in the **jscpd-report** workflow artifact.</sub>`;

process.stdout.write(body + '\n');

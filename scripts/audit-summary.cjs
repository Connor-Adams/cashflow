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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

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

function summarizeKnip(knip) {
  if (!knip || !Array.isArray(knip.issues)) {
    return '> ⚠️ knip report not found — see the workflow logs.';
  }
  const counts = {};
  const unusedFiles = [];
  for (const issue of knip.issues) {
    for (const [key] of KNIP_CATEGORIES) {
      const arr = issue[key];
      if (Array.isArray(arr) && arr.length) {
        counts[key] = (counts[key] || 0) + arr.length;
        if (key === 'files') {
          for (const f of arr) unusedFiles.push(typeof f === 'string' ? f : f.name);
        }
      }
    }
  }
  const rows = KNIP_CATEGORIES.filter(([k]) => counts[k]).map(
    ([k, label]) => `| ${label} | ${counts[k]} |`,
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return '✅ **No dead code found.**';

  let out = `| Category | Count |\n| :--- | ---: |\n${rows.join('\n')}`;
  if (unusedFiles.length) {
    out +=
      `\n\n<details><summary>Unused files (${unusedFiles.length})</summary>\n\n` +
      unusedFiles.map((f) => `- \`${f}\``).join('\n') +
      `\n\n</details>`;
  }
  return out;
}

function summarizeJscpd(jscpd) {
  if (!jscpd || !jscpd.statistics || !jscpd.statistics.total) {
    return '> ⚠️ jscpd report not found — see the workflow logs.';
  }
  const t = jscpd.statistics.total;
  const formats = jscpd.statistics.formats || {};
  let out =
    `**${t.clones}** clones · **${t.duplicatedLines}** duplicated lines ` +
    `(**${t.percentage}%**) · ${t.duplicatedTokens} tokens (${t.percentageTokens}%)\n\n`;
  out += `| Format | Files | Clones | Dup. lines |\n| :--- | ---: | ---: | ---: |\n`;
  for (const [name, data] of Object.entries(formats)) {
    const s = data.total;
    out += `| ${name} | ${s.sources} | ${s.clones} | ${s.duplicatedLines} (${s.percentage}%) |\n`;
  }
  return out;
}

const knip = readJson(KNIP_JSON);
const jscpd = readJson(JSCPD_JSON);

const body = `${MARKER}
## 🔍 Code audit

### 🧹 Dead code — [knip](https://knip.dev)

${summarizeKnip(knip)}

### 🧬 Duplication — [jscpd](https://github.com/kucherenko/jscpd)

${summarizeJscpd(jscpd)}

---
<sub>Informational only — does not block merge. Run locally with \`yarn audit:code\`. Full duplication report is in the **jscpd-report** workflow artifact.</sub>`;

process.stdout.write(body + '\n');

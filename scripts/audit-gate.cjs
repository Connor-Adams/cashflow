#!/usr/bin/env node
/**
 * Baseline ratchet for the CI `code-audit` job (issue #469, fallow-audit
 * remediation Phase 3 — "lock it").
 *
 * The dead-code remediation cluster (#464–#467) drove the eight zeroable
 * categories to 0; the jscpd dedup work (#468) drove total duplication to 3.98%.
 * This gate holds that line: a PR that reintroduces ANY zeroable dead-code
 * finding, or pushes total duplication above the ceiling, fails CI.
 *
 * It is intentionally NOT a substitute for `fallow.yml`, which gates findings on
 * PR-*added* lines (a diff-scoped verdict, see #463). This script gates the
 * *whole-repo* snapshot the `code-audit` job already produces, so a regression
 * anywhere in the tree — not only on touched lines — is caught.
 *
 * Sources (already emitted by the `code-audit` job before this step runs):
 *   - reports/fallow-deadcode.json     (`fallow dead-code --format json`)
 *   - reports/jscpd/jscpd-report.json  (`jscpd --reporters json`)
 *
 * Complexity is deliberately untouched: the 488-finding complexity backlog is
 * out of scope and stays informational forever (per the spec at
 * docs/superpowers/specs/2026-05-31-fallow-audit-remediation-design.md).
 *
 * Usage: node scripts/audit-gate.cjs   (exits non-zero on any violation)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEADCODE_JSON = path.join(ROOT, 'reports', 'fallow-deadcode.json');
const JSCPD_JSON = path.join(ROOT, 'reports', 'jscpd', 'jscpd-report.json');

// The eight dead-code categories that were driven to 0 and must stay at 0.
// Keys match the snake_case fields of `fallow dead-code --format json`'s
// `summary` object (same fields scripts/audit-summary.cjs renders). Categories
// fallow can report but that are NOT in the zeroable baseline — unused_enum_members,
// unresolved_imports, private_type_leaks — are intentionally excluded so the gate
// only enforces what the remediation cluster actually drove to 0.
const ZEROABLE_CATEGORIES = [
  ['unused_files', 'Unused files'],
  ['unused_exports', 'Unused exports'],
  ['unused_types', 'Unused exported types'],
  ['unused_class_members', 'Unused class members'],
  ['duplicate_exports', 'Duplicate exports'],
  ['unused_dependencies', 'Unused dependencies'],
  ['unlisted_dependencies', 'Unlisted dependencies'],
  ['circular_dependencies', 'Circular dependencies'],
];

// jscpd total-duplication ceiling (%). #468 (PR #644) drove the total to 3.98%;
// the gate fails a PR that pushes duplication strictly ABOVE this. Ratchet it
// DOWN as duplication drops — never up.
const DUP_CEILING = 4.0;

// Tolerant of a leading CLI banner (e.g. yarn's "$ fallow ...") before the JSON.
// Mirrors scripts/audit-summary.cjs so both consume the reports identically.
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
 * Evaluate the audit reports against the ratchet.
 *
 * Fails *closed*: a missing or unparseable report is a violation, because the
 * gate cannot confirm the baseline holds (a silent empty scan must never pass).
 *
 * @param {{ deadcode: object|null, jscpd: object|null }} reports
 * @returns {{ ok: boolean, failures: string[] }}
 */
function evaluateAudit({ deadcode, jscpd }) {
  const failures = [];

  // --- Dead code: every zeroable category must be 0 ---
  if (!deadcode || !deadcode.summary) {
    failures.push(
      'fallow dead-code report missing or unparseable (reports/fallow-deadcode.json) — cannot confirm baseline',
    );
  } else {
    for (const [key, label] of ZEROABLE_CATEGORIES) {
      const n = deadcode.summary[key];
      if (typeof n === 'number' && n > 0) {
        failures.push(`${label} (${key}) = ${n}, must be 0`);
      }
    }
  }

  // --- Duplication: total % must not exceed the ceiling ---
  const total = jscpd && jscpd.statistics && jscpd.statistics.total;
  if (!total || typeof total.percentage !== 'number') {
    failures.push(
      'jscpd report missing or unparseable (reports/jscpd/jscpd-report.json) — cannot confirm duplication ceiling',
    );
  } else if (total.percentage > DUP_CEILING) {
    failures.push(
      `Duplication ${total.percentage}% exceeds ceiling ${DUP_CEILING}%`,
    );
  }

  return { ok: failures.length === 0, failures };
}

function main() {
  const result = evaluateAudit({
    deadcode: readJson(DEADCODE_JSON),
    jscpd: readJson(JSCPD_JSON),
  });

  if (result.ok) {
    console.log(
      `✅ Code-audit ratchet held: all ${ZEROABLE_CATEGORIES.length} zeroable ` +
        `dead-code categories at 0 and duplication ≤ ${DUP_CEILING}%.`,
    );
    return 0;
  }

  console.error('❌ Code-audit ratchet FAILED:\n');
  for (const f of result.failures) console.error(`  • ${f}`);
  console.error(
    '\nThis gate holds the fallow-audit baseline (issue #469). Fix the finding, ' +
      'or — for a deliberate change to the ceiling — update DUP_CEILING in ' +
      'scripts/audit-gate.cjs (downward only) with justification. ' +
      'See CONTRIBUTING.md › Code health.',
  );
  return 1;
}

module.exports = { evaluateAudit, ZEROABLE_CATEGORIES, DUP_CEILING };

if (require.main === module) {
  process.exit(main());
}

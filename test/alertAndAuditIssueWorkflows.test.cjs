const { readFileSync, existsSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Issue #386 — wiring tests for the two "signal → GitHub issue" paths:
//   A. Grafana alert → repository_dispatch → grafana-alert-to-issue.yml
//   B. code-audit (fallow dead-code) finding on main → audit-issues.yml
// These lock the contract so a bad edit (dropped trigger, wrong permission,
// PR-issue spam) fails CI.

const auditWorkflow = readFileSync('.github/workflows/audit-issues.yml', 'utf8');
const grafanaWorkflow = readFileSync('.github/workflows/grafana-alert-to-issue.yml', 'utf8');

test('audit-issues workflow only runs on push to main (never on PRs — no spam)', () => {
  // Must trigger on push to main.
  assert.match(auditWorkflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  // Must NOT trigger on pull_request — the AC forbids issue-spam on PRs.
  assert.doesNotMatch(auditWorkflow, /pull_request:/);
});

test('audit-issues workflow has issues:write and runs the diff script', () => {
  assert.match(auditWorkflow, /permissions:\s*\n(?:.*\n)*?\s*issues:\s*write/);
  assert.match(auditWorkflow, /\.\/node_modules\/\.bin\/fallow dead-code --format json/);
  assert.match(auditWorkflow, /node scripts\/audit-issues\.cjs/);
  // The script needs the SHA to build the exact blob URL.
  assert.match(auditWorkflow, /GITHUB_SHA:\s*\$\{\{ github\.sha \}\}/);
});

test('grafana-alert workflow listens for the grafana-alert repository_dispatch', () => {
  assert.match(grafanaWorkflow, /repository_dispatch:\s*\n\s*types:\s*\[grafana-alert\]/);
  assert.match(grafanaWorkflow, /permissions:\s*\n(?:.*\n)*?\s*issues:\s*write/);
  assert.match(grafanaWorkflow, /node scripts\/grafana-alert-to-issue\.cjs/);
  // The Grafana webhook body arrives as the dispatch client_payload.
  assert.match(
    grafanaWorkflow,
    /GRAFANA_ALERT_PAYLOAD:\s*\$\{\{ toJSON\(github\.event\.client_payload\) \}\}/,
  );
});

test('grafana contact point provisions a webhook to GitHub repository_dispatch', () => {
  const cpPath = 'infra/grafana/provisioning/alerting/contactpoints.yaml';
  assert.equal(existsSync(cpPath), true, `${cpPath} must exist`);
  const cp = readFileSync(cpPath, 'utf8');

  assert.match(cp, /apiVersion:\s*1\b/);
  assert.match(cp, /contactPoints:/);
  assert.match(cp, /type:\s*webhook/);
  // Points at the dispatch API for this repo.
  assert.match(
    cp,
    /url:\s*https:\/\/api\.github\.com\/repos\/Connor-Adams\/cashflow\/dispatches/,
  );
  // Emits GitHub's required { event_type, client_payload } shape.
  assert.match(cp, /"event_type":\s*"grafana-alert"/);
  assert.match(cp, /"client_payload"/);
  // A notification policy must route alerts to this contact point.
  assert.match(cp, /policies:/);
  assert.match(cp, /receiver:\s*github-issues/);
});

test('contact point payload carries the rule uid the dedup label is built from', () => {
  const cp = readFileSync('infra/grafana/provisioning/alerting/contactpoints.yaml', 'utf8');
  // scripts/grafana-alert-to-issue.cjs derives alert:<uid> from
  // labels.__alert_rule_uid__ — the payload template must emit it.
  assert.match(cp, /__alert_rule_uid__/);
  // And the annotations the issue body renders.
  assert.match(cp, /runbook_url/);
});

test('a committed audit baseline exists so the first run files nothing', () => {
  // Lives at repo root, NOT under .fallow/ — that dir is gitignored and fallow
  // drops its own `.gitignore: *` into it, which would un-track the baseline.
  const baselinePath = 'audit-baseline.json';
  assert.equal(existsSync(baselinePath), true, `${baselinePath} must exist`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.ok(Array.isArray(baseline.findings), 'baseline.findings must be an array');
});

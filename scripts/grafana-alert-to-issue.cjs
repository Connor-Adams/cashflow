#!/usr/bin/env node
/**
 * Turns a Grafana alert webhook (delivered as a GitHub `repository_dispatch`
 * client_payload) into GitHub issues:
 *
 *   - firing  + no open issue   → create a `bug`/`incident` issue
 *   - firing  + open issue      → comment on it (dedup, no duplicate)
 *   - resolved + open issue      → close it (with a "resolved" comment)
 *   - resolved + no open issue   → noop
 *
 * Dedup key: the `alert:<rule-uid>` label. One open issue per alert rule.
 *
 * The Grafana contact point that feeds this lives in
 * infra/grafana/provisioning/alerting/contactpoints.yaml; the workflow that
 * invokes this script is .github/workflows/grafana-alert-to-issue.yml.
 *
 * Modes:
 *   node scripts/grafana-alert-to-issue.cjs            — read payload, act on GitHub
 *   node scripts/grafana-alert-to-issue.cjs --dry-run  — print the plan, no writes
 *
 * Input: the alert payload is read from $GRAFANA_ALERT_PAYLOAD (a JSON string,
 * the `client_payload` of the repository_dispatch event).
 *
 * Required env vars (for the GitHub side):
 *   GITHUB_TOKEN       — GITHUB_TOKEN or PAT with issues:write
 *   GITHUB_REPOSITORY  — "owner/repo"  (set automatically by GitHub Actions)
 *   GRAFANA_ALERT_PAYLOAD — JSON string of the Grafana webhook body
 */

'use strict';

const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Extract a flat list of alerts from a Grafana/Alertmanager webhook body.
 * Each entry: { status, uid, labels, annotations, generatorURL, startsAt }.
 * An alert without its own `status` inherits the group's top-level `status`.
 */
function normalizeAlerts(payload) {
  if (!payload || !Array.isArray(payload.alerts)) return [];
  const groupStatus = payload.status;
  return payload.alerts.map((a) => {
    const labels = a.labels || {};
    const uid =
      labels.__alert_rule_uid__ ||
      labels.alert_rule_uid ||
      a.fingerprint ||
      labels.alertname ||
      'unknown';
    return {
      status: a.status || groupStatus || 'firing',
      uid,
      labels,
      annotations: a.annotations || {},
      generatorURL: a.generatorURL || a.panelURL || '',
      startsAt: a.startsAt || '',
      endsAt: a.endsAt || '',
    };
  });
}

/** Stable dedup label, one per alert rule. */
function alertDedupLabel(alert) {
  return `alert:${alert.uid}`;
}

/** Labels for the issue: bug + incident + severity + component + dedup. */
function buildAlertLabels(alert) {
  const labels = ['bug', 'incident'];
  const severity = alert.labels.severity;
  if (severity) labels.push(`severity:${severity}`);
  const component = alert.labels.component;
  if (component) labels.push(`component:${component}`);
  labels.push(alertDedupLabel(alert));
  return labels;
}

function buildAlertIssueTitle(alert) {
  const name = alert.labels.alertname || alert.uid;
  const component = alert.labels.component;
  return component ? `[alert] ${name} on ${component}` : `[alert] ${name}`;
}

function buildAlertIssueBody(alert) {
  const { summary, description, runbook_url } = alert.annotations;
  const lines = [];
  if (summary) lines.push(`**${summary}**`, '');
  if (description) lines.push(description, '');

  lines.push('| Field | Value |', '| :--- | :--- |');
  lines.push(`| Alert | \`${alert.labels.alertname || alert.uid}\` |`);
  lines.push(`| Rule UID | \`${alert.uid}\` |`);
  if (alert.labels.severity) lines.push(`| Severity | ${alert.labels.severity} |`);
  if (alert.labels.component) lines.push(`| Component | ${alert.labels.component} |`);
  if (alert.startsAt) lines.push(`| Started | ${alert.startsAt} |`);
  lines.push('');

  if (runbook_url) lines.push(`**Runbook:** ${runbook_url}`, '');
  if (alert.generatorURL) lines.push(`**Grafana:** ${alert.generatorURL}`, '');

  // Any extra labels (e.g. server_address, job) help triage.
  const extra = Object.entries(alert.labels).filter(
    ([k]) =>
      !['alertname', 'severity', 'component', '__alert_rule_uid__', 'alert_rule_uid'].includes(k),
  );
  if (extra.length) {
    lines.push('<details><summary>Alert labels</summary>', '');
    for (const [k, v] of extra) lines.push(`- \`${k}\`: \`${v}\``);
    lines.push('', '</details>', '');
  }

  lines.push(
    '---',
    '_Auto-created from a Grafana alert by ' +
      '[grafana-alert-to-issue](https://github.com/Connor-Adams/cashflow/blob/main/.github/workflows/grafana-alert-to-issue.yml). ' +
      'Subsequent fires of the same rule comment here; the workflow closes this issue when the alert resolves._',
  );
  return lines.join('\n');
}

/**
 * Decide the action for each alert given the currently-open issues keyed by
 * their dedup label.
 *
 * @param {Array} alerts            — output of normalizeAlerts
 * @param {Map<string, number>} openByLabel — dedupLabel → open issue number
 * @returns {Array<{action: 'create'|'comment'|'close'|'noop', alert, dedupLabel, issueNumber?}>}
 */
function planActions(alerts, openByLabel) {
  return alerts.map((alert) => {
    const dedupLabel = alertDedupLabel(alert);
    const issueNumber = openByLabel.get(dedupLabel);
    const firing = alert.status !== 'resolved';
    if (firing) {
      return issueNumber
        ? { action: 'comment', alert, dedupLabel, issueNumber }
        : { action: 'create', alert, dedupLabel };
    }
    // resolved
    return issueNumber
      ? { action: 'close', alert, dedupLabel, issueNumber }
      : { action: 'noop', alert, dedupLabel };
  });
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function githubRequest(method, urlPath, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'cashflow-grafana-alert-to-issue',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
          } else {
            resolve(data ? JSON.parse(data) : {});
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureLabel(repo, name, color, description) {
  try {
    await githubRequest('POST', `/repos/${repo}/labels`, { name, color, description });
  } catch (e) {
    if (!String(e.message).includes('422')) throw e;
  }
}

/** Map every open issue's `alert:*` label → issue number. */
async function fetchOpenAlertIssues(repo) {
  const map = new Map();
  let page = 1;
  for (;;) {
    const issues = await githubRequest(
      'GET',
      `/repos/${repo}/issues?state=open&labels=incident&per_page=100&page=${page}`,
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    for (const issue of issues) {
      // Skip PRs (the issues endpoint includes them).
      if (issue.pull_request) continue;
      const alertLabel = (issue.labels || [])
        .map((l) => (typeof l === 'string' ? l : l.name))
        .find((n) => n && n.startsWith('alert:'));
      if (alertLabel) map.set(alertLabel, issue.number);
    }
    if (issues.length < 100) break;
    page++;
  }
  return map;
}

async function applyPlan(repo, plan) {
  // Ensure base labels exist (severity:* / component:* / alert:* are dynamic —
  // GitHub auto-creates labels on issue creation if they don't exist? No: it
  // errors on unknown labels. So pre-create the static ones and each dynamic
  // one we are about to use.)
  await ensureLabel(repo, 'bug', 'D73A4A', "Something isn't working");
  await ensureLabel(repo, 'incident', 'B60205', 'Production alert fired by Grafana');

  for (const item of plan) {
    const dynamicLabels = buildAlertLabels(item.alert).filter(
      (l) => l !== 'bug' && l !== 'incident',
    );
    for (const l of dynamicLabels) {
      const color = l.startsWith('severity:') ? 'E99695' : l.startsWith('component:') ? 'BFD4F2' : 'C2E0C6';
      await ensureLabel(repo, l, color, 'Grafana alert metadata');
    }

    if (item.action === 'create') {
      const title = buildAlertIssueTitle(item.alert);
      const body = buildAlertIssueBody(item.alert);
      const labels = buildAlertLabels(item.alert);
      const issue = await githubRequest('POST', `/repos/${repo}/issues`, { title, body, labels });
      console.log(`Created #${issue.number}: ${title}`);
    } else if (item.action === 'comment') {
      const body =
        `🔁 **Alert fired again** at ${item.alert.startsAt || new Date().toISOString()}.\n\n` +
        buildAlertIssueBody(item.alert);
      await githubRequest('POST', `/repos/${repo}/issues/${item.issueNumber}/comments`, { body });
      console.log(`Commented on #${item.issueNumber} (re-fire of ${item.dedupLabel}).`);
    } else if (item.action === 'close') {
      await githubRequest('POST', `/repos/${repo}/issues/${item.issueNumber}/comments`, {
        body: `✅ **Alert resolved** at ${item.alert.endsAt || new Date().toISOString()}. Closing.`,
      });
      await githubRequest('PATCH', `/repos/${repo}/issues/${item.issueNumber}`, {
        state: 'closed',
        state_reason: 'completed',
      });
      console.log(`Closed #${item.issueNumber} (resolved ${item.dedupLabel}).`);
    } else {
      console.log(`Noop for ${item.dedupLabel} (resolved, no open issue).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readPayload() {
  const raw = process.env.GRAFANA_ALERT_PAYLOAD;
  if (!raw) {
    console.error('GRAFANA_ALERT_PAYLOAD not set — nothing to do.');
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('GRAFANA_ALERT_PAYLOAD is not valid JSON:', e.message);
    process.exit(1);
  }
}

async function main() {
  const payload = readPayload();
  const alerts = normalizeAlerts(payload);
  console.log(`Parsed ${alerts.length} alert(s) from the Grafana payload.`);
  if (alerts.length === 0) return;

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY not set — cannot manage issues.');
    process.exit(1);
  }

  const openByLabel = DRY_RUN ? new Map() : await fetchOpenAlertIssues(repo);
  const plan = planActions(alerts, openByLabel);

  if (DRY_RUN) {
    for (const item of plan) {
      console.log(`${item.action.toUpperCase()} ${item.dedupLabel}${item.issueNumber ? ` (#${item.issueNumber})` : ''}`);
    }
    return;
  }

  await applyPlan(repo, plan);
}

module.exports = {
  normalizeAlerts,
  alertDedupLabel,
  buildAlertIssueTitle,
  buildAlertIssueBody,
  buildAlertLabels,
  planActions,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

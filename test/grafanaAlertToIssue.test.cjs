const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAlerts,
  alertDedupLabel,
  buildAlertIssueTitle,
  buildAlertIssueBody,
  buildAlertLabels,
  planActions,
} = require('../scripts/grafana-alert-to-issue.cjs');

// Issue #386 — a Grafana alert webhook (repository_dispatch client_payload)
// becomes a GitHub `bug`/`incident` issue. These tests pin the pure logic:
// extracting alerts from the payload, the dedup label, title/body/labels, and
// the create-vs-comment-vs-close decision.

// A Grafana/Alertmanager-shaped webhook body, as forwarded by the Grafana
// webhook contact point into the repository_dispatch client_payload.
function firingPayload(overrides = {}) {
  return {
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'TempoExportFailing',
          severity: 'critical',
          component: 'tempo',
          __alert_rule_uid__: 'cashflow-tempo-export-failing',
        },
        annotations: {
          summary: 'otel-collector is failing to export traces to tempo',
          description: 'Tempo may be down, unreachable, or refusing writes.',
          runbook_url:
            'https://github.com/Connor-Adams/cashflow/blob/main/docs/observability.md#tempoexportfailing',
        },
        generatorURL: 'https://grafana.example/alerting/grafana/cashflow-tempo-export-failing/view',
        startsAt: '2026-06-19T10:00:00Z',
        ...overrides,
      },
    ],
  };
}

test('normalizeAlerts extracts one entry per alert with its status and labels', () => {
  const alerts = normalizeAlerts(firingPayload());
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.status, 'firing');
  assert.equal(a.labels.alertname, 'TempoExportFailing');
  assert.equal(a.uid, 'cashflow-tempo-export-failing');
});

test('normalizeAlerts tolerates empty / missing payloads', () => {
  assert.deepEqual(normalizeAlerts(null), []);
  assert.deepEqual(normalizeAlerts({}), []);
  assert.deepEqual(normalizeAlerts({ alerts: [] }), []);
});

test('normalizeAlerts falls back to the top-level status when an alert omits it', () => {
  const payload = firingPayload();
  delete payload.alerts[0].status;
  const alerts = normalizeAlerts(payload);
  assert.equal(alerts[0].status, 'firing');
});

test('alertDedupLabel is a stable per-rule label', () => {
  const [alert] = normalizeAlerts(firingPayload());
  assert.equal(alertDedupLabel(alert), 'alert:cashflow-tempo-export-failing');
});

test('buildAlertLabels carries bug, incident, severity, and component', () => {
  const [alert] = normalizeAlerts(firingPayload());
  const labels = buildAlertLabels(alert);
  assert.ok(labels.includes('bug'));
  assert.ok(labels.includes('incident'));
  assert.ok(labels.includes('severity:critical'));
  assert.ok(labels.includes('component:tempo'));
  assert.ok(labels.includes('alert:cashflow-tempo-export-failing'));
});

test('buildAlertIssueTitle is "[alert] <title> on <component>"', () => {
  const [alert] = normalizeAlerts(firingPayload());
  assert.equal(buildAlertIssueTitle(alert), '[alert] TempoExportFailing on tempo');
});

test('buildAlertIssueBody includes summary, description, runbook URL, and a Grafana link', () => {
  const [alert] = normalizeAlerts(firingPayload());
  const body = buildAlertIssueBody(alert);
  assert.match(body, /otel-collector is failing to export traces to tempo/);
  assert.match(body, /Tempo may be down/);
  assert.match(
    body,
    /docs\/observability\.md#tempoexportfailing/,
    'runbook_url must appear in the body',
  );
  assert.match(body, /grafana\.example\/alerting/, 'the Grafana panel/rule link must appear');
});

test('planActions: a firing alert with no open issue → create', () => {
  const [alert] = normalizeAlerts(firingPayload());
  const plan = planActions([alert], new Map());
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'create');
  assert.equal(plan[0].dedupLabel, 'alert:cashflow-tempo-export-failing');
});

test('planActions: a firing alert with an existing open issue → comment, not duplicate', () => {
  const [alert] = normalizeAlerts(firingPayload());
  const existing = new Map([['alert:cashflow-tempo-export-failing', 1234]]);
  const plan = planActions([alert], existing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'comment');
  assert.equal(plan[0].issueNumber, 1234);
});

test('planActions: a resolved alert with an open issue → close', () => {
  const payload = firingPayload({ status: 'resolved' });
  payload.status = 'resolved';
  const [alert] = normalizeAlerts(payload);
  const existing = new Map([['alert:cashflow-tempo-export-failing', 1234]]);
  const plan = planActions([alert], existing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'close');
  assert.equal(plan[0].issueNumber, 1234);
});

test('planActions: a resolved alert with no open issue → noop', () => {
  const payload = firingPayload({ status: 'resolved' });
  payload.status = 'resolved';
  const [alert] = normalizeAlerts(payload);
  const plan = planActions([alert], new Map());
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'noop');
});

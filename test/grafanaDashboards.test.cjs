const { existsSync, readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const datasourceConfig = readFileSync('infra/grafana/provisioning/datasources/datasources.yaml', 'utf8');

function targetExpressions(dashboard) {
  return dashboard.panels.flatMap((panel) => (panel.targets || []).map((target) => target.expr).filter(Boolean));
}

test('grafana datasources use stable UIDs for trace/log links', () => {
  assert.match(datasourceConfig, /name: Loki\n\s+type: loki\n\s+access: proxy\n\s+uid: loki/);
  assert.match(datasourceConfig, /datasourceUid: tempo/);
  assert.match(datasourceConfig, /tracesToLogsV2:\n\s+datasourceUid: 'loki'/);
  assert.match(datasourceConfig, /filterByTraceID: true/);
});

test('grafana provisions cashflow dashboards from disk', () => {
  const providerPath = 'infra/grafana/provisioning/dashboards/dashboards.yaml';
  assert.equal(existsSync(providerPath), true);

  const provider = readFileSync(providerPath, 'utf8');
  assert.match(provider, /path: \/etc\/grafana\/provisioning\/dashboards\/cashflow/);

  for (const dashboard of [
    'infra/grafana/provisioning/dashboards/cashflow/api-health.json',
    'infra/grafana/provisioning/dashboards/cashflow/observability-stack.json',
    'infra/grafana/provisioning/dashboards/cashflow/route-drilldown.json',
    'infra/grafana/provisioning/dashboards/cashflow/backend-logs-jobs.json',
    'infra/grafana/provisioning/dashboards/cashflow/outbound-dependencies.json',
  ]) {
    assert.equal(existsSync(dashboard), true, `${dashboard} should exist`);
  }
});

test('api health dashboard shows useful metrics and links to logs and traces', () => {
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/api-health.json', 'utf8'),
  );
  const serialized = JSON.stringify(dashboard);
  const expressions = targetExpressions(dashboard);

  assert.equal(dashboard.uid, 'cashflow-api-health');
  assert.match(serialized, /cashflow_http_server_requests_total/);
  assert.match(serialized, /cashflow_http_server_duration_milliseconds_bucket/);
  assert.ok(expressions.includes('{service_name="cashflow-backend"}'));
  assert.match(serialized, /datasourceUid":"tempo"/);
  assert.match(serialized, /"uid":"loki"/);
});

test('observability stack dashboard shows telemetry pipeline health', () => {
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/observability-stack.json', 'utf8'),
  );
  const serialized = JSON.stringify(dashboard);
  const expressions = targetExpressions(dashboard);

  assert.equal(dashboard.uid, 'cashflow-observability-stack');
  assert.ok(
    expressions.includes('up{job="cashflow-otel-collector", instance="otel-collector.railway.internal:9464"}'),
  );
  assert.match(serialized, /scrape_samples_scraped/);
  assert.match(serialized, /otel-collector\.railway\.internal:9464/);
  assert.match(serialized, /datasourceUid":"tempo"/);
});

test('route drilldown dashboard scopes metrics and logs by selected route', () => {
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/route-drilldown.json', 'utf8'),
  );
  const serialized = JSON.stringify(dashboard);
  const expressions = targetExpressions(dashboard);

  assert.equal(dashboard.uid, 'cashflow-route-drilldown');
  assert.ok(dashboard.templating.list.some((variable) => variable.name === 'route'));
  assert.match(serialized, /label_values\(cashflow_http_server_requests_total, http_route\)/);
  assert.ok(expressions.some((expr) => expr.includes('http_route="$route"')));
  assert.ok(expressions.some((expr) => expr.includes('|= "$route"')));
  assert.match(serialized, /datasourceUid":"tempo"/);
});

test('backend logs and jobs dashboard exposes request and job log streams', () => {
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/backend-logs-jobs.json', 'utf8'),
  );
  const serialized = JSON.stringify(dashboard);
  const expressions = targetExpressions(dashboard);

  assert.equal(dashboard.uid, 'cashflow-backend-logs-jobs');
  assert.ok(expressions.some((expr) => expr.includes('{service_name="cashflow-backend"}')));
  assert.ok(expressions.some((expr) => expr.includes('job_tick')));
  assert.ok(expressions.some((expr) => expr.includes('http_request')));
  assert.match(serialized, /"uid":"loki"/);
});

test('outbound dependencies dashboard shows external HTTP client health', () => {
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/outbound-dependencies.json', 'utf8'),
  );
  const serialized = JSON.stringify(dashboard);
  const expressions = targetExpressions(dashboard);

  assert.equal(dashboard.uid, 'cashflow-outbound-dependencies');
  assert.match(serialized, /http_client_request_duration_seconds_count/);
  assert.match(serialized, /http_client_request_duration_seconds_bucket/);
  assert.match(serialized, /server_address/);
  assert.ok(expressions.some((expr) => expr.includes('query1') && expr.includes('finance') && expr.includes('yahoo')));
  assert.match(serialized, /datasourceUid":"tempo"/);
});

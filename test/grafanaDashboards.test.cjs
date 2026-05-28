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

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

test('api health dashboard has an SLO view matching the app-level alert thresholds', () => {
  // Issue #417: the HighHttp5xxRate (5xx ratio > 0.02) and HighRouteLatencyP99
  // (p99 > 1000ms) alerts must be visualizable on the dashboard so the on-call
  // can see how close we are to the error budget, not just that it tripped.
  const dashboard = JSON.parse(
    readFileSync('infra/grafana/provisioning/dashboards/cashflow/api-health.json', 'utf8'),
  );
  const panelsByTitle = Object.fromEntries(dashboard.panels.map((p) => [p.title, p]));

  // p99 route-latency panel — the signal HighRouteLatencyP99 fires on.
  const p99 = panelsByTitle['Route Latency p99'];
  assert.ok(p99, 'api-health dashboard must have a "Route Latency p99" panel');
  const p99Exprs = (p99.targets || []).map((t) => t.expr).filter(Boolean);
  assert.ok(
    p99Exprs.some((e) => /histogram_quantile\(\s*0\.99/.test(e)),
    'Route Latency p99 panel must use histogram_quantile(0.99, ...)',
  );
  assert.ok(
    p99Exprs.some((e) => e.includes('cashflow_http_server_duration_milliseconds_bucket')),
    'Route Latency p99 panel must read the request-duration histogram',
  );
  // The 1000ms alert threshold should be drawn on the panel.
  const p99Steps = p99.fieldConfig?.defaults?.thresholds?.steps || [];
  assert.ok(
    p99Steps.some((s) => s.value === 1000),
    'Route Latency p99 panel must mark the 1000ms alert threshold',
  );

  // 5xx error-budget stat — the ratio HighHttp5xxRate fires on (> 0.02).
  const budget = panelsByTitle['5xx Error Budget'];
  assert.ok(budget, 'api-health dashboard must have a "5xx Error Budget" SLO stat');
  const budgetExprs = (budget.targets || []).map((t) => t.expr).filter(Boolean);
  assert.ok(
    budgetExprs.some(
      (e) =>
        e.includes('http_response_status_code=~"5..') &&
        e.includes('/') &&
        e.includes('cashflow_http_server_requests_total'),
    ),
    'SLO stat must compute the 5xx ratio (5xx rate / total rate)',
  );
  assert.equal(budget.fieldConfig?.defaults?.unit, 'percentunit', 'SLO stat must render as a percentage');
  const budgetSteps = budget.fieldConfig?.defaults?.thresholds?.steps || [];
  assert.ok(
    budgetSteps.some((s) => s.value === 0.02),
    'SLO stat must mark the 2% error-budget threshold',
  );
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

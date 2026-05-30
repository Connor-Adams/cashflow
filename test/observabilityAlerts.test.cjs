const { existsSync, readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Cashflow issue #371 — observability stack must survive a clean SIGTERM and
// surface real downtime within 5 minutes.
//
// Repo-side guarantees this test enforces (Railway service settings live in
// the Railway dashboard, so they are documented but not enforceable here):
//
// 1. otel-collector exposes its own internal telemetry metrics on a port
//    Prometheus can reach (0.0.0.0:8888), not the loopback default.
// 2. Prometheus scrapes those self-metrics so the alert below has data.
// 3. Grafana provisions an alert rule group that fires when tempo/loki
//    exports fail or the collector becomes unreachable.
// 4. The decision (restartPolicyType: ALWAYS on tempo, loki, prometheus) is
//    documented in docs/observability.md so future readers know why.

test('otel-collector binds self-telemetry metrics so Prometheus can scrape them', () => {
  const config = readFileSync('infra/otel-collector/config.yaml', 'utf8');
  // The default is 127.0.0.1:8888 which only works in single-container envs.
  // Railway scrapes over the private network, so we must bind 0.0.0.0:8888.
  assert.match(
    config,
    /telemetry:\n(?:.*\n)*?\s+metrics:\n(?:.*\n)*?\s+address:\s*0\.0\.0\.0:8888\b/,
    'otel-collector telemetry.metrics.address must be 0.0.0.0:8888',
  );
});

test('prometheus scrapes otel-collector self-telemetry on port 8888', () => {
  const config = readFileSync('infra/prometheus/prometheus.yml', 'utf8');
  // The 9464 scrape covers app metrics emitted by the OTLP pipeline; the
  // 8888 scrape covers the collector's *own* health (otelcol_exporter_*).
  assert.match(
    config,
    /otel-collector\.railway\.internal:8888/,
    'prometheus must scrape otel-collector self-metrics on :8888',
  );
});

test('local docker-compose exposes otel-collector self-metrics port for dev parity', () => {
  const compose = readFileSync('infra/docker-compose.yml', 'utf8');
  assert.match(compose, /"8888:8888"/, 'docker-compose must expose 8888 on otel-collector');
});

test('grafana provisions alert rules for tempo, loki, and collector reachability', () => {
  const rulePath = 'infra/grafana/provisioning/alerting/observability-stack.yaml';
  assert.equal(existsSync(rulePath), true, `${rulePath} must exist`);

  const rules = readFileSync(rulePath, 'utf8');

  assert.match(rules, /apiVersion:\s*1\b/);
  assert.match(rules, /groups:/);

  // Tempo trace export failure — direct watchdog signal for the issue.
  assert.match(
    rules,
    /title:\s*TempoExportFailing\b/,
    'must include TempoExportFailing alert',
  );
  assert.match(
    rules,
    /rate\(otelcol_exporter_send_failed_spans_total\{exporter="otlphttp\/tempo"\}\[5m\]\)\s*>\s*0/,
    'TempoExportFailing must use the documented PromQL expression',
  );

  // Loki log export failure — same risk for the log pipeline.
  assert.match(rules, /title:\s*LokiExportFailing\b/);
  assert.match(
    rules,
    /otelcol_exporter_send_failed_log_records_total\{exporter="loki"\}/,
  );

  // Prometheus/collector reachability — covers prometheus down OR collector
  // crash-looping; both cause "no new metrics" with no other signal.
  assert.match(rules, /title:\s*OtelCollectorScrapeDown\b/);
  assert.match(rules, /up\{job="cashflow-otel-collector"\}\s*==\s*0/);

  // Every alert must fire within 5 minutes per the issue SLO.
  // `for: 1m` on top of the [5m] rate window keeps the worst-case alert
  // latency under 6 minutes, with most fires landing in 1-2 minutes.
  const forClauses = [...rules.matchAll(/for:\s*([0-9]+)([smh])/g)];
  assert.ok(forClauses.length >= 3, 'each alert must declare a `for:` duration');
  for (const [, value, unit] of forClauses) {
    const seconds =
      unit === 's' ? Number(value) : unit === 'm' ? Number(value) * 60 : Number(value) * 3600;
    assert.ok(
      seconds <= 5 * 60,
      `alert for: ${value}${unit} is too long; must be <= 5m to meet the 5-minute downtime SLO`,
    );
  }
});

test('docs document the restart-policy decision so the audit trail is in-repo', () => {
  const docs = readFileSync('docs/observability.md', 'utf8');
  assert.match(
    docs,
    /restartPolicyType:\s*ALWAYS/,
    'observability.md must document the ALWAYS restart policy decision',
  );
  // The doc must name all three services so a future reader doesn't fix one
  // and forget the others.
  assert.match(docs, /tempo/i);
  assert.match(docs, /loki/i);
  assert.match(docs, /prometheus/i);
  // The alert rule file must be referenced so readers can find it.
  assert.match(docs, /infra\/grafana\/provisioning\/alerting/);
});

test('each alert has a unique, anchored runbook_url so the on-call lands on the specific remediation', () => {
  const rules = readFileSync(
    'infra/grafana/provisioning/alerting/observability-stack.yaml',
    'utf8',
  );
  const urls = [...rules.matchAll(/runbook_url:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, 'each alert must declare a runbook_url');

  // Every runbook_url must include a fragment (#section) — pointing the on-call
  // at a section, not the top of the doc. Sharing the same generic anchor
  // across N alerts is the failure mode this guards against.
  for (const url of urls) {
    assert.ok(url.includes('#'), `runbook_url has no fragment anchor: ${url}`);
  }
  const unique = new Set(urls);
  assert.equal(
    unique.size,
    urls.length,
    `runbook_url collisions — each alert must point at its own subsection: ${[...unique].join(', ')}`,
  );

  // Each fragment must resolve to an actual heading in observability.md, so
  // the link is not just a guess.
  const docs = readFileSync('docs/observability.md', 'utf8');
  const headingAnchors = new Set(
    [...docs.matchAll(/^#+\s+(.+?)\s*$/gm)].map(([, h]) =>
      h
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    ),
  );
  for (const url of urls) {
    const anchor = url.split('#')[1];
    assert.ok(
      headingAnchors.has(anchor),
      `runbook_url '#${anchor}' does not resolve to a heading in docs/observability.md`,
    );
  }
});

test('observability docs and comments do not link to tool homepages instead of specific findings', () => {
  // The pattern this guards against: comments that "explain" an alert by
  // linking to grafana.com or prometheus.io instead of the specific alert
  // rule / panel / metric the comment refers to. Tool homepages tell the
  // on-call nothing they don't already know.
  const sources = {
    'docs/observability.md': readFileSync('docs/observability.md', 'utf8'),
    'infra/grafana/provisioning/alerting/observability-stack.yaml': readFileSync(
      'infra/grafana/provisioning/alerting/observability-stack.yaml',
      'utf8',
    ),
    'infra/otel-collector/config.yaml': readFileSync('infra/otel-collector/config.yaml', 'utf8'),
    'infra/prometheus/prometheus.yml': readFileSync('infra/prometheus/prometheus.yml', 'utf8'),
  };
  const banned = [
    /https?:\/\/(?:www\.)?grafana\.com\/?(?:\s|$|"|\))/i,
    /https?:\/\/(?:www\.)?prometheus\.io\/?(?:\s|$|"|\))/i,
    /https?:\/\/grafana\.github\.io\/?(?:\s|$|"|\))/i,
  ];
  for (const [path, body] of Object.entries(sources)) {
    for (const re of banned) {
      assert.doesNotMatch(
        body,
        re,
        `${path} links to a tool homepage; link to the specific alert rule, dashboard, or metric instead`,
      );
    }
  }
});

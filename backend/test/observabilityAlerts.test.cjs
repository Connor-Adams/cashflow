'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Parse YAML manually (or use a basic line-by-line extractor since we control the format)
// Simple approach: read the raw YAML as text and extract key fields via regex.

const yamlPath = path.join(__dirname, '../../infra/grafana/provisioning/alerting/observability-stack.yaml');
const docsPath = path.join(__dirname, '../../docs/observability.md');

const yaml = fs.readFileSync(yamlPath, 'utf8');
const docs = fs.readFileSync(docsPath, 'utf8');

// Extract all runbook_url values
const runbookUrls = [...yaml.matchAll(/runbook_url:\s+'([^']+)'/g)].map(m => m[1]);

// Extract all alert UIDs
const alertUids = [...yaml.matchAll(/uid:\s+(\S+)/g)].map(m => m[1]);

// Extract all anchors from docs (markdown headings as anchors)
const docAnchors = [...docs.matchAll(/^#{1,6}\s+(.+)/gm)].map(m => {
  return m[1].toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
});

describe('observability-stack alert rules', () => {
  const REQUIRED_ALERTS = [
    'cashflow-tempo-export-failing',
    'cashflow-loki-export-failing',
    'cashflow-otel-collector-scrape-down',
    'cashflow-backend-down',
    'cashflow-high-http-5xx-rate',
    'cashflow-high-route-latency-p99',
    'cashflow-outbound-dependency-failing',
    'cashflow-job-failing',
  ];

  test('all required alert UIDs are present', () => {
    for (const uid of REQUIRED_ALERTS) {
      assert.ok(alertUids.includes(uid), `Missing alert UID: ${uid}`);
    }
  });

  test('each alert has a unique runbook URL', () => {
    const seen = new Set();
    for (const url of runbookUrls) {
      assert.ok(!seen.has(url), `Duplicate runbook URL: ${url}`);
      seen.add(url);
    }
  });

  test('runbook URLs do not point to the homepage (must have a fragment anchor)', () => {
    for (const url of runbookUrls) {
      assert.ok(url.includes('#'), `Runbook URL missing anchor (#): ${url}`);
    }
  });

  test('each runbook anchor exists in docs/observability.md', () => {
    for (const url of runbookUrls) {
      const anchor = url.split('#')[1];
      assert.ok(anchor, `No anchor in runbook URL: ${url}`);
      assert.ok(
        docAnchors.includes(anchor),
        `Anchor #${anchor} not found in docs/observability.md. Available: ${docAnchors.join(', ')}`
      );
    }
  });

  test('all alerts have severity label', () => {
    // Count severity: occurrences (one per alert)
    const severities = [...yaml.matchAll(/severity:\s+(\S+)/g)].map(m => m[1]);
    assert.ok(severities.length >= REQUIRED_ALERTS.length, 'Some alerts are missing severity labels');
  });
});

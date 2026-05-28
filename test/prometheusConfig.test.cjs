const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const dockerfile = readFileSync('infra/prometheus/Dockerfile', 'utf8');
const config = readFileSync('infra/prometheus/prometheus.yml', 'utf8');

test('prometheus can write to Railway mounted volume and scrape collector over private DNS', () => {
  assert.match(dockerfile, /\nUSER root\n/);
  assert.match(config, /otel-collector\.railway\.internal:9464/);
});

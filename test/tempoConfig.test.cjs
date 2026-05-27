const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const compose = readFileSync('infra/docker-compose.yml', 'utf8');
const tempoConfig = readFileSync('infra/tempo/config.yaml', 'utf8');
const observabilityDocs = readFileSync('docs/observability.md', 'utf8');

test('tempo storage uses /var/tempo so the /tempo binary is not shadowed', () => {
  assert.match(compose, /tempo-data:\/var\/tempo\b/);
  assert.doesNotMatch(compose, /tempo-data:\/tempo\b/);

  assert.match(tempoConfig, /path: \/var\/tempo\/wal\b/);
  assert.match(tempoConfig, /path: \/var\/tempo\/traces\b/);
  assert.doesNotMatch(tempoConfig, /path: \/tempo\//);

  assert.match(observabilityDocs, /mount at `\/var\/tempo`/);
  assert.doesNotMatch(observabilityDocs, /mount at `\/tempo`/);
});

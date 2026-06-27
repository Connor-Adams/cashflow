const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

// Issue #860: Grafana's production admin password must never fall back to a
// known literal. The env var GF_SECURITY_ADMIN_PASSWORD must be supplied, and
// the container must refuse to boot if it is unset rather than coming up with a
// publicly-known credential behind a public domain.

const grafanaIni = readFileSync('infra/grafana/grafana.ini', 'utf8');
const entrypoint = readFileSync('infra/grafana/entrypoint.sh', 'utf8');

test('grafana.ini has no hardcoded admin-password fallback literal', () => {
  // The old `${GF_SECURITY_ADMIN_PASSWORD:-please-change-me}` shipped a live
  // default credential. There must be no `:-<literal>` fallback on the admin
  // password line.
  assert.doesNotMatch(grafanaIni, /please-change-me/, 'grafana.ini must not ship the known default password');

  const adminPwLine = grafanaIni
    .split('\n')
    .find((line) => line.trimStart().startsWith('admin_password'));
  assert.ok(adminPwLine, 'grafana.ini must define admin_password');
  assert.match(
    adminPwLine,
    /\$\{GF_SECURITY_ADMIN_PASSWORD\}/,
    'admin_password must reference the env var with no :- fallback default',
  );
  assert.doesNotMatch(
    adminPwLine,
    /GF_SECURITY_ADMIN_PASSWORD:-/,
    'admin_password must not provide a :- fallback default',
  );
});

test('entrypoint fails boot when GF_SECURITY_ADMIN_PASSWORD is unset', () => {
  // Run the entrypoint with the env var unset. `grafana`/`/run.sh` do not exist
  // in the test environment, so we rely on the guard exiting BEFORE exec — a
  // non-zero exit with the guard's message proves the guard fired. If the guard
  // were absent, the script would reach `exec /run.sh` and fail with a
  // different ("not found") error instead.
  const env = { ...process.env };
  delete env.GF_SECURITY_ADMIN_PASSWORD;

  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync('sh', ['infra/grafana/entrypoint.sh'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }

  assert.notEqual(exitCode, 0, 'entrypoint must exit non-zero when password is unset');
  assert.match(
    output,
    /GF_SECURITY_ADMIN_PASSWORD/,
    'entrypoint must explain that GF_SECURITY_ADMIN_PASSWORD is required',
  );
});

test('entrypoint fails boot when GF_SECURITY_ADMIN_PASSWORD is empty', () => {
  const env = { ...process.env, GF_SECURITY_ADMIN_PASSWORD: '' };

  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync('sh', ['infra/grafana/entrypoint.sh'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }

  assert.notEqual(exitCode, 0, 'entrypoint must exit non-zero when password is empty');
  assert.match(output, /GF_SECURITY_ADMIN_PASSWORD/);
});

test('entrypoint still guards the reset hook behind the env var and db existence', () => {
  // The reset path must remain gated on the var being set AND the db existing,
  // so first boot (no db) defers to Grafana's normal env-seed init.
  assert.match(entrypoint, /\$\{GF_SECURITY_ADMIN_PASSWORD:?-?\}?/);
  assert.match(entrypoint, /\/var\/lib\/grafana\/grafana\.db/);
  assert.match(entrypoint, /reset-admin-password/);
});

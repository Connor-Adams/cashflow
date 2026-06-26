import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePort,
  assertDatabaseUrl,
  assertDatabasePath,
  assertCorsOrigin,
  parseTrustProxy,
  loadEnvConfig,
} from './env';

test('parsePort: default when unset', () => {
  assert.equal(parsePort(undefined), 3001);
});

test('parsePort: valid number', () => {
  assert.equal(parsePort('8080'), 8080);
});

test('parsePort: rejects non-numeric', () => {
  assert.throws(() => parsePort('abc'), /PORT/);
});

test('parsePort: rejects non-integer', () => {
  assert.throws(() => parsePort('3.5'), /PORT/);
});

test('assertDatabasePath: rejects empty when explicitly set', () => {
  assert.throws(() => assertDatabasePath('   ', '/root'), /DATABASE_PATH/);
});

test('assertDatabasePath: accepts default path', () => {
  const p = assertDatabasePath(undefined, '/backend');
  assert.ok(p.includes('cashflow.sqlite'));
});

test('assertDatabaseUrl: accepts postgres URL', () => {
  assert.equal(
    assertDatabaseUrl('postgresql://user:pass@example.com:5432/db'),
    'postgresql://user:pass@example.com:5432/db'
  );
});

test('assertDatabaseUrl: rejects non-postgres URL', () => {
  assert.throws(() => assertDatabaseUrl('mysql://example.com/db'), /DATABASE_URL/);
});

test('assertCorsOrigin: default', () => {
  assert.equal(assertCorsOrigin(undefined), 'http://localhost:5173');
});

test('assertCorsOrigin: rejects invalid URL', () => {
  assert.throws(() => assertCorsOrigin('not-a-url'), /CORS_ORIGIN/);
});

test('assertCorsOrigin: accepts http URL', () => {
  assert.equal(assertCorsOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});

test('parseTrustProxy: defaults to false outside production', () => {
  assert.equal(parseTrustProxy(undefined, 'development'), false);
});

test('parseTrustProxy: defaults to one hop in production', () => {
  assert.equal(parseTrustProxy(undefined, 'production'), 1);
});

test('parseTrustProxy: accepts numeric hop count', () => {
  assert.equal(parseTrustProxy('1'), 1);
});

test('parseTrustProxy: accepts boolean strings outside production', () => {
  assert.equal(parseTrustProxy('true', 'development'), true);
  assert.equal(parseTrustProxy('false', 'development'), false);
});

test('parseTrustProxy: rejects trust-all (true) in production, clamps to 1', () => {
  // The footgun: TRUST_PROXY=true makes the whole X-Forwarded-For chain
  // trusted, so req.ip is attacker-spoofable. In production we must never
  // honor it — fall back to the safe single-hop default.
  assert.equal(parseTrustProxy('true', 'production'), 1);
  assert.equal(parseTrustProxy('TRUE', 'production'), 1);
});

test('parseTrustProxy: rejects false in production, clamps to 1', () => {
  assert.equal(parseTrustProxy('false', 'production'), 1);
});

test('parseTrustProxy: rejects non-numeric (e.g. subnet) in production, clamps to 1', () => {
  assert.equal(parseTrustProxy('loopback', 'production'), 1);
  assert.equal(parseTrustProxy('10.0.0.0/8', 'production'), 1);
});

test('parseTrustProxy: accepts numeric hop count in production', () => {
  assert.equal(parseTrustProxy('0', 'production'), 0);
  assert.equal(parseTrustProxy('2', 'production'), 2);
});

test('parseTrustProxy: rejects negative hop count in production, clamps to 1', () => {
  assert.equal(parseTrustProxy('-1', 'production'), 1);
});

test('loadEnvConfig: happy path with minimal env', () => {
  const c = loadEnvConfig({});
  assert.equal(typeof c.port, 'number');
  assert.equal(c.databaseUrl, null);
  assert.ok(c.databasePath.length > 0);
  assert.ok(c.csvUploadDir.length > 0);
});

test('loadEnvConfig: throws on bad PORT', () => {
  assert.throws(() => loadEnvConfig({ PORT: 'nope' }), /PORT/);
});

test('loadEnvConfig: throws on empty DATABASE_PATH', () => {
  assert.throws(() => loadEnvConfig({ DATABASE_PATH: '' }), /DATABASE_PATH/);
});

test('loadEnvConfig: accepts DATABASE_URL for postgres', () => {
  const c = loadEnvConfig({ DATABASE_URL: 'postgres://user:pass@example.com/db' });
  assert.equal(c.databaseUrl, 'postgres://user:pass@example.com/db');
});

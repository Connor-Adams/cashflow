import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePort,
  assertDatabasePath,
  assertCorsOrigin,
  loadEnvConfig,
} from '../src/config/env';

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

test('assertCorsOrigin: default', () => {
  assert.equal(assertCorsOrigin(undefined), 'http://localhost:5173');
});

test('assertCorsOrigin: rejects invalid URL', () => {
  assert.throws(() => assertCorsOrigin('not-a-url'), /CORS_ORIGIN/);
});

test('assertCorsOrigin: accepts http URL', () => {
  assert.equal(assertCorsOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});

test('loadEnvConfig: happy path with minimal env', () => {
  const c = loadEnvConfig({});
  assert.equal(typeof c.port, 'number');
  assert.ok(c.databasePath.length > 0);
  assert.ok(c.csvUploadDir.length > 0);
});

test('loadEnvConfig: throws on bad PORT', () => {
  assert.throws(() => loadEnvConfig({ PORT: 'nope' }), /PORT/);
});

test('loadEnvConfig: throws on empty DATABASE_PATH', () => {
  assert.throws(() => loadEnvConfig({ DATABASE_PATH: '' }), /DATABASE_PATH/);
});

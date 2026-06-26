import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDemoEnabled, resolveDemoPassword } from './demoConfig';

test('demo is enabled when DEMO_ACCOUNT_ENABLED is explicitly truthy (any env)', () => {
  assert.equal(isDemoEnabled('true', 'production'), true);
  assert.equal(isDemoEnabled('1', 'production'), true);
  assert.equal(isDemoEnabled('yes', 'development'), true);
  assert.equal(isDemoEnabled('TRUE', 'production'), true);
});

test('demo is disabled when DEMO_ACCOUNT_ENABLED is explicitly falsy (any env)', () => {
  assert.equal(isDemoEnabled('false', 'development'), false);
  assert.equal(isDemoEnabled('0', 'development'), false);
  assert.equal(isDemoEnabled('no', 'development'), false);
  assert.equal(isDemoEnabled('FALSE', 'development'), false);
});

test('demo defaults OFF in production when the flag is unset', () => {
  assert.equal(isDemoEnabled(undefined, 'production'), false);
  assert.equal(isDemoEnabled('', 'production'), false);
  assert.equal(isDemoEnabled('   ', 'production'), false);
});

test('demo defaults ON in non-production when the flag is unset', () => {
  assert.equal(isDemoEnabled(undefined, 'development'), true);
  assert.equal(isDemoEnabled(undefined, 'test'), true);
  assert.equal(isDemoEnabled('', 'staging'), true);
});

test('resolveDemoPassword uses the configured password when set', () => {
  assert.equal(resolveDemoPassword('my-secret'), 'my-secret');
  assert.equal(resolveDemoPassword('  spaced  '), '  spaced  ');
});

test('resolveDemoPassword never returns the legacy hardcoded password', () => {
  const generated = resolveDemoPassword(undefined);
  assert.notEqual(generated, 'cashflow-demo');
  assert.ok(generated.length >= 16, 'generated demo password must be sufficiently long');
});

test('resolveDemoPassword generates a fresh random password each call when unset', () => {
  const a = resolveDemoPassword(undefined);
  const b = resolveDemoPassword(undefined);
  assert.notEqual(a, b, 'unset demo password must not be a stable hardcoded value');
});

test('resolveDemoPassword treats blank string as unset (random, not legacy)', () => {
  const generated = resolveDemoPassword('   ');
  assert.notEqual(generated, 'cashflow-demo');
  assert.notEqual(generated.trim(), '');
});

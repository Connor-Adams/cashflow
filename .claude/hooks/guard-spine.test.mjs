import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpine } from './guard-spine.mjs';

test('warns on a NEW backend model file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/models/Foo.ts', fileExists: false });
  assert.match(warning, /primitives spine/i);
  assert.match(warning, /Transaction, Expectation/);
});

test('silent when the model file already exists (edit, not new)', () => {
  assert.deepEqual(classifySpine({ filePath: '/x/backend/src/models/Foo.ts', fileExists: true }), {});
});

test('silent on a non-matching path', () => {
  assert.deepEqual(classifySpine({ filePath: '/x/frontend/src/pages/Foo.tsx', fileExists: false }), {});
});

test('warns on a NEW route file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/tax/routes/scenarios.ts', fileExists: false });
  assert.match(warning, /route/);
});

test('warns on a NEW migration file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/migrations/20260605-foo.js', fileExists: false });
  assert.match(warning, /migration/);
});

test('warns on a NEW top-level backend route file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/routes/foo.ts', fileExists: false });
  assert.match(warning, /route/);
});

test('silent on a frontend route file (not backend)', () => {
  assert.deepEqual(classifySpine({ filePath: '/x/frontend/src/routes/Foo.ts', fileExists: false }), {});
});

test('warns on a NEW .cjs migration file', () => {
  const { warning } = classifySpine({ filePath: '/x/backend/src/migrations/20260605-foo.cjs', fileExists: false });
  assert.match(warning, /migration/);
});

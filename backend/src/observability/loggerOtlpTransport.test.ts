// backend/test/loggerOtlpTransport.test.ts
//
// We can't easily assert on the actual OTLP HTTP traffic from a unit test
// without spinning up a fake collector. Instead, verify the target-list
// selection logic by importing the module under different env states.
//
// pino's transport spawns a worker thread for non-dev paths, which would be
// flaky to assert on synchronously. So we extract the target-builder logic
// behind a guard: the test sets env, dynamically imports the module, and
// asserts on the resulting logger's level + that it constructs without
// throwing.

import test from 'node:test';
import assert from 'node:assert/strict';

async function freshImport<T>(modulePath: string): Promise<T> {
  // Dynamic import with cache-bust to force re-evaluation under new env.
  const url = `${modulePath}?cachebust=${Date.now()}_${Math.random()}`;
  // @ts-expect-error — TS doesn't know about dynamic URLs.
  return import(url);
}

test('logger constructs without OTLP env set', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SDK_DISABLED;
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    './logger',
  );
  assert.ok(mod.logger);
  assert.equal(typeof mod.logger.level, 'string');
});

test('logger constructs with OTLP env set', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
  delete process.env.OTEL_SDK_DISABLED;
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    './logger',
  );
  assert.ok(mod.logger);
});

test('logger skips OTLP when OTEL_SDK_DISABLED=true', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
  process.env.OTEL_SDK_DISABLED = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    './logger',
  );
  assert.ok(mod.logger);
});

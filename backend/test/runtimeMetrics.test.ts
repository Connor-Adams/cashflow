import { test } from 'node:test';
import assert from 'node:assert/strict';

test('RuntimeNodeInstrumentation is importable and constructible', async () => {
  const { RuntimeNodeInstrumentation } = await import(
    '@opentelemetry/instrumentation-runtime-node'
  );
  assert.strictEqual(typeof RuntimeNodeInstrumentation, 'function');
  const inst = new RuntimeNodeInstrumentation();
  assert.ok(inst, 'instance created');
});

test('RuntimeNodeInstrumentation is disabled in getNodeAutoInstrumentations to avoid duplicate', async () => {
  // otel.ts passes `{ '@opentelemetry/instrumentation-runtime-node': { enabled: false } }` to
  // getNodeAutoInstrumentations so the bundled copy is suppressed and our explicit instance
  // is the sole registration.
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  );
  const insts = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-runtime-node': { enabled: false },
  });
  const names = insts
    .filter((i: { isEnabled?: () => boolean }) => typeof i.isEnabled !== 'function' || i.isEnabled())
    .map((i: { instrumentationName: string }) => i.instrumentationName);
  assert.ok(
    !names.includes('@opentelemetry/instrumentation-runtime-node'),
    'runtime-node disabled in auto-instrumentations-node when explicitly registered',
  );
});

// backend/test/logger.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { als } from '../src/observability/requestContext';

// Build a fresh logger pointed at an in-memory sink so we can assert on the
// exact JSON written. We rebuild here (rather than importing the singleton)
// because the singleton's transport is platform-dependent and harder to spy
// on in tests.
function buildTestLogger(sink: { lines: string[] }) {
  return pino(
    {
      level: 'debug',
      base: { service: 'cashflow-backend', env: 'test' },
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const ctx = als.getStore() ?? {};
        return { ...ctx };
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    {
      write(chunk: string) {
        sink.lines.push(chunk);
      },
    },
  );
}

test('logger emits structured JSON with service + level', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  log.info({ foo: 'bar' }, 'event_name');
  assert.equal(sink.lines.length, 1);
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.level, 'info');
  assert.equal(entry.service, 'cashflow-backend');
  assert.equal(entry.msg, 'event_name');
  assert.equal(entry.foo, 'bar');
});

test('mixin injects ALS fields automatically', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  als.run({ requestId: 'rid-1', userId: 'u-1' }, () => {
    log.info('inside_context');
  });
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.requestId, 'rid-1');
  assert.equal(entry.userId, 'u-1');
});

test('outside ALS, no requestId field appears', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  log.info('no_context');
  const entry = JSON.parse(sink.lines[0]);
  assert.equal('requestId' in entry, false);
});

test('err serializer flattens Error to { message, stack, type }', () => {
  const sink = { lines: [] as string[] };
  const log = pino(
    {
      level: 'debug',
      serializers: { err: pino.stdSerializers.err },
    },
    { write(c: string) { sink.lines.push(c); } },
  );
  log.error({ err: new Error('boom') }, 'thing_failed');
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.err.message, 'boom');
  assert.equal(entry.err.type, 'Error');
  assert.equal(typeof entry.err.stack, 'string');
});

// Regression guard for PR #420: passing `spanProcessors` to NodeSDK silently
// discards the `traceExporter` option, so unless the processor list itself
// contains an exporting processor, spans are created (and their trace IDs leak
// into logs) but never shipped to the collector — Tempo gets zero traces.
//
// This asserts the real behavior: a span ended through the configured
// processors reaches the exporter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { buildSpanProcessors, autoInstrumentationConfig } from './otel';

test('autoInstrumentationConfig disables pino instrumentation (no double-logging to Loki)', () => {
  // The backend already exports logs via its own pino.multistream OTLP stream
  // (loggerOtlpTransport). If @opentelemetry/instrumentation-pino is also
  // enabled, every log line ships to Loki twice (2x ingestion) with a split
  // severity casing. Keep it disabled — the manual transport is the one path.
  assert.equal(
    autoInstrumentationConfig['@opentelemetry/instrumentation-pino']?.enabled,
    false,
    'instrumentation-pino must be disabled to avoid duplicate log emission',
  );
});

test('buildSpanProcessors exports ended spans to the trace exporter', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: buildSpanProcessors(exporter),
  });

  provider.getTracer('test').startSpan('unit-span').end();
  await provider.forceFlush();

  assert.equal(
    exporter.getFinishedSpans().length,
    1,
    'span must reach the exporter — the processor list lacks an exporting processor',
  );
});

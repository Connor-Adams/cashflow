// backend/src/observability/otel.ts
//
// OpenTelemetry NodeSDK bootstrap. Loaded as the FIRST import in server.ts so
// auto-instrumentations can patch modules before they're required elsewhere.
//
// Gated on OTEL_EXPORTER_OTLP_ENDPOINT being set (same env var the log
// destination already uses). OTEL_SDK_DISABLED=true skips registration.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// ATTR_DEPLOYMENT_ENVIRONMENT_NAME lives in /incubating which is not resolvable
// under "moduleResolution": "node". Use the string literal directly.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AlsSpanProcessor } from './alsSpanProcessor';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otlpEnabled = !!otlpEndpoint && process.env.OTEL_SDK_DISABLED !== 'true';

/**
 * Build the span processor chain for the NodeSDK.
 *
 * NodeSDK uses this array verbatim and IGNORES its `traceExporter` option when
 * `spanProcessors` is supplied — so the exporting processor MUST live here, or
 * spans are enriched but never shipped (Tempo gets zero traces; see #420).
 * AlsSpanProcessor first (enriches onStart), then the batch exporter.
 */
export function buildSpanProcessors(traceExporter: SpanExporter): SpanProcessor[] {
  return [new AlsSpanProcessor(), new BatchSpanProcessor(traceExporter)];
}

/**
 * Auto-instrumentation toggles. HTTP + Express + Sequelize + Undici stay on
 * (enabled by default). The rest are noise or duplicates:
 * - fs/dns/net: high-cardinality noise.
 * - runtime-node: registered explicitly below to avoid double registration.
 * - pino: the backend already ships logs to Loki via its own pino.multistream
 *   OTLP stream (loggerOtlpTransport). Leaving this enabled emits every log a
 *   second time through the OTel Logs SDK → 2x Loki ingestion and a split
 *   severity casing (INFO vs info). Keep it OFF — single path via the transport.
 */
export const autoInstrumentationConfig = {
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-dns': { enabled: false },
  '@opentelemetry/instrumentation-net': { enabled: false },
  '@opentelemetry/instrumentation-runtime-node': { enabled: false },
  '@opentelemetry/instrumentation-pino': { enabled: false },
} as const;

if (otlpEnabled) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'cashflow-backend',
      [ATTR_SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV ?? 'development',
    }),
    spanProcessors: buildSpanProcessors(
      new OTLPTraceExporter({
        url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
      }),
    ),
    instrumentations: [
      getNodeAutoInstrumentations(autoInstrumentationConfig),
      new RuntimeNodeInstrumentation(),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush any pending spans before exit.
  process.on('SIGTERM', () => {
    sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  });
}

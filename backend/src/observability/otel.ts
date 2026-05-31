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
import { AlsSpanProcessor } from './alsSpanProcessor';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otlpEnabled = !!otlpEndpoint && process.env.OTEL_SDK_DISABLED !== 'true';

if (otlpEnabled) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'cashflow-backend',
      [ATTR_SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    spanProcessors: [new AlsSpanProcessor()],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filter noisy/unwanted auto-instrumentations.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Disabled here so we can register RuntimeNodeInstrumentation explicitly below
        // (avoids duplicate registration when auto-instrumentations-node includes it).
        '@opentelemetry/instrumentation-runtime-node': { enabled: false },
        // HTTP + Express + Sequelize + Undici are what we care about; they're enabled by default.
      }),
      new RuntimeNodeInstrumentation(),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush any pending spans before exit.
  process.on('SIGTERM', () => {
    sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  });
}

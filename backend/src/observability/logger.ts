// backend/src/observability/logger.ts
import pino, { type LoggerOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';
import { createOtlpDestination } from './otlpDestination';

const isDev = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otlpEnabled = !!otlpEndpoint && process.env.OTEL_SDK_DISABLED !== 'true';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'cashflow-backend',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: {
    // Emit `level: "info"` instead of pino's numeric default — matches OTel
    // `severity_text` convention and Loki's expectations.
    level: (label) => ({ level: label }),
  },
  mixin() {
    const ctx = als.getStore() ?? {};
    const span = trace.getSpan(otelContext.active());
    const sc = span?.spanContext();
    return {
      ...ctx,
      ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}),
    };
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
    ],
    remove: true,
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

let logger: pino.Logger;

if (isDev) {
  // Dev: pino-pretty for human-readable stdout. OTLP unsupported in dev path
  // (most devs don't run the local collector); use Phase 2 docker-compose if needed.
  logger = pino({
    ...baseOptions,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:mm:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    },
  });
} else {
  // Prod / test: stdout is always written synchronously via the destination
  // arg. OTLP is added in parallel via pino.multistream so a destination
  // failure never kills stdout. All work happens on the main event loop —
  // no worker threads, no thread-stream.
  const otlpDestination = otlpEnabled
    ? createOtlpDestination({
        endpoint: otlpEndpoint!,
        serviceName: 'cashflow-backend',
        serviceVersion: process.env.GIT_SHA ?? 'dev',
        environment: process.env.NODE_ENV ?? 'development',
      })
    : undefined;

  const streams: Parameters<typeof pino.multistream>[0] = [
    { level: 'trace', stream: process.stdout },
    ...(otlpDestination ? [{ level: 'trace' as const, stream: otlpDestination }] : []),
  ];
  logger = pino(baseOptions, pino.multistream(streams));
}

export { logger };

// Backwards-compatible type aliases.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

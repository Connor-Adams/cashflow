// backend/src/observability/logger.ts
import pino, { type LoggerOptions, type TransportTargetOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

const isProd = process.env.NODE_ENV === 'production';
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

function buildTargets(): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [];

  if (isDev) {
    // Dev: pretty-print to stdout. pino-pretty writes to fd 1 itself.
    targets.push({
      target: 'pino-pretty',
      level: process.env.LOG_LEVEL ?? 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:mm:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    });
  } else {
    // Prod / test: JSON to stdout so Railway log capture keeps working.
    targets.push({
      target: 'pino/file',
      level: process.env.LOG_LEVEL ?? 'info',
      options: { destination: 1 },
    });
  }

  if (otlpEnabled) {
    // OTLP export in a worker thread; main loop never blocks on the network.
    targets.push({
      target: 'pino-opentelemetry-transport',
      level: process.env.LOG_LEVEL ?? 'info',
      options: {
        loggerName: 'cashflow-backend',
        serviceVersion: process.env.GIT_SHA ?? 'dev',
        resourceAttributes: {
          'service.name': 'cashflow-backend',
          'deployment.environment': process.env.NODE_ENV ?? 'development',
          'service.version': process.env.GIT_SHA ?? 'dev',
        },
        logRecordProcessorOptions: {
          recordProcessorType: 'batch',
          exporterOptions: {
            protocol: 'http/protobuf',
            url: `${otlpEndpoint!.replace(/\/$/, '')}/v1/logs`,
          },
        },
      },
    });
  }

  return targets;
}

const targets = buildTargets();

export const logger = pino(baseOptions, pino.transport({ targets }));

// Backwards-compatible type aliases.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

void isProd;

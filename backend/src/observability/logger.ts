// backend/src/observability/logger.ts
import pino, { type LoggerOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

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

function buildOtlpTransport() {
  if (!otlpEnabled) return undefined;
  try {
    const transport = pino.transport({
      target: 'pino-opentelemetry-transport',
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
            // Per otlp-logger v2 ProtobufExporterOptions, the URL goes inside protobufExporterOptions, not at this level.
            protobufExporterOptions: {
              url: `${otlpEndpoint!.replace(/\/$/, '')}/v1/logs`,
            },
          },
        },
      },
    });

    // Stream-level error: surfaces "the worker has exited" on each emit after worker death.
    transport.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error('[observability][diag] stream error:', err && err.message);
    });

    // Underlying Node worker-thread events: only fire ONCE on actual exit/crash.
    // thread-stream exposes the worker as `transport.worker`. Hook it before the
    // worker has a chance to die.
    const worker = (transport as unknown as { worker?: import('node:worker_threads').Worker }).worker;
    if (worker) {
      worker.on('exit', (code: number) => {
        // eslint-disable-next-line no-console
        console.error(`[observability][diag] WORKER EXIT code=${code}`);
      });
      worker.on('error', (err: Error) => {
        // eslint-disable-next-line no-console
        console.error('[observability][diag] WORKER ERROR:', err && err.message);
        // eslint-disable-next-line no-console
        if (err && err.stack) console.error(err.stack);
      });
      worker.on('message', (msg: unknown) => {
        // pino-abstract-transport emits 'WARNING' messages on issues like uncaught errors.
        if (msg && typeof msg === 'object' && 'code' in msg) {
          // eslint-disable-next-line no-console
          console.error('[observability][diag] WORKER MSG:', JSON.stringify(msg));
        }
      });
    } else {
      // eslint-disable-next-line no-console
      console.error('[observability][diag] no worker reference exposed on transport');
    }

    return transport;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[observability][diag] init threw:', err);
    return undefined;
  }
}

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
  // arg. OTLP is added in parallel via pino.multistream so a transport failure
  // never kills stdout.
  const otlpTransport = buildOtlpTransport();
  const streams: Parameters<typeof pino.multistream>[0] = [
    { level: 'trace', stream: process.stdout },
    ...(otlpTransport ? [{ level: 'trace' as const, stream: otlpTransport }] : []),
  ];
  logger = pino(baseOptions, pino.multistream(streams));
}

export { logger };

// Backwards-compatible type aliases.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

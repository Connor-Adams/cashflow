// backend/src/observability/logger.ts
import pino, { type LoggerOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

const isProd = process.env.NODE_ENV === 'production';
const isDev = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

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

const prettyTransport: LoggerOptions['transport'] | undefined = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:mm:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    }
  : undefined;

export const logger = pino({
  ...baseOptions,
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});

// Backwards-compatible type aliases so call sites that still import these
// don't break during the migration window. Remove in a follow-up once all
// callers use pino's call shape directly.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

// Stamp `isProd` into the file so the prod-only branches are tree-shaken.
void isProd;

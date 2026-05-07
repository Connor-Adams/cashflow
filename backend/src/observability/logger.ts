export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error)) return undefined;
  return {
    name: err.name,
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  };
}

function writeLog(level: LogLevel, event: string, fields: LogFields, err?: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    service: 'cashflow-backend',
    ...fields,
    error: serializeError(err),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.info(line);
}

export const logger = {
  debug(event: string, fields: LogFields = {}): void {
    if (process.env.LOG_LEVEL === 'debug') writeLog('debug', event, fields);
  },
  info(event: string, fields: LogFields = {}): void {
    writeLog('info', event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    writeLog('warn', event, fields);
  },
  error(event: string, fields: LogFields = {}, err?: unknown): void {
    writeLog('error', event, fields, err);
  },
};

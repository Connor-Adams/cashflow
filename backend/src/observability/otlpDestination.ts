// backend/src/observability/otlpDestination.ts
//
// Main-thread OTLP-JSON log exporter. Replaces pino-opentelemetry-transport
// because its worker-thread architecture has an environment-specific bug in
// Railway that aborts the worker's stream iterator at boot (root-caused via
// in-worker diagnostics, May 2026).
//
// Design:
// - Returns a Writable stream that pino.multistream writes JSON log lines into.
// - Buffers parsed records in memory; flushes on batch size or time interval.
// - POSTs OTLP-JSON to `${endpoint}/v1/logs` via global fetch.
// - All work happens on the main event loop. fetch is async; flushes are
//   non-blocking. No worker_threads, no thread-stream.
// - Errors during flush are logged to stderr; the batch is dropped to prevent
//   memory growth on a broken collector.

import { Writable } from 'node:stream';

export interface OtlpDestinationOpts {
  endpoint: string;            // e.g. http://otel-collector.railway.internal:4318
  serviceName: string;         // 'cashflow-backend'
  serviceVersion: string;      // GIT_SHA or 'dev'
  environment: string;         // NODE_ENV value
  batchSize?: number;          // default 100 records
  flushIntervalMs?: number;    // default 5000 ms
  maxBufferSize?: number;      // default 1000 records — drop oldest when exceeded
  headers?: Record<string, string>; // optional auth headers
}

interface PinoRecord {
  level?: number;
  time?: string | number;
  msg?: string;
  service?: string;
  env?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

const SEVERITY_TABLE: Record<number, [number, string]> = {
  10: [1, 'TRACE'],
  20: [5, 'DEBUG'],
  30: [9, 'INFO'],
  40: [13, 'WARN'],
  50: [17, 'ERROR'],
  60: [21, 'FATAL'],
};

export function createOtlpDestination(opts: OtlpDestinationOpts): Writable {
  const batchSize = opts.batchSize ?? 100;
  const flushIntervalMs = opts.flushIntervalMs ?? 5000;
  const maxBufferSize = opts.maxBufferSize ?? 1000;
  const url = `${opts.endpoint.replace(/\/$/, '')}/v1/logs`;

  const buffer: PinoRecord[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const drainBatch = async (): Promise<void> => {
    if (buffer.length === 0 || inFlight) return;
    inFlight = true;
    const batch = buffer.splice(0, batchSize);
    try {
      const payload = buildOtlpPayload(opts, batch);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[otlp-destination] POST ${url} returned ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[otlp-destination] POST ${url} failed:`, err instanceof Error ? err.message : err);
    } finally {
      inFlight = false;
      if (buffer.length >= batchSize) {
        // Still backed up — schedule another flush immediately.
        scheduleFlush(0);
      }
    }
  };

  const scheduleFlush = (delayMs = flushIntervalMs): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drainBatch();
    }, delayMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  return new Writable({
    objectMode: false,
    write(chunk: Buffer | string, _encoding, cb) {
      const line = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trimEnd();
      if (!line) return cb();
      let record: PinoRecord;
      try {
        record = JSON.parse(line) as PinoRecord;
      } catch {
        // Skip malformed lines — pino-pretty intermixed output or similar.
        return cb();
      }
      buffer.push(record);
      if (buffer.length > maxBufferSize) {
        // Drop oldest to bound memory if collector is unreachable.
        buffer.splice(0, buffer.length - maxBufferSize);
      }
      if (buffer.length >= batchSize) {
        void drainBatch();
      } else {
        scheduleFlush();
      }
      cb();
    },
    final(cb) {
      // Drain remaining buffer on shutdown. Best-effort, time-bounded.
      void drainBatch().finally(() => cb());
    },
  });
}

function buildOtlpPayload(opts: OtlpDestinationOpts, records: PinoRecord[]): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: opts.serviceName } },
            { key: 'service.version', value: { stringValue: opts.serviceVersion } },
            { key: 'deployment.environment', value: { stringValue: opts.environment } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: opts.serviceName, version: opts.serviceVersion },
            logRecords: records.map(toOtlpLogRecord),
          },
        ],
      },
    ],
  };
}

function toOtlpLogRecord(r: PinoRecord): unknown {
  const level = typeof r.level === 'number' ? r.level : 30;
  const [severityNumber, severityText] = SEVERITY_TABLE[level] ?? [9, 'INFO'];
  const timeUnixNano = toNanos(r.time);
  // Strip framework-owned fields from attributes; everything else flows through.
  const { level: _level, time: _time, msg, service: _service, env: _env, trace_id, span_id, ...rest } = r;
  void _level; void _time; void _service; void _env;
  const record: Record<string, unknown> = {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber,
    severityText,
    body: { stringValue: typeof msg === 'string' ? msg : '' },
    attributes: Object.entries(rest).map(([key, value]) => ({
      key,
      value: toAnyValue(value),
    })),
  };
  if (typeof trace_id === 'string' && trace_id.length > 0) record.traceId = trace_id;
  if (typeof span_id === 'string' && span_id.length > 0) record.spanId = span_id;
  return record;
}

function toNanos(time: PinoRecord['time']): string {
  let ms: number;
  if (typeof time === 'number') {
    ms = time;
  } else if (typeof time === 'string') {
    ms = Date.parse(time);
    if (Number.isNaN(ms)) ms = Date.now();
  } else {
    ms = Date.now();
  }
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function toAnyValue(v: unknown): unknown {
  if (v === null || v === undefined) return { stringValue: '' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (Number.isFinite(v) && Number.isInteger(v)) return { intValue: v };
    if (Number.isFinite(v)) return { doubleValue: v };
    return { stringValue: String(v) };
  }
  // Arrays + objects → JSON-encoded strings. OTel's anyValue supports array/kvList
  // but pino's structured fields are simple enough that JSON is acceptable.
  try {
    return { stringValue: JSON.stringify(v) };
  } catch {
    return { stringValue: String(v) };
  }
}

import { metrics, type Attributes } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

type MetricsEnv = {
  endpoint?: string;
  disabled?: string;
};

type HttpMetricInput = {
  method: string;
  routePath?: string;
  originalUrl: string;
  statusCode: number;
};

type MetricRecord = {
  value: number;
  attributes: Attributes;
};

type HttpMetricRecorder = {
  count(value: number, attributes: Attributes): void;
  duration(value: number, attributes: Attributes): void;
};

const idSegmentPattern =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function shouldEnableMetrics(
  env: MetricsEnv = {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    disabled: process.env.OTEL_SDK_DISABLED,
  },
): boolean {
  return Boolean(env.endpoint) && env.disabled !== 'true';
}

export function normalizeHttpRoute(rawPath: string): string {
  const path = rawPath.split('?')[0] || '/';
  return path
    .split('/')
    .map((part) => (idSegmentPattern.test(part) ? ':id' : part))
    .join('/');
}

export function buildMetricAttributes(input: HttpMetricInput): Attributes {
  return {
    'http.request.method': input.method,
    'http.route': input.routePath ?? normalizeHttpRoute(input.originalUrl),
    'http.response.status_code': input.statusCode,
  };
}

const meterProvider = shouldEnableMetrics()
  ? new MeterProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'cashflow-backend',
        [ATTR_SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
        'deployment.environment': process.env.NODE_ENV ?? 'development',
      }),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, '')}/v1/metrics`,
          }),
          exportIntervalMillis: 15000,
        }),
      ],
    })
  : undefined;

if (meterProvider) {
  metrics.setGlobalMeterProvider(meterProvider);
}

const meter = metrics.getMeter('cashflow-backend');

const requestCounter = meter.createCounter('cashflow.http.server.requests', {
  description: 'Total HTTP requests served by cashflow-backend',
});

const requestDuration = meter.createHistogram('cashflow.http.server.duration', {
  description: 'HTTP request duration for cashflow-backend',
  unit: 'ms',
});

export function recordHttpRequestWithRecorder(
  recorder: HttpMetricRecorder,
  input: HttpMetricInput & { durationMs: number },
): void {
  const attributes = buildMetricAttributes(input);
  recorder.count(1, attributes);
  recorder.duration(input.durationMs, attributes);
}

export function createTestMetricRecorder(): HttpMetricRecorder & {
  counts: MetricRecord[];
  durations: MetricRecord[];
} {
  const counts: MetricRecord[] = [];
  const durations: MetricRecord[] = [];
  return {
    counts,
    durations,
    count(value, attributes) {
      counts.push({ value, attributes });
    },
    duration(value, attributes) {
      durations.push({ value, attributes });
    },
  };
}

export function recordHttpRequest(input: HttpMetricInput & { durationMs: number }): void {
  recordHttpRequestWithRecorder(
    {
      count: (value, attributes) => requestCounter.add(value, attributes),
      duration: (value, attributes) => requestDuration.record(value, attributes),
    },
    input,
  );
}

export async function shutdownMetrics(): Promise<void> {
  await meterProvider?.shutdown();
}

// --- Job RED metrics ---

const jobRunCounter = meter.createCounter('cashflow.job.runs', {
  description: 'Total job tick executions',
});

const jobDurationHistogram = meter.createHistogram('cashflow.job.duration', {
  description: 'Job tick duration',
  unit: 'ms',
});

// Per-job last-success epoch seconds, updated on each successful tick.
// The observable gauge reads this map on each export cycle.
const jobLastSuccessTs = new Map<string, number>();

meter.createObservableGauge('cashflow.job.last_success_timestamp_seconds', {
  description: 'Unix epoch seconds of the last successful job tick, per job',
}).addCallback((observableResult) => {
  for (const [job, ts] of jobLastSuccessTs) {
    observableResult.observe(ts, { job });
  }
});

export function recordJobTick(opts: {
  job: string;
  result: 'success' | 'failure';
  durationMs: number;
}): void {
  jobRunCounter.add(1, { job: opts.job, result: opts.result });
  jobDurationHistogram.record(opts.durationMs, { job: opts.job });
  if (opts.result === 'success') {
    jobLastSuccessTs.set(opts.job, Math.floor(Date.now() / 1000));
  }
}

// --- DB pool metrics ---
// Observable gauges: read Sequelize connection-pool state on each export cycle.
// sequelize.connectionManager.pool is a generic-pool Pool; the properties are:
//   pool.size  (total connections), pool.borrowed (in-use), pool.pending (waiting),
//   pool.available (idle).
// We import sequelize lazily to avoid circular deps (db.ts → models → metrics fails
// if metrics.ts imports db.ts at module load). Use a function that reads the pool
// on each observation.

function getPool(): { size: number; borrowed: number; pending: number; available: number } | null {
  try {
    // Dynamic require to break potential circular dependency at module load time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sequelize } = require('../db') as { sequelize: import('sequelize').Sequelize };
    const pool = (sequelize.connectionManager as any).pool;
    if (!pool) return null;
    return {
      size: pool.size ?? 0,
      borrowed: pool.borrowed ?? 0,
      pending: pool.pending ?? 0,
      available: pool.available ?? 0,
    };
  } catch {
    return null;
  }
}

meter.createObservableGauge('cashflow.db.pool.size', {
  description: 'Total connections in the Sequelize pool',
}).addCallback((result) => {
  const p = getPool();
  if (p) result.observe(p.size);
});

meter.createObservableGauge('cashflow.db.pool.in_use', {
  description: 'Borrowed (active) connections in the Sequelize pool',
}).addCallback((result) => {
  const p = getPool();
  if (p) result.observe(p.borrowed);
});

meter.createObservableGauge('cashflow.db.pool.waiting', {
  description: 'Pending connection acquire requests',
}).addCallback((result) => {
  const p = getPool();
  if (p) result.observe(p.pending);
});

meter.createObservableGauge('cashflow.db.pool.available', {
  description: 'Idle connections in the Sequelize pool',
}).addCallback((result) => {
  const p = getPool();
  if (p) result.observe(p.available);
});

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

type SequelizePool = {
  _count: number;
  _inUseObjects: { size?: number; length?: number } | null;
  _availableObjects: { size?: number; length?: number } | null;
  _pendingAcquires: { size?: number; length?: number } | null;
};

function poolSize(collection: { size?: number; length?: number } | null): number {
  if (!collection) return 0;
  return collection.size ?? collection.length ?? 0;
}

/**
 * Register Sequelize connection-pool observable gauges. Call once after the
 * Sequelize instance is created (db.ts exports `sequelize`; call from server.ts
 * or from metrics bootstrap). No-ops when OTel metrics are disabled.
 */
export function registerDbPoolMetrics(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sequelizeInstance: any,
): void {
  if (!meterProvider) return;
  const pool = (): SequelizePool | null => sequelizeInstance?.connectionManager?.pool ?? null;

  meter
    .createObservableGauge('cashflow.db.pool.size', {
      description: 'Total connections in the Sequelize pool',
    })
    .addCallback((obs) => {
      const p = pool();
      obs.observe(p ? p._count : 0);
    });

  meter
    .createObservableGauge('cashflow.db.pool.in_use', {
      description: 'Connections currently borrowed from the pool',
    })
    .addCallback((obs) => {
      const p = pool();
      obs.observe(p ? poolSize(p._inUseObjects) : 0);
    });

  meter
    .createObservableGauge('cashflow.db.pool.available', {
      description: 'Idle connections available in the pool',
    })
    .addCallback((obs) => {
      const p = pool();
      obs.observe(p ? poolSize(p._availableObjects) : 0);
    });

  meter
    .createObservableGauge('cashflow.db.pool.waiting', {
      description: 'Pending acquire requests waiting for a connection',
    })
    .addCallback((obs) => {
      const p = pool();
      obs.observe(p ? poolSize(p._pendingAcquires) : 0);
    });
}

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

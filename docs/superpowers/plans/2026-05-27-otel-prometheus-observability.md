# OTel + Prometheus Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owned Railway-hosted Prometheus metrics while keeping Cashflow application instrumentation OpenTelemetry-native.

**Architecture:** The backend records HTTP metrics through OTel instruments and exports OTLP metrics to the existing collector. The collector exposes a Prometheus scrape endpoint; a new Prometheus Railway service scrapes that endpoint and stores time series on a Railway volume. Grafana then queries Prometheus for API health while Loki/Tempo remain the drilldown stores.

**Tech Stack:** TypeScript, Express, OpenTelemetry JS metrics SDK, OpenTelemetry Collector, Prometheus, Docker Compose, Railway, Grafana.

---

## File Structure

- Create `backend/src/observability/metrics.ts`: OTel meter provider setup, HTTP counter/histogram instruments, route-label helper, shutdown hook.
- Create `backend/test/metrics.test.ts`: unit tests for bounded route labels and disabled/no-op behavior.
- Modify `backend/src/observability/requestLogger.ts`: record request count and duration after each response.
- Modify `backend/src/server.ts`: import metrics setup before the app starts.
- Modify `backend/package.json` and `yarn.lock`: add OTel metrics packages.
- Modify `infra/otel-collector/config.yaml`: add Prometheus exporter and metrics pipeline.
- Create `infra/prometheus/Dockerfile`: Prometheus image.
- Create `infra/prometheus/prometheus.yml`: scrape collector metrics endpoint.
- Modify `infra/docker-compose.yml`: add Prometheus service and expose collector scrape endpoint locally.
- Modify `docs/observability.md`: document local/Railway Prometheus setup and verification.

## Task 1: Backend Metrics Module

**Files:**
- Create: `backend/src/observability/metrics.ts`
- Create: `backend/test/metrics.test.ts`
- Modify: `backend/package.json`

- [ ] **Step 1: Add dependencies**

Run:

```bash
yarn workspace cashflow-backend add @opentelemetry/exporter-metrics-otlp-http @opentelemetry/resources @opentelemetry/sdk-metrics @opentelemetry/semantic-conventions
```

Expected: `backend/package.json` gains the dependencies and `yarn.lock` updates.

- [ ] **Step 2: Write failing tests**

Create `backend/test/metrics.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHttpRoute,
  buildMetricAttributes,
  shouldEnableMetrics,
} from '../src/observability/metrics';

test('normalizeHttpRoute strips query strings and numeric path ids', () => {
  assert.equal(
    normalizeHttpRoute('/api/transactions/123?month=2026-05'),
    '/api/transactions/:id',
  );
});

test('normalizeHttpRoute strips UUID-like path ids', () => {
  assert.equal(
    normalizeHttpRoute('/api/import/batches/0f06f4b1-a497-44ff-ae29-4cb7b9d1cd22'),
    '/api/import/batches/:id',
  );
});

test('buildMetricAttributes prefers Express route pattern over raw URL', () => {
  const attrs = buildMetricAttributes({
    method: 'GET',
    routePath: '/api/transactions/:id',
    originalUrl: '/api/transactions/123?include=items',
    statusCode: 200,
  });

  assert.deepEqual(attrs, {
    'http.request.method': 'GET',
    'http.route': '/api/transactions/:id',
    'http.response.status_code': 200,
  });
});

test('shouldEnableMetrics follows existing OTEL kill switch', () => {
  assert.equal(shouldEnableMetrics({ endpoint: 'http://collector:4318', disabled: 'true' }), false);
  assert.equal(shouldEnableMetrics({ endpoint: undefined, disabled: undefined }), false);
  assert.equal(shouldEnableMetrics({ endpoint: 'http://collector:4318', disabled: undefined }), true);
});
```

- [ ] **Step 3: Run test to verify RED**

Run:

```bash
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/metrics.test.ts
```

Expected: fails because `../src/observability/metrics` does not exist.

- [ ] **Step 4: Implement metrics module**

Create `backend/src/observability/metrics.ts`:

```ts
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

const idSegmentPattern = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function shouldEnableMetrics(env: MetricsEnv = {
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  disabled: process.env.OTEL_SDK_DISABLED,
}): boolean {
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

export function recordHttpRequest(input: HttpMetricInput & { durationMs: number }): void {
  const attributes = buildMetricAttributes(input);
  requestCounter.add(1, attributes);
  requestDuration.record(input.durationMs, attributes);
}

export async function shutdownMetrics(): Promise<void> {
  await meterProvider?.shutdown();
}
```

- [ ] **Step 5: Run test to verify GREEN**

Run:

```bash
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/metrics.test.ts
```

Expected: all `metrics.test.ts` tests pass.

## Task 2: Record HTTP Metrics

**Files:**
- Modify: `backend/src/observability/requestLogger.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/test/metrics.test.ts`

- [ ] **Step 1: Add failing request recording test**

Append to `backend/test/metrics.test.ts`:

```ts
import { createTestMetricRecorder, recordHttpRequestWithRecorder } from '../src/observability/metrics';

test('recordHttpRequestWithRecorder records count and duration with bounded attributes', () => {
  const recorder = createTestMetricRecorder();

  recordHttpRequestWithRecorder(recorder, {
    method: 'POST',
    routePath: '/api/import/:id',
    originalUrl: '/api/import/456?debug=true',
    statusCode: 500,
    durationMs: 42,
  });

  assert.deepEqual(recorder.counts, [
    {
      value: 1,
      attributes: {
        'http.request.method': 'POST',
        'http.route': '/api/import/:id',
        'http.response.status_code': 500,
      },
    },
  ]);
  assert.deepEqual(recorder.durations, [
    {
      value: 42,
      attributes: {
        'http.request.method': 'POST',
        'http.route': '/api/import/:id',
        'http.response.status_code': 500,
      },
    },
  ]);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/metrics.test.ts
```

Expected: fails because `createTestMetricRecorder` and `recordHttpRequestWithRecorder` do not exist.

- [ ] **Step 3: Add injectable recorder helpers**

Add to `backend/src/observability/metrics.ts`:

```ts
type MetricRecord = {
  value: number;
  attributes: Attributes;
};

type HttpMetricRecorder = {
  count(value: number, attributes: Attributes): void;
  duration(value: number, attributes: Attributes): void;
};

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
```

Then replace `recordHttpRequest` body with:

```ts
export function recordHttpRequest(input: HttpMetricInput & { durationMs: number }): void {
  recordHttpRequestWithRecorder(
    {
      count: (value, attributes) => requestCounter.add(value, attributes),
      duration: (value, attributes) => requestDuration.record(value, attributes),
    },
    input,
  );
}
```

- [ ] **Step 4: Wire request logger**

In `backend/src/observability/requestLogger.ts`, add:

```ts
import { recordHttpRequest } from './metrics';
```

Inside `res.on('finish', () => { ... })`, after `durationMs` and `statusCode` are calculated, add:

```ts
recordHttpRequest({
  method: req.method,
  routePath: req.route?.path,
  originalUrl: req.originalUrl || req.url,
  statusCode,
  durationMs,
});
```

- [ ] **Step 5: Import metrics at startup**

At the top of `backend/src/server.ts`, before importing `app`, add:

```ts
import './observability/metrics';
```

- [ ] **Step 6: Verify**

Run:

```bash
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/metrics.test.ts
yarn workspace cashflow-backend run typecheck
```

Expected: metrics tests pass and backend typecheck exits 0.

## Task 3: Collector + Prometheus Infra

**Files:**
- Modify: `infra/otel-collector/config.yaml`
- Create: `infra/prometheus/Dockerfile`
- Create: `infra/prometheus/prometheus.yml`
- Modify: `infra/docker-compose.yml`

- [ ] **Step 1: Extend collector config**

Modify `infra/otel-collector/config.yaml`:

```yaml
exporters:
  loki:
    endpoint: http://${env:LOKI_HOST}:3100/loki/api/v1/push
    default_labels_enabled:
      exporter: false
      job: true
  prometheus:
    endpoint: 0.0.0.0:9464

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [loki]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
  telemetry:
    logs:
      level: info
```

If a trace exporter already exists in the file at implementation time, preserve it and add the metrics pipeline without deleting trace config.

- [ ] **Step 2: Add Prometheus image**

Create `infra/prometheus/Dockerfile`:

```dockerfile
FROM prom/prometheus:v2.55.1

COPY prometheus.yml /etc/prometheus/prometheus.yml

ENTRYPOINT ["/bin/prometheus"]
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=15d", "--web.listen-address=0.0.0.0:9090"]
```

- [ ] **Step 3: Add Prometheus scrape config**

Create `infra/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: cashflow-otel-collector
    static_configs:
      - targets:
          - otel-collector:9464
```

For Railway, keep the same service name if the Prometheus service runs in the same Railway environment; Railway private DNS should resolve `otel-collector.railway.internal` if the plain service name does not.

- [ ] **Step 4: Add Compose service**

Modify `infra/docker-compose.yml` so `otel-collector` exposes `9464` and add:

```yaml
  prometheus:
    build: ./prometheus
    ports:
      - "9090:9090"
    volumes:
      - prometheus-data:/prometheus
    depends_on:
      - otel-collector

volumes:
  loki-data:
  prometheus-data:
```

- [ ] **Step 5: Verify Compose config**

Run:

```bash
cd infra && docker compose config
```

Expected: config renders successfully and includes `prometheus`, `otel-collector`, `loki`, `prometheus-data`, and `loki-data`.

## Task 4: Docs + Grafana Setup Notes

**Files:**
- Modify: `docs/observability.md`

- [ ] **Step 1: Update docs**

Add a Prometheus section to `docs/observability.md`:

```md
## Prometheus metrics

Cashflow uses OpenTelemetry in application code and Prometheus as the first owned metrics store.

Local flow:

1. Backend exports OTLP metrics to `otel-collector` at `http://localhost:4318/v1/metrics`.
2. The collector exposes Prometheus-format metrics at `http://localhost:9464/metrics`.
3. Prometheus scrapes the collector and serves PromQL at `http://localhost:9090`.

Verify locally:

```bash
cd infra
docker compose up -d --build
curl -fsS http://localhost:9464/metrics | head
curl -fsS 'http://localhost:9090/api/v1/query?query=up'
```

Railway:

- Create a `prometheus` service from `ghcr.io/connor-adams/cashflow-prometheus:production`.
- Mount a volume at `/prometheus`.
- Keep the service private-network only.
- Add a Grafana Prometheus datasource pointing to `http://prometheus.railway.internal:9090`.
```

- [ ] **Step 2: Verify docs formatting**

Run:

```bash
rg -n "Prometheus metrics|localhost:9464|prometheus.railway.internal" docs/observability.md
```

Expected: all three strings are present.

## Task 5: End-to-End Verification

**Files:**
- No new source files unless prior tasks reveal a defect.

- [ ] **Step 1: Backend verification**

Run:

```bash
yarn workspace cashflow-backend exec tsx --import ./test/setup.ts --test test/metrics.test.ts
yarn workspace cashflow-backend run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Infra verification**

Run:

```bash
cd infra && docker compose up -d --build
curl -fsS http://localhost:9464/metrics | head
curl -fsS 'http://localhost:9090/api/v1/query?query=up'
cd infra && docker compose down
```

Expected: collector metrics endpoint responds, Prometheus query returns JSON with status `success`, and Compose shuts down cleanly.

- [ ] **Step 3: Full backend build**

Run:

```bash
yarn workspace cashflow-backend run build
```

Expected: build exits 0.

## Self-Review

- Spec coverage: backend OTel metrics, collector metrics pipeline, Prometheus Railway service, Grafana datasource/dashboard notes, and Mimir scaling path are covered.
- Completion scan: no unresolved template text is present.
- Type consistency: helper names used in tests are defined in Task 2 before final verification.

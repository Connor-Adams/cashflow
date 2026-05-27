import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHttpRoute,
  buildMetricAttributes,
  shouldEnableMetrics,
  createTestMetricRecorder,
  recordHttpRequestWithRecorder,
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

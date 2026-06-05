import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_CONTEXT, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import { runBackfillBatchTrace } from './backfillTrace';

function fakeSpan(traceId: string): Span {
  return {
    spanContext: () => ({
      traceId,
      spanId: '1234567890abcdef',
      traceFlags: 1,
    }),
    setAttribute: () => fakeSpan(traceId),
    setAttributes: () => fakeSpan(traceId),
    addEvent: () => fakeSpan(traceId),
    addLink: () => fakeSpan(traceId),
    addLinks: () => fakeSpan(traceId),
    setStatus: () => fakeSpan(traceId),
    updateName: () => fakeSpan(traceId),
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined,
  };
}

test('backfill batch trace starts detached from the active request trace', async () => {
  const requestSpan = fakeSpan('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const batchSpan = fakeSpan('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  let parentContextWasRoot = false;
  let spanPassedToCallback = false;
  let spanEnded = false;
  let startOptions: { attributes?: Record<string, unknown> } | undefined;
  const getActiveSpan = mock.method(trace, 'getActiveSpan', () => requestSpan);

  const getTracer = mock.method(trace, 'getTracer', () => ({
    startActiveSpan: async (
      _name: string,
      options: { attributes?: Record<string, unknown> },
      parentContext: unknown,
      fn: (span: Span) => Promise<string>,
    ) => {
      parentContextWasRoot = parentContext === ROOT_CONTEXT;
      startOptions = options;
      try {
        const span = {
          ...batchSpan,
          end: () => {
            spanEnded = true;
          },
        };
        return await fn(span);
      } finally {
        getActiveSpan.mock.restore();
        getTracer.mock.restore();
      }
    },
  }));

  const result = await context.with(trace.setSpan(ROOT_CONTEXT, requestSpan), async () =>
    runBackfillBatchTrace(
      {
        householdId: 7,
        batchIndex: 3,
        batchSize: 100,
        offset: 200,
        total: 2662,
        dryRun: true,
      },
      async (span) => {
        spanPassedToCallback =
          span.spanContext().traceId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        return 'batch-complete';
      },
    ),
  );

  assert.equal(parentContextWasRoot, true);
  assert.equal(
    startOptions?.attributes?.['cashflow.backfill.parent_trace_id'],
    requestSpan.spanContext().traceId,
  );
  assert.equal(
    startOptions?.attributes?.['cashflow.backfill.parent_span_id'],
    requestSpan.spanContext().spanId,
  );
  assert.equal(spanPassedToCallback, true);
  assert.equal(result, 'batch-complete');
  assert.equal(spanEnded, true);
});

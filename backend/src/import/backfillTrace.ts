import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';

export type BackfillBatchTraceAttributes = {
  householdId: number | null;
  batchIndex: number;
  batchSize: number;
  offset: number;
  total: number;
  dryRun: boolean;
};

export async function runBackfillBatchTrace<T>(
  attrs: BackfillBatchTraceAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('cashflow-enrichment-backfill');
  const activeSpanContext = trace.getActiveSpan()?.spanContext();
  const traceAttributes: Attributes = {
    'cashflow.household_id': attrs.householdId ?? 'unknown',
    'cashflow.backfill.batch_index': attrs.batchIndex,
    'cashflow.backfill.batch_size': attrs.batchSize,
    'cashflow.backfill.offset': attrs.offset,
    'cashflow.backfill.total': attrs.total,
    'cashflow.backfill.dry_run': attrs.dryRun,
  };

  if (activeSpanContext) {
    traceAttributes['cashflow.backfill.parent_trace_id'] = activeSpanContext.traceId;
    traceAttributes['cashflow.backfill.parent_span_id'] = activeSpanContext.spanId;
  }

  return await tracer.startActiveSpan(
    'enrichment_backfill.batch',
    {
      attributes: traceAttributes,
    },
    ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

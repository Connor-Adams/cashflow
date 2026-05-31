/**
 * Shared helper for wrapping a background-job tick in a root OTel span.
 * Used by the job runner (all jobs) and by backfillTrace.ts (enrichment).
 */
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

export type JobSpanOptions = {
  spanName: string;
  jobName: string;
  tickId?: string;
  householdId?: string | number | null;
};

export async function runJobSpan<T>(
  opts: JobSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('cashflow-jobs');
  const attrs: Record<string, string | number | boolean> = {
    'cashflow.job.name': opts.jobName,
  };
  if (opts.tickId) attrs['cashflow.job.tick_id'] = opts.tickId;
  if (opts.householdId != null) attrs['cashflow.household_id'] = String(opts.householdId);

  return tracer.startActiveSpan(
    opts.spanName,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ROOT_CONTEXT,
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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

import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

export async function runWithJobSpan<T>(
  jobName: string,
  tickId: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('cashflow-jobs');
  return tracer.startActiveSpan(
    `job.${jobName}`,
    {
      attributes: {
        'cashflow.job.name': jobName,
        'cashflow.job.tick_id': tickId,
      },
    },
    ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// Shared helper for wrapping a job tick in an OTel root span. Every
// registered job uses this so all ticks appear in Tempo without needing
// per-definition boilerplate. Root context is detached from any active
// HTTP span — job ticks are independent traces.
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('cashflow-jobs');

export async function runWithJobSpan<T>(
  jobName: string,
  tickId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `job.${jobName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'cashflow.job.name': jobName,
        'cashflow.job.tick_id': tickId,
      },
    },
    ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn();
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

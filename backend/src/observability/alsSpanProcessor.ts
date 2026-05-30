// Custom SpanProcessor that copies ALS log context onto span attributes so
// traces can be filtered by household/user in Tempo. Sets on span start —
// setting on every child span is redundant but the cost is a few string copies,
// which is acceptable per issue #420.
//
// Privacy note: only internal opaque IDs (householdId, userId) are added —
// no email, name, or financial data.
import type { Context, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { currentContext } from './requestContext';

export class AlsSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    const ctx = currentContext();
    if (!ctx) return;
    if (ctx.householdId) span.setAttribute('cashflow.household_id', ctx.householdId);
    if (ctx.userId) span.setAttribute('cashflow.user_id', ctx.userId);
    if (ctx.requestId) span.setAttribute('cashflow.request_id', ctx.requestId);
    if (ctx.route) span.setAttribute('cashflow.route', ctx.route);
    if (ctx.role) span.setAttribute('enduser.role', ctx.role);
    if (ctx.jobName) span.setAttribute('cashflow.job.name', ctx.jobName);
    if (ctx.tickId) span.setAttribute('cashflow.job.tick_id', ctx.tickId);
  }

  onEnd(_span: ReadableSpan): void {
    // no-op — we only enrich on start
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

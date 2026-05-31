/**
 * AlsSpanProcessor — copies AsyncLocalStorage request context onto spans.
 *
 * Reads the current LogContext from the ALS store (populated in app.ts
 * after requireAuth) and sets cashflow.household_id, cashflow.user_id,
 * cashflow.request_id, cashflow.route, and enduser.role on each span as
 * it starts. Only non-empty string values are set; missing context keys
 * are silently skipped.
 *
 * Attribute keys are kept consistent with backfillTrace.ts which already
 * uses 'cashflow.household_id'.
 *
 * Privacy: userId/householdId are opaque internal IDs, not PII (no email,
 * name, or financial values). Do not extend this to financial amounts or
 * personally identifiable strings.
 */
import type { Span, Context } from '@opentelemetry/api';
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
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
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// backend/src/observability/requestContext.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = {
  requestId?: string;
  userId?: string;
  householdId?: string;
  role?: string;
  route?: string;
  jobName?: string;
  tickId?: string;
};

export const als = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with the merged log context active. Any existing fields from a
 * surrounding `withContext` call are preserved; new fields override on key
 * collision. Reads via `als.getStore()` inside `fn` (or anywhere on its
 * async continuation) see the merged store.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...als.getStore(), ...ctx };
  return als.run(merged, fn);
}

/** Read the current context (or `undefined` if no `withContext` is active). */
export function currentContext(): LogContext | undefined {
  return als.getStore();
}

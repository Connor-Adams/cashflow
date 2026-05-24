import type { Request, Response, NextFunction } from 'express';
import { getChatConfig } from '../config/chat';

/**
 * Per-thread message rate limiter for POST /api/chat/threads/:id/messages
 * (PR2 Task 14). Uses a simple in-memory sliding-window bucket keyed by
 * threadId. Resets are best-effort: the bucket window restarts the first time
 * a thread is touched after `hourMs` has elapsed since `windowStart`.
 *
 * In-memory storage is fine for the current single-process backend; if/when we
 * scale horizontally this will need to move to a shared store (Redis, etc.).
 */
interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<number, Bucket>();

export function perThreadMessageLimiter(req: Request, res: Response, next: NextFunction): void {
  const threadId = parseInt(req.params.id, 10);
  if (!Number.isFinite(threadId)) {
    next();
    return;
  }
  const cfg = getChatConfig();
  const now = Date.now();
  const hourMs = 3600 * 1000;
  const bucket = buckets.get(threadId);
  if (!bucket || now - bucket.windowStart > hourMs) {
    buckets.set(threadId, { windowStart: now, count: 1 });
    next();
    return;
  }
  bucket.count++;
  if (bucket.count > cfg.perThreadMessagesPerHour) {
    res.setHeader('Retry-After', String(Math.ceil((hourMs - (now - bucket.windowStart)) / 1000)));
    res.status(429).json({
      error: 'per_thread_rate_limit',
      max: cfg.perThreadMessagesPerHour,
      window: 'hour',
    });
    return;
  }
  next();
}

/** Test-only: clear all buckets. */
export function __resetChatRateLimitForTest() {
  buckets.clear();
}

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  perThreadMessageLimiter,
  __resetChatRateLimitForTest,
} from './chatRateLimit';

beforeEach(() => {
  __resetChatRateLimitForTest();
  process.env.CHAT_PER_THREAD_MSGS_PER_HOUR = '3';
});

function makeReqRes(threadId: string) {
  const req = { params: { id: threadId } } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(_body: unknown) {
      (this as unknown as { body: unknown }).body = _body;
      return this;
    },
  } as unknown as Response;
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  return { req, res, next, wasNext: () => nextCalled };
}

test('perThreadMessageLimiter allows up to N requests per hour', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next, wasNext } = makeReqRes('42');
    perThreadMessageLimiter(req, res, next);
    assert.equal(wasNext(), true, `req ${i + 1} should pass`);
  }
});

test('perThreadMessageLimiter rejects N+1th request with 429', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes('42');
    perThreadMessageLimiter(req, res, next);
  }
  const { req, res, next, wasNext } = makeReqRes('42');
  perThreadMessageLimiter(req, res, next);
  assert.equal(wasNext(), false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
  assert.equal(
    (res as unknown as { body: { error: string } }).body.error,
    'per_thread_rate_limit'
  );
});

test('perThreadMessageLimiter is per-thread (different threadId resets)', () => {
  for (let i = 0; i < 3; i++) {
    const { req, res, next } = makeReqRes('42');
    perThreadMessageLimiter(req, res, next);
  }
  // Different thread should still pass
  const { req, res, next, wasNext } = makeReqRes('43');
  perThreadMessageLimiter(req, res, next);
  assert.equal(wasNext(), true);
});

test('__resetChatRateLimitForTest clears all buckets', () => {
  for (let i = 0; i < 4; i++) {
    const { req, res, next } = makeReqRes('42');
    perThreadMessageLimiter(req, res, next);
  }
  __resetChatRateLimitForTest();
  const { req, res, next, wasNext } = makeReqRes('42');
  perThreadMessageLimiter(req, res, next);
  assert.equal(wasNext(), true);
});

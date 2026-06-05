// backend/test/loggerIntegration.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pino from 'pino';
import { als } from './requestContext';
import { withContext } from './requestContext';

test('ALS context set in middleware appears in pino log written from a handler', async () => {
  const lines: string[] = [];
  const log = pino(
    {
      level: 'debug',
      mixin() { return { ...als.getStore() }; },
    },
    { write(c: string) { lines.push(c); } },
  );

  const app = express();
  app.use((req, _res, next) => {
    withContext({ requestId: 'integration-rid', userId: 'u-int' }, () => next());
  });
  app.get('/x', (_req, res) => {
    log.info({ where: 'handler' }, 'handler_log');
    res.json({ ok: true });
  });

  // Drive a synthetic request through Express.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const res = await fetch(`http://127.0.0.1:${addr.port}/x`);
        await res.json();
        server.close();
        resolve();
      } catch (e) { reject(e); }
    });
  });

  const handlerLine = lines.find((l) => l.includes('handler_log'));
  assert.ok(handlerLine, 'handler log was not captured');
  const entry = JSON.parse(handlerLine);
  assert.equal(entry.requestId, 'integration-rid');
  assert.equal(entry.userId, 'u-int');
  assert.equal(entry.where, 'handler');
});

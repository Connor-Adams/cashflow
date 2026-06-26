/**
 * Unit tests for the health/readiness routes.
 *
 * Liveness (`GET /api/health`) must never touch the DB. Readiness
 * (`GET /api/health/ready`) probes the DB with a bounded `SELECT 1` and returns
 * 503 when that query fails or times out. The sequelize call is mocked so these
 * stay pure unit tests (no real DB needed).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { sequelize } from '../db';
import healthRouter from './health';

const app = express();
app.use('/api/health', healthRouter);

const originalQuery = sequelize.query.bind(sequelize);

afterEach(() => {
  // Restore the real query after each test mutates it.
  (sequelize as unknown as { query: typeof sequelize.query }).query = originalQuery;
});

function mockQuery(impl: () => Promise<unknown>): void {
  (sequelize as unknown as { query: () => Promise<unknown> }).query = impl;
}

test('liveness returns 200 and never touches the DB', async () => {
  let queried = false;
  mockQuery(() => {
    queried = true;
    return Promise.resolve([]);
  });

  const res = await request(app).get('/api/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'cashflow-backend');
  assert.equal(queried, false, 'liveness must not probe the DB');
});

test('readiness returns 200 when the DB answers', async () => {
  mockQuery(() => Promise.resolve([[{ '1': 1 }], {}]));

  const res = await request(app).get('/api/health/ready');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('readiness returns 503 when the DB query rejects', async () => {
  mockQuery(() => Promise.reject(new Error('ECONNREFUSED')));

  const res = await request(app).get('/api/health/ready');

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false, db: 'down' });
});

test('readiness returns 503 when the DB probe times out', async () => {
  // Never resolves — the bounded timeout must win and report the DB down.
  mockQuery(() => new Promise(() => {}));

  const res = await request(app).get('/api/health/ready');

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false, db: 'down' });
});

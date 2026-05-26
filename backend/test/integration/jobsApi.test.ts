import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import express, { type Express } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-jobs-api.sqlite');

let app: Express;
let models: typeof import('../../src/models');
let registry: typeof import('../../src/jobs/registry');
let jobsRouter: import('express').Router;

async function authedRequest(
  method: string,
  url: string,
  role: 'owner' | 'member' | 'superadmin',
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address() as { port: number };
        const r = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-test-role': role,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        server.close();
        resolve({ status: r.status, json: text ? JSON.parse(text) : null });
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  models = await import('../../src/models');
  registry = await import('../../src/jobs/registry');
  registry.__resetForTest();
  registry.defineJob({
    name: 'api_test_job',
    cronDefault: '*/15 * * * *',
    enabledDefault: true,
    handler: async () => ({ summary: { ok: true } }),
  });
  const mod = await import('../../src/jobs/api');
  jobsRouter = mod.default;
  app = express();
  app.use(express.json());
  // Stub auth: superadmin gated by header for tests.
  app.use((req, _res, next) => {
    (req as any).auth = {
        user: {
          id: 1,
          email: 'test@example.com',
          globalRole: req.headers['x-test-role'] === 'superadmin' ? 'superadmin' : 'user',
        },
        household: { id: 1 },
      role: req.headers['x-test-role'] === 'member' ? 'member' : 'owner',
    };
    next();
  });
  app.use('/api/jobs', jobsRouter);
});

after(async () => {
  registry.stopAllJobs();
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Job.destroy({ where: {}, truncate: true });
  await models.JobRun.destroy({ where: {}, truncate: true });
});

test('GET /api/jobs requires owner', async () => {
  const r = await authedRequest('GET', '/api/jobs', 'member');
  assert.equal(r.status, 403);
});

test('GET /api/jobs returns the registered job', async () => {
  const r = await authedRequest('GET', '/api/jobs', 'owner');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  const job = r.json.find((j: any) => j.name === 'api_test_job');
  assert.ok(job);
  assert.equal(job.cron, '*/15 * * * *');
  assert.equal(job.enabled, true);
  assert.equal(job.source.enabled, 'env');
});

test('PATCH /api/jobs/:name persists overrides; null resets', async () => {
  let r = await authedRequest('PATCH', '/api/jobs/api_test_job', 'owner', {
    enabled: false,
    cron: '*/30 * * * *',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.cron, '*/30 * * * *');
  assert.equal(r.json.source.enabled, 'db');
  assert.equal(r.json.source.cron, 'db');

  r = await authedRequest('PATCH', '/api/jobs/api_test_job', 'owner', {
    enabled: null,
    cron: null,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.source.enabled, 'env');
  assert.equal(r.json.source.cron, 'env');
});

test('PATCH rejects invalid cron with 400', async () => {
  const r = await authedRequest('PATCH', '/api/jobs/api_test_job', 'owner', {
    cron: 'not-a-cron',
  });
  assert.equal(r.status, 400);
});

test('POST /api/jobs/:name/run triggers handler', async () => {
  const r = await authedRequest('POST', '/api/jobs/api_test_job/run', 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.jobName, 'api_test_job');
  assert.ok(r.json.runId);
  assert.ok(r.json.queuedAt);
});

test('POST /api/jobs/:unknown/run returns 404', async () => {
  const r = await authedRequest('POST', '/api/jobs/nope/run', 'owner');
  assert.equal(r.status, 404);
});

test('GET /api/jobs/:name/runs returns newest-first recent history', async () => {
  await models.JobRun.bulkCreate([
    {
      jobName: 'api_test_job',
      startedAt: new Date('2026-05-26T10:00:00Z'),
      finishedAt: new Date('2026-05-26T10:00:01Z'),
      status: 'success',
      durationMs: 10,
      errorMessage: null,
    },
    {
      jobName: 'api_test_job',
      startedAt: new Date('2026-05-26T11:00:00Z'),
      finishedAt: new Date('2026-05-26T11:00:01Z'),
      status: 'failed',
      durationMs: 20,
      errorMessage: 'boom',
    },
  ]);

  const r = await authedRequest('GET', '/api/jobs/api_test_job/runs?limit=1', 'owner');

  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].status, 'failed');
  assert.equal(r.json[0].errorMessage, 'boom');
});

test('POST /api/jobs/:name/run returns 409 while already running', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  registry.__resetForTest();
  registry.defineJob({
    name: 'api_test_job',
    cronDefault: '*/15 * * * *',
    enabledDefault: true,
    handler: async () => {
      await gate;
      return {};
    },
  });
  const first = authedRequest('POST', '/api/jobs/api_test_job/run', 'owner');
  await new Promise((r) => setImmediate(r));

  const second = await authedRequest('POST', '/api/jobs/api_test_job/run', 'owner');

  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'JOB_ALREADY_RUNNING');
  release();
  assert.equal((await first).status, 200);
});

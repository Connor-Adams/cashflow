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
  isSuperadmin: boolean,
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
            'x-test-superadmin': isSuperadmin ? '1' : '0',
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
        globalRole: req.headers['x-test-superadmin'] === '1' ? 'superadmin' : 'user',
      },
      household: { id: 1 },
      role: 'owner',
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
});

test('GET /api/jobs requires superadmin', async () => {
  const r = await authedRequest('GET', '/api/jobs', false);
  assert.equal(r.status, 403);
});

test('GET /api/jobs returns the registered job', async () => {
  const r = await authedRequest('GET', '/api/jobs', true);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  const job = r.json.find((j: any) => j.name === 'api_test_job');
  assert.ok(job);
  assert.equal(job.cron, '*/15 * * * *');
  assert.equal(job.enabled, true);
  assert.equal(job.source.enabled, 'env');
});

test('PATCH /api/jobs/:name persists overrides; null resets', async () => {
  let r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    enabled: false,
    cron: '*/30 * * * *',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.cron, '*/30 * * * *');
  assert.equal(r.json.source.enabled, 'db');
  assert.equal(r.json.source.cron, 'db');

  r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    enabled: null,
    cron: null,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.source.enabled, 'env');
  assert.equal(r.json.source.cron, 'env');
});

test('PATCH rejects invalid cron with 400', async () => {
  const r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    cron: 'not-a-cron',
  });
  assert.equal(r.status, 400);
});

test('POST /api/jobs/:name/run triggers handler', async () => {
  const r = await authedRequest('POST', '/api/jobs/api_test_job/run', true);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('POST /api/jobs/:unknown/run returns 404', async () => {
  const r = await authedRequest('POST', '/api/jobs/nope/run', true);
  assert.equal(r.status, 404);
});

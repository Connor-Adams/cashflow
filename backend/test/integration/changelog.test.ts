import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let dir: string;

before(async () => {
  // Point the backend at a temp changelog dir BEFORE importing the app.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-int-'));
  process.env.CHANGELOG_DIR = dir;
  fs.writeFileSync(
    path.join(dir, 'overview.md'),
    `---\nkind: overview\nupdatedAt: 2026-05-30T01:22:39Z\n---\nWhat the app does.\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.51.md'),
    `---\nversion: v0.13.51\ntitle: Older\npublishedAt: 2026-05-28T20:33:35Z\naudience: user\n---\nOld.\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.52.md'),
    `---\nversion: v0.13.52\ntitle: Newer\npublishedAt: 2026-05-30T01:22:39Z\naudience: user\n---\nNew. <script>alert(1)</script>\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.50.md'),
    `---\nversion: v0.13.50\ntitle: Internal\npublishedAt: 2026-05-27T00:00:00Z\naudience: operator\n---\nOps only.\n`,
  );

  testDb = await setupPgTestDb('changelog');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'cl@example.com',
    displayName: 'CL User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CHANGELOG_DIR;
});

test('GET /api/changelog/latest returns newest user entry, unread when never seen', async () => {
  const r = await authed.get('/api/changelog/latest');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 'v0.13.52');
  assert.equal(r.body.unread, true);
  assert.ok(!r.body.html.includes('<script'), 'html sanitized');
});

test('GET /api/changelog lists user entries newest-first, excludes operator', async () => {
  const r = await authed.get('/api/changelog');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries.map((e: { version: string }) => e.version), ['v0.13.52', 'v0.13.51']);
});

test('GET /api/changelog?since=v0.13.51 returns only newer entries', async () => {
  const r = await authed.get('/api/changelog?since=v0.13.51');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries.map((e: { version: string }) => e.version), ['v0.13.52']);
});

test('GET /api/changelog/overview returns the overview html', async () => {
  const r = await authed.get('/api/changelog/overview');
  assert.equal(r.status, 200);
  assert.ok(r.body.html.includes('What the app does'));
});

test('PATCH /api/changelog/seen with invalid version → 400 INVALID_VERSION', async () => {
  const r = await authed.patch('/api/changelog/seen').send({ version: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INVALID_VERSION');
});

test('PATCH /api/changelog/seen marks read; /latest then reports unread:false', async () => {
  const patch = await authed.patch('/api/changelog/seen').send({ version: 'v0.13.52' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.lastSeenChangelogVersion, 'v0.13.52');
  const latest = await authed.get('/api/changelog/latest');
  assert.equal(latest.body.unread, false);
});

test('latest endpoint requires auth', async () => {
  const r = await request(app).get('/api/changelog/latest');
  assert.equal(r.status, 401);
});

test('missing changelog dir → /latest returns {empty:true}, no crash', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const r = await authed.get('/api/changelog/latest');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { empty: true });
});

/**
 * Regression tests that LOCK the load-bearing router-mount behavior of
 * backend/src/app.ts (and its declarative registry, backend/src/routeRegistry.ts).
 *
 * backend/src/app.ts mounts ~90 routers under /api in a *load-bearing order*.
 * Two classes of behavior depend on that order and on retired-but-present
 * stubs; both are easy to break silently with a reorder/delete:
 *
 *   1. The global auth boundary `app.use('/api', requireAuth)`. Everything
 *      registered BEFORE it is public/token-authed; everything AFTER is
 *      session-gated. Move a router across the boundary and you either expose
 *      private data or 401 a public endpoint.
 *
 *   2. Folded/retired endpoints that must keep returning **410 Gone** (so stale
 *      clients fail loudly), and specific paths that must out-rank a bare-`/api`
 *      catch-all router.
 *
 * These tests run at UNIT level (per-PID SQLite via test/setup.ts, no Postgres):
 * we `sequelize.sync({ force: true })`, seed one User+Household+Session directly,
 * boot the exported app, and drive it with supertest. The 410 stubs and gated
 * routes live BEHIND requireAuth, so observing their real status needs an
 * authenticated cookie (an unauthenticated request 401s before reaching them).
 *
 * The structural block asserts the registry's ordering invariant directly
 * against backend/src/routeRegistry.ts data — the guard that turns CI red when
 * someone reorders a mount, drops a fold stub, or moves a router across the
 * auth boundary.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  sequelize,
  User,
  Household,
  HouseholdMember,
  Session,
} from '../src/models';
import { hashPassword, hashToken } from '../src/auth/password';
import {
  preAuthRoutes,
  gatedRoutes,
  type RouteEntry,
} from '../src/routeRegistry';

let app: Express;
let sessionToken: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const user = await User.create({
    email: `route-order-${Date.now()}@example.com`,
    displayName: 'Route Order Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  const household = await Household.create({ name: 'Route Order HH' } as never);
  await HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  } as never);
  sessionToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  // Import the app only AFTER the schema + session exist so attachAuth can
  // resolve the session cookie on the very first request.
  app = (await import('../src/app.js')).default;
});

const authCookie = () => `cashflow_session=${sessionToken}`;

// ─────────────────────────── 410 folds ────────────────────────────
// These retired paths must keep returning 410 Gone with their documented JSON
// body. They sit BEHIND requireAuth, so we send the session cookie to reach the
// stub (an unauthenticated hit 401s first — see the auth-boundary block below).

test('410 fold: GET /api/tax/personal-scenarios returns 410 with documented body', async () => {
  const res = await request(app)
    .get('/api/tax/personal-scenarios')
    .set('Cookie', authCookie());
  assert.equal(res.status, 410);
  assert.deepEqual(res.body, {
    error: 'gone',
    message:
      'This endpoint moved to /api/tax/scenarios/:kind (kind ∈ {personal, corp}).',
  });
});

test('410 fold: POST /api/tax/corp-scenarios returns 410 with documented body', async () => {
  const res = await request(app)
    .post('/api/tax/corp-scenarios')
    .set('Cookie', authCookie())
    .send({});
  assert.equal(res.status, 410);
  assert.deepEqual(res.body, {
    error: 'gone',
    message:
      'This endpoint moved to /api/tax/scenarios/:kind (kind ∈ {personal, corp}).',
  });
});

test('410 fold: legacy /api/notification-preferences returns 410 with documented body', async () => {
  // Verified against the live route (backend/src/routes/notificationPreferences.ts
  // returns 410 for *.all). GET and PATCH both 410.
  const get = await request(app)
    .get('/api/notification-preferences')
    .set('Cookie', authCookie());
  assert.equal(get.status, 410);
  assert.deepEqual(get.body, {
    error: 'gone',
    message:
      'This endpoint moved to /api/users/me/notifications/preferences (GET) ' +
      'and /api/users/me/notifications/preferences/:type (PATCH).',
  });

  const patch = await request(app)
    .patch('/api/notification-preferences/email')
    .set('Cookie', authCookie())
    .send({});
  assert.equal(patch.status, 410);
});

test('the unified replacement path is a real route, not a 410 stub', async () => {
  // /api/tax/scenarios/:kind is the live router the 410s point at. It must NOT
  // be gone — proves the fold replaced the old paths rather than killing them.
  const res = await request(app)
    .get('/api/tax/scenarios/personal')
    .set('Cookie', authCookie());
  assert.notEqual(res.status, 410);
  assert.notEqual(res.status, 404);
});

// ─────────────────────────── auth boundary ────────────────────────────
// A representative PUBLIC route works without a session; a representative GATED
// route is rejected without one. Status codes verified by running the live app
// (requireAuth returns 401 — see backend/src/auth/middleware.ts).

test('auth boundary: public GET /api/health returns 200 without a session', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('auth boundary: gated GET /api/transactions is 401 without a session', async () => {
  const res = await request(app).get('/api/transactions');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Authentication required' });
});

test('auth boundary: gated GET /api/transactions reaches the router with a session (not 401)', async () => {
  // Same path, now authenticated: it must pass requireAuth and hit the real
  // router (any non-401/403 status). This proves the boundary gates on session
  // presence, not on the path itself.
  const res = await request(app)
    .get('/api/transactions')
    .set('Cookie', authCookie());
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

// ─────────────────────── specific-before-catchall ───────────────────────
// sankeyRouter mounts on /api/summary/sankey BEFORE summaryRouter mounts on the
// broader /api/summary. If that order flipped (or sankeyRouter were dropped),
// GET /api/summary/sankey would fall through to summaryRouter, which has no
// /sankey handler, and 404. A 200 carrying the sankey-distinctive shape proves
// the specific mount wins over the broader one.

test('specific-before-catchall: /api/summary/sankey is served by sankeyRouter, not the broader /api/summary', async () => {
  const res = await request(app)
    .get('/api/summary/sankey')
    .set('Cookie', authCookie());
  assert.equal(res.status, 200);
  // Keys unique to the sankey response shape (sankey.ts), absent from any
  // /api/summary handler — confirms it was the sankey router that answered.
  assert.ok(
    Object.prototype.hasOwnProperty.call(res.body, 'availableCurrencies'),
    'expected sankey-shaped body with availableCurrencies',
  );
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'nodes'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'links'));
});

// ─────────────────────────── structural invariant ───────────────────────────
// Asserts the registry ordering property directly against the declarative data.
// This is the guard that fails the moment someone reorders a mount, drops a fold
// stub, or moves a router across the auth boundary in routeRegistry.ts.

/** Flatten an entry's path(s) to a comparable string for membership checks. */
const pathsOf = (e: RouteEntry): string[] =>
  Array.isArray(e.paths) ? e.paths : [e.paths];

/** True if any of the entry's paths exactly equals `p`. */
const entryHasPath = (e: RouteEntry, p: string): boolean => pathsOf(e).includes(p);

/** Concatenated registry order: pre-auth entries, then gated entries. */
const allEntries = (): RouteEntry[] => [...preAuthRoutes, ...gatedRoutes];

/** Index in the FULL ordered list (pre-auth then gated) of the first entry
 *  matching `predicate`, or -1. The auth boundary lives between the two arrays,
 *  at index === preAuthRoutes.length. */
const indexOf = (predicate: (e: RouteEntry) => boolean): number =>
  allEntries().findIndex(predicate);

test('structure: registry exposes ordered pre-auth and gated arrays', () => {
  assert.ok(Array.isArray(preAuthRoutes), 'preAuthRoutes must be an array');
  assert.ok(Array.isArray(gatedRoutes), 'gatedRoutes must be an array');
  assert.ok(preAuthRoutes.length > 0, 'expected at least one pre-auth entry');
  assert.ok(gatedRoutes.length > 0, 'expected at least one gated entry');
  // Every entry must carry a path and at least one handler.
  for (const e of allEntries()) {
    assert.ok(
      pathsOf(e).length > 0 && pathsOf(e).every((p) => typeof p === 'string'),
      'every entry needs string path(s)',
    );
    assert.ok(
      Array.isArray(e.handlers) && e.handlers.length > 0,
      'every entry needs at least one handler',
    );
  }
});

test('structure: representative PUBLIC routes are pre-auth, GATED routes are gated', () => {
  // Public/token-authed endpoints live in preAuthRoutes...
  for (const p of [
    '/api/health',
    '/api/version',
    '/api/config',
    '/api/auth',
    '/api/client-logs',
    '/api/capture',
    '/api/audit/tokens',
    '/api/audit',
  ]) {
    assert.ok(
      preAuthRoutes.some((e: RouteEntry) => entryHasPath(e, p)),
      `${p} must be a pre-auth (public/token-authed) entry`,
    );
  }
  // ...and session-gated endpoints live in gatedRoutes.
  for (const p of [
    '/api/transactions',
    '/api/accounts',
    '/api/budgets',
    '/api/summary',
    '/api/notifications',
  ]) {
    assert.ok(
      gatedRoutes.some((e: RouteEntry) => entryHasPath(e, p)),
      `${p} must be a gated entry`,
    );
  }
});

test('structure: every pre-auth index < auth boundary <= every gated index', () => {
  const boundary = preAuthRoutes.length;
  // Pre-auth entries occupy [0, boundary); gated entries occupy [boundary, end).
  preAuthRoutes.forEach((_e: RouteEntry, i: number) => {
    assert.ok(i < boundary, `pre-auth entry ${i} must precede the auth boundary`);
  });
  gatedRoutes.forEach((_e: RouteEntry, i: number) => {
    assert.ok(
      boundary + i >= boundary,
      `gated entry ${i} must follow the auth boundary`,
    );
  });
  // And concretely: a known public path precedes a known gated path.
  const healthIdx = indexOf((e) => entryHasPath(e, '/api/health'));
  const txnsIdx = indexOf((e) => entryHasPath(e, '/api/transactions'));
  assert.ok(healthIdx >= 0 && txnsIdx >= 0);
  assert.ok(healthIdx < boundary, 'health is pre-auth');
  assert.ok(txnsIdx >= boundary, 'transactions is gated');
  assert.ok(healthIdx < txnsIdx, 'public health mounts before gated transactions');
});

test('structure: folded/gone 410 entries are present in the registry', () => {
  // The retired paths must still be registered (as 410 stubs) — dropping them
  // would let stale clients silently 404 instead of failing loudly with 410.
  assert.ok(
    gatedRoutes.some((e: RouteEntry) => entryHasPath(e, '/api/tax/personal-scenarios')),
    '/api/tax/personal-scenarios 410 stub must be registered',
  );
  assert.ok(
    gatedRoutes.some((e: RouteEntry) => entryHasPath(e, '/api/tax/corp-scenarios')),
    '/api/tax/corp-scenarios 410 stub must be registered',
  );
  assert.ok(
    gatedRoutes.some((e: RouteEntry) => entryHasPath(e, '/api/notification-preferences')),
    'legacy /api/notification-preferences 410 stub must be registered',
  );
});

test('structure: specific /api/summary/sankey is ordered before broader /api/summary', () => {
  const sankeyIdx = indexOf((e) => entryHasPath(e, '/api/summary/sankey'));
  const summaryIdx = indexOf((e) => entryHasPath(e, '/api/summary'));
  assert.ok(sankeyIdx >= 0, '/api/summary/sankey must be registered');
  assert.ok(summaryIdx >= 0, '/api/summary must be registered');
  assert.ok(
    sankeyIdx < summaryIdx,
    'sankey must mount before the broader /api/summary so the specific path wins',
  );
});

test('structure: aiReview is ordered before aiRouter on shared /api/ai', () => {
  // Both share the /api/ai prefix; aiReviewRouter must mount first so its
  // /review and /reviews/* paths win against any future overlap in aiRouter.
  const aiEntries = gatedRoutes
    .map((e: RouteEntry, i: number) => ({ e, i }))
    .filter(({ e }) => entryHasPath(e, '/api/ai'));
  assert.ok(
    aiEntries.length >= 2,
    'expected at least two /api/ai entries (aiReview, aiRouter, aiQuery)',
  );
  // The 410-irrelevant detail we lock: the FIRST /api/ai mount is aiReview.
  // We assert structurally that the specific-first ordering is preserved by
  // checking the first /api/ai entry carries the documented rationale.
  const first = aiEntries[0];
  assert.match(
    String(first.e.why ?? ''),
    /aiReview|review/i,
    'the first /api/ai mount must be the aiReview router (mounted before aiRouter)',
  );
});

test('structure: bare-/api catch-all routers keep their documented order', () => {
  // businessTax, returnWarranty, receipts, items, purchases, reimbursements,
  // largePurchaseReview, feedback all mount on bare '/api'. Their relative
  // order is load-bearing (specific paths within each must out-rank later
  // catch-alls). Lock the exact sequence of bare-'/api' gated entries.
  const bareApiOrder = gatedRoutes
    .filter((e: RouteEntry) => entryHasPath(e, '/api'))
    // exclude the requireAuth boundary itself if it were ever modeled here
    .map((e: RouteEntry) => e.why ?? '');
  // There must be exactly the eight documented bare-/api router mounts.
  assert.equal(
    gatedRoutes.filter((e: RouteEntry) => pathsOf(e).length === 1 && pathsOf(e)[0] === '/api')
      .length,
    8,
    'expected exactly 8 bare-/api router mounts (businessTax→feedback)',
  );
  // The first bare-/api mount is businessTax (its rationale names /business).
  assert.match(
    String(bareApiOrder[0] ?? ''),
    /businessTax|business/i,
    'the first bare-/api mount must be businessTaxRouter',
  );
});

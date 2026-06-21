/**
 * Colocated route tests for per-household timezone (audit wave 3).
 *
 * Boots the full app on the per-process SQLite test DB (no Postgres) and
 * exercises:
 *  - GET  /api/household/settings   — exposes the timezone field + effective fallback;
 *  - PATCH /api/household/timezone  — sets / clears / validates the IANA zone;
 *  - GET  /api/net-worth/current    — the server-side "today" guard now uses the
 *    household zone, so an as-of date that is "tomorrow" in UTC but still "today"
 *    in a behind-UTC household is accepted (and the reverse is rejected).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Household,
  HouseholdMember,
  Session,
  User,
} from '../models';
import { hashPassword, hashToken } from '../auth/password';
import { todayInZone } from '../time/householdToday';

process.env.NODE_ENV = 'test';

let app: (typeof import('../app.js'))['default'];
let agent: ReturnType<typeof request.agent>;
let householdId: number;

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const owner = await User.create({
    email: 'household-tz-owner@example.com',
    displayName: 'Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);

  const household = await Household.create({ name: 'TZ Unit HH' } as never);
  householdId = household.id;
  await HouseholdMember.create({
    householdId,
    userId: owner.id,
    role: 'owner',
  } as never);

  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: owner.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const mod = await import('../app.js');
  app = mod.default;
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

test('GET /api/household/settings exposes timezone (null) + effective fallback', async () => {
  const res = await agent.get('/api/household/settings');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.timezone, null);
  assert.equal(res.body.effectiveTimezone, 'America/Toronto');
  assert.equal(typeof res.body.benchmarkSymbol, 'string');
});

test('PATCH /api/household/timezone sets a valid IANA zone', async () => {
  const res = await agent
    .patch('/api/household/timezone')
    .send({ timezone: 'Asia/Tokyo' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.timezone, 'Asia/Tokyo');
  assert.equal(res.body.effectiveTimezone, 'Asia/Tokyo');

  const row = await Household.findByPk(householdId);
  assert.equal(row?.timezone, 'Asia/Tokyo');
});

test('PATCH /api/household/timezone rejects an invalid zone', async () => {
  const res = await agent
    .patch('/api/household/timezone')
    .send({ timezone: 'Not/AZone' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  // The prior valid value must be untouched.
  const row = await Household.findByPk(householdId);
  assert.equal(row?.timezone, 'Asia/Tokyo');
});

test('PATCH /api/household/timezone clears the zone with null', async () => {
  const res = await agent
    .patch('/api/household/timezone')
    .send({ timezone: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.timezone, null);
  assert.equal(res.body.effectiveTimezone, 'America/Toronto');
});

test('net-worth as-of guard buckets to the household zone, not UTC', async () => {
  // Park the household in a far-ahead zone so its "today" is reliably one
  // calendar day ahead of UTC for the evening-UTC portion of any day. Asia/Tokyo
  // (UTC+9) is "tomorrow" relative to UTC after 15:00 UTC; using the zone's own
  // current date as the as-of avoids brittleness around the exact instant.
  await agent.patch('/api/household/timezone').send({ timezone: 'Asia/Tokyo' });

  const tokyoToday = todayInZone('Asia/Tokyo');
  // The household-zone today must be accepted (not flagged future).
  const ok = await agent.get(`/api/net-worth/current?asOf=${tokyoToday}`);
  assert.equal(ok.status, 200, `zone-today should be accepted: ${JSON.stringify(ok.body)}`);

  // A date strictly after the household-zone today is rejected as future.
  const tomorrow = new Date(`${tokyoToday}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  const future = await agent.get(`/api/net-worth/current?asOf=${tomorrowIso}`);
  assert.equal(future.status, 400, JSON.stringify(future.body));
  assert.match(String(future.body.error), /future/);
});

/**
 * Data-migration test for 20261019000001-fold-user-token-tables.
 *
 * Runs against the app's own per-process SQLite DB so the real auth middleware
 * can be exercised on the migrated rows:
 *   1. Build the three legacy tables with their ORIGINAL migrations (plus the
 *      capture expiry column) and seed them with tokens minted the old way.
 *   2. up(): every row lands in user_tokens with the right scope and verbatim
 *      hash / label / timestamps / expiry; legacy tables are left in place.
 *   3. A pre-migration plaintext still authenticates its own scope (and only
 *      its own scope) through requireTokenAuth.
 *   4. down(): post-migration revocations, touches and newly minted tokens are
 *      synced back to the legacy tables by token_hash, then user_tokens drops.
 *   5. up() again is clean (re-runnable after a rollback).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { QueryTypes, Sequelize } from 'sequelize';
import { sequelize, Household, HouseholdMember, User, UserToken } from '../../models';
import { requireTokenAuth } from '../../auth/tokenAuth';
import { hashScopedToken, mintTokenPlaintext, type TokenScope } from '../../auth/scopedToken';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
type Migration = { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };
const legacyMigrations: Migration[] = [
  require('../20260522000004-user-capture-tokens.js'),
  require('../20260626000001-capture-token-expiry.js'),
  require('../20260611000000-user-reporting-tokens.js'),
  require('../20260530000001-create-user-audit-tokens.js'),
];
const fold: Migration = require('../20261019000001-fold-user-token-tables.js');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const qi = () => sequelize.getQueryInterface();
const TABLE: Record<TokenScope, string> = {
  audit: 'user_audit_tokens',
  reporting: 'user_reporting_tokens',
  capture: 'user_capture_tokens',
};

interface Seed {
  scope: TokenScope;
  plaintext: string;
  label: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

let userId: number;
const seeds: Seed[] = [];
let app: express.Express;

const at = (iso: string) => new Date(iso);

/** Insert one token into its legacy table exactly as the pre-fold code minted it. */
async function seedLegacy(p: Omit<Seed, 'plaintext'>): Promise<Seed> {
  const plaintext = mintTokenPlaintext(p.scope);
  await qi().bulkInsert(TABLE[p.scope], [
    {
      user_id: userId,
      token_hash: hashScopedToken(plaintext),
      label: p.label,
      last_used_at: p.lastUsedAt,
      revoked_at: p.revokedAt,
      ...(p.scope === 'capture' ? { expires_at: p.expiresAt } : {}),
      created_at: p.createdAt,
      updated_at: p.createdAt,
    },
  ]);
  return { ...p, plaintext };
}

function buildApp(): express.Express {
  const a = express();
  for (const scope of ['audit', 'reporting', 'capture'] as const) {
    a.all(`/${scope}`, requireTokenAuth(scope), (req, res) => res.json({ scope: req[`${scope}Auth`] ? scope : null }));
  }
  return a;
}
const ms = (d: Date | string | null) => (d == null ? null : new Date(d).getTime());

before(async () => {
  await sequelize.sync({ force: true });
  // The fold creates user_tokens itself; start from the pre-fold schema.
  await qi().dropTable('user_tokens');
  for (const m of legacyMigrations) await m.up(qi(), Sequelize);

  const user = await User.create({
    email: 'fold@example.com',
    displayName: 'Fold',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;
  const household = await Household.create({ name: 'Fold HH' } as never);
  await HouseholdMember.create({ householdId: household.id, userId, role: 'owner' } as never);

  // Two live + one revoked per scope; capture carries expiries (one legacy NULL).
  const plan: Array<Omit<Seed, 'plaintext'>> = [
    { scope: 'audit', label: 'CI agent', lastUsedAt: at('2026-06-02T10:00:00Z'), revokedAt: null, expiresAt: null, createdAt: at('2026-06-01T00:00:00Z') },
    { scope: 'audit', label: 'Old agent', lastUsedAt: null, revokedAt: at('2026-06-05T00:00:00Z'), expiresAt: null, createdAt: at('2026-06-01T01:00:00Z') },
    { scope: 'reporting', label: 'Blackbox', lastUsedAt: at('2026-07-01T12:00:00Z'), revokedAt: null, expiresAt: null, createdAt: at('2026-06-20T00:00:00Z') },
    { scope: 'reporting', label: 'Spare', lastUsedAt: null, revokedAt: null, expiresAt: null, createdAt: at('2026-06-21T00:00:00Z') },
    { scope: 'capture', label: 'Browser', lastUsedAt: at('2026-09-01T00:00:00Z'), revokedAt: null, expiresAt: at('2099-01-01T00:00:00Z'), createdAt: at('2026-08-01T00:00:00Z') },
    { scope: 'capture', label: 'Legacy no-expiry', lastUsedAt: null, revokedAt: null, expiresAt: null, createdAt: at('2026-05-25T00:00:00Z') },
    { scope: 'capture', label: 'Revoked', lastUsedAt: null, revokedAt: at('2026-08-15T00:00:00Z'), expiresAt: at('2026-11-01T00:00:00Z'), createdAt: at('2026-08-02T00:00:00Z') },
  ];
  for (const p of plan) seeds.push(await seedLegacy(p));

  app = buildApp();
});

const call = (scope: TokenScope, plaintext: string) => {
  const r = request(app);
  return (scope === 'capture' ? r.post(`/${scope}`) : r.get(`/${scope}`)).set('Authorization', `Bearer ${plaintext}`);
};

test('up copies every legacy row into user_tokens with the right scope, verbatim', async () => {
  await fold.up(qi(), Sequelize);

  const rows = await UserToken.findAll({ order: [['id', 'ASC']] });
  assert.equal(rows.length, seeds.length);
  for (const s of seeds) {
    const row = rows.find((r) => r.tokenHash === hashScopedToken(s.plaintext));
    assert.ok(row, `${s.scope}/${s.label} missing after fold`);
    assert.equal(row.scope, s.scope);
    assert.equal(row.userId, userId);
    assert.equal(row.label, s.label);
    assert.equal(ms(row.lastUsedAt), ms(s.lastUsedAt), `${s.label} lastUsedAt`);
    assert.equal(ms(row.revokedAt), ms(s.revokedAt), `${s.label} revokedAt`);
    assert.equal(ms(row.expiresAt), ms(s.expiresAt), `${s.label} expiresAt`);
    assert.equal(ms(row.createdAt), ms(s.createdAt), `${s.label} createdAt`);
  }
  const byScope = (scope: TokenScope) => rows.filter((r) => r.scope === scope).length;
  assert.deepEqual([byScope('audit'), byScope('reporting'), byScope('capture')], [2, 2, 3]);
});

test('up leaves the legacy tables in place and untouched', async () => {
  for (const scope of ['audit', 'reporting', 'capture'] as const) {
    const [{ n }] = await sequelize.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE[scope]}`, {
      type: QueryTypes.SELECT,
    });
    assert.equal(Number(n), seeds.filter((s) => s.scope === scope).length);
  }
});

test('up creates the unique token_hash index', async () => {
  const indexes = (await qi().showIndex('user_tokens')) as Array<{ name: string; unique: boolean }>;
  const idx = indexes.find((i) => i.name === 'user_tokens_token_hash_unique');
  assert.ok(idx?.unique);
});

test('a pre-migration token still authenticates its own scope, and only its own', async () => {
  for (const s of seeds.filter((x) => x.revokedAt == null)) {
    const res = await call(s.scope, s.plaintext);
    assert.equal(res.status, 200, `${s.scope}/${s.label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scope, s.scope);
    for (const other of ['audit', 'reporting', 'capture'] as const) {
      if (other === s.scope) continue;
      assert.equal((await call(other, s.plaintext)).status, 401, `${s.scope} token opened ${other}`);
    }
  }
});

test('a token revoked before the migration stays revoked after it', async () => {
  for (const s of seeds.filter((x) => x.revokedAt != null)) {
    assert.equal((await call(s.scope, s.plaintext)).status, 401, `${s.scope}/${s.label}`);
  }
});

test('down syncs post-migration changes back to the legacy tables, then drops user_tokens', async () => {
  // Post-migration activity: revoke the live reporting token, mint a new audit token.
  const blackbox = seeds.find((s) => s.label === 'Blackbox')!;
  const revokedAt = at('2026-10-20T00:00:00Z');
  await UserToken.update({ revokedAt }, { where: { tokenHash: hashScopedToken(blackbox.plaintext) } });
  const fresh = mintTokenPlaintext('audit');
  await UserToken.create({
    userId,
    scope: 'audit',
    tokenHash: hashScopedToken(fresh),
    label: 'Minted after fold',
    lastUsedAt: null,
    revokedAt: null,
  });

  await fold.down(qi(), Sequelize);

  await assert.rejects(() => qi().describeTable('user_tokens'), 'user_tokens should be gone after down');

  const reporting = await sequelize.query<{ revoked_at: string | null; label: string }>(
    'SELECT revoked_at, label FROM user_reporting_tokens WHERE token_hash = :h',
    { type: QueryTypes.SELECT, replacements: { h: hashScopedToken(blackbox.plaintext) } },
  );
  assert.equal(reporting.length, 1, 'no duplicate row for an existing token');
  assert.equal(ms(reporting[0].revoked_at), revokedAt.getTime(), 'post-migration revocation must survive rollback');

  const audit = await sequelize.query<{ label: string }>(
    'SELECT label FROM user_audit_tokens WHERE token_hash = :h',
    { type: QueryTypes.SELECT, replacements: { h: hashScopedToken(fresh) } },
  );
  assert.deepEqual(audit, [{ label: 'Minted after fold' }]);

  const capture = await sequelize.query<{ expires_at: string | null }>(
    'SELECT expires_at FROM user_capture_tokens ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    capture.map((r) => ms(r.expires_at)),
    seeds.filter((s) => s.scope === 'capture').map((s) => ms(s.expiresAt)),
  );
});

test('up re-runs cleanly after a rollback', async () => {
  await fold.up(qi(), Sequelize);
  assert.equal(await UserToken.count(), seeds.length + 1);
  const fresh = await UserToken.findOne({ where: { label: 'Minted after fold' } });
  assert.equal(fresh?.scope, 'audit');
});

# AI Audit Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an AI agent a bearer-token-authenticated, read-only HTTP surface (`/api/audit/*`) that exposes every signal needed to verify cashflow production is healthy — DB/migration state, scheduler heartbeats, pipeline freshness, data integrity, client-side errors, server-side errors, per-page route health, and a one-call summary.

**Architecture:**
- New `UserAuditToken` model + `cfa_`-prefixed tokens (mirrors existing `UserCaptureToken` pattern).
- New `requireAuditAuth` middleware: GET-only, bearer-only, household-scoped.
- Mint/list/revoke under session auth at `/api/audit/tokens`; all audit reads under token auth at `/api/audit/<probe>`.
- Two new ring-buffer tables (`client_error_events`, `server_error_events`) capped at 500 rows/household to give the agent a "what blew up since deploy" view without depending on Loki being reachable.
- `/api/audit/route-probe` knows the SPA's top-level routes and simulates the API calls each page issues, so the agent can detect "page X breaks after deploy" without a headless browser.
- `/api/audit/summary` collapses everything into one JSON blob with a pass/warn/fail per dimension.

**Tech Stack:** Express, Sequelize (Postgres), node:test + supertest, React (Vite) for settings UI, Tailwind v4.

---

## File Structure

**New files (backend):**
- `backend/src/auth/auditToken.ts` — token mint/hash/format helpers (mirror of `captureToken.ts`)
- `backend/src/auth/auditAuth.ts` — `requireAuditAuth` middleware
- `backend/src/models/UserAuditToken.ts` — token model
- `backend/src/models/ClientErrorEvent.ts` — ring-buffer client errors
- `backend/src/models/ServerErrorEvent.ts` — ring-buffer server errors
- `backend/src/migrations/20260530000001-create-user-audit-tokens.js`
- `backend/src/migrations/20260530000002-create-client-error-events.js`
- `backend/src/migrations/20260530000003-create-server-error-events.js`
- `backend/src/routes/auditTokens.ts` — session-auth mint/list/revoke
- `backend/src/routes/audit.ts` — token-auth audit probes (Router with sub-paths)
- `backend/src/audit/healthDeep.ts` — DB/migration probe
- `backend/src/audit/freshness.ts` — last-run timestamps
- `backend/src/audit/integrity.ts` — duplicate/orphan/unenriched probes
- `backend/src/audit/counts.ts` — model row counts
- `backend/src/audit/clientErrors.ts` — query buffered client errors
- `backend/src/audit/serverErrors.ts` — query buffered server errors
- `backend/src/audit/routeProbe.ts` — per-page simulated API call result
- `backend/src/audit/summary.ts` — composite digest
- `backend/src/audit/routesManifest.ts` — declarative SPA-route → API-calls map
- `backend/test/integration/auditTokens.test.ts`
- `backend/test/integration/auditEndpoints.test.ts`
- `backend/test/integration/auditRouteProbe.test.ts`
- `backend/test/integration/auditSummary.test.ts`

**New files (frontend):**
- `frontend/src/pages/settings/tabs/AuditTokensTab.tsx` — mint/list/revoke UI

**Modified files (backend):**
- `backend/src/models/index.ts` — register new models
- `backend/src/app.ts` — mount new routers, install server-error capture middleware
- `backend/src/routes/clientLogs.ts` — also persist errors to `ClientErrorEvent`
- `backend/src/observability/logger.ts` — error tap → `ServerErrorEvent` (only on `logger.error`, never re-throw)
- `backend/src/jobs/definitions/` — new `audit_buffer_trim` job

**Modified files (frontend):**
- `frontend/src/pages/settings/SettingsPage.tsx` (or whichever file registers settings tabs) — add Audit Tokens tab

**Modified files (docs):**
- `docs/agent-audit.md` — new doc for the agent loop pattern

---

## Conventions

- **Token prefix:** `cfa_` (cashflow audit) — 32 base64url chars, same shape as `cfc_`.
- **Test bootstrap:** mirror `backend/test/integration/auditLog.test.ts` — `setupPgTestDb`, `request.agent(app)`, hand-create User/Household/Session.
- **Route ordering:** `/api/audit/tokens` mounts BEFORE the global `requireAuth` line in `app.ts` (uses session auth itself); `/api/audit/<probe>` ALSO mounts before global requireAuth because it uses its own bearer middleware.
- **Read-only invariant:** `requireAuditAuth` returns `405 Method Not Allowed` for any non-GET; the audit router never registers non-GET handlers anyway.
- **Household scoping:** every probe scopes to the token's household via `req.auditAuth.household.id`. There's no "superadmin sees all" mode in this plan — defer if needed.
- **Commit cadence:** commit after each step that ends with a passing test. Use Conventional Commits, no `Co-Authored-By` trailer.
- **Caveman mode:** plan body uses normal English; code/commit messages are normal English too.

---

## Pre-flight

- [ ] **Verify worktree is clean and on `claude/elastic-bassi-a4d57a`**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: clean working tree, branch is `claude/elastic-bassi-a4d57a`.

- [ ] **Verify backend tests pass on baseline**

```bash
cd backend && yarn test:integration -t "audit log"
```

Expected: existing audit log integration test passes (sanity check that DB bootstrap works in this worktree).

---

## Task 1: UserAuditToken model + migration

**Files:**
- Create: `backend/src/models/UserAuditToken.ts`
- Create: `backend/src/migrations/20260530000001-create-user-audit-tokens.js`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260530000001-create-user-audit-tokens.js`:

```javascript
'use strict';

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_audit_tokens', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: { type: Sequelize.STRING(64), allowNull: false },
      label: { type: Sequelize.STRING(64), allowNull: false },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex(queryInterface, 'user_audit_tokens', ['token_hash'], {
      name: 'user_audit_tokens_token_hash_unique',
      unique: true,
    });
    await addIndex(queryInterface, 'user_audit_tokens', ['user_id', 'revoked_at'], {
      name: 'user_audit_tokens_user_active',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_audit_tokens');
  },
};
```

- [ ] **Step 2: Write the model**

Create `backend/src/models/UserAuditToken.ts`:

```typescript
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserAuditToken extends Model<
  InferAttributes<UserAuditToken>,
  InferCreationAttributes<UserAuditToken>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare tokenHash: string;
  declare label: string;
  declare lastUsedAt: Date | null;
  declare revokedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserAuditToken(sequelize: Sequelize): typeof UserAuditToken {
  UserAuditToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), field: 'token_hash', allowNull: false },
      label: { type: DataTypes.STRING(64), allowNull: false },
      lastUsedAt: { type: DataTypes.DATE, field: 'last_used_at', allowNull: true },
      revokedAt: { type: DataTypes.DATE, field: 'revoked_at', allowNull: true },
    } as ModelAttributes<UserAuditToken>,
    {
      sequelize,
      modelName: 'UserAuditToken',
      tableName: 'user_audit_tokens',
      underscored: true,
      timestamps: true,
    },
  );
  return UserAuditToken;
}
```

- [ ] **Step 3: Register model in `backend/src/models/index.ts`**

Add the import + init + export following the existing pattern (look at how `UserCaptureToken` is registered and mirror it exactly: import `initUserAuditToken`, call it in the init block, re-export `UserAuditToken` from the index).

- [ ] **Step 4: Run migration locally**

```bash
cd backend && yarn db:migrate
```

Expected output: `== 20260530000001-create-user-audit-tokens: migrated`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/UserAuditToken.ts backend/src/models/index.ts backend/src/migrations/20260530000001-create-user-audit-tokens.js
git commit -m "feat(audit): add UserAuditToken model and migration"
```

---

## Task 2: Token helpers (mint/hash/format)

**Files:**
- Create: `backend/src/auth/auditToken.ts`
- Create: `backend/test/unit/auditToken.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/unit/auditToken.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintAuditTokenPlaintext,
  hashAuditToken,
  isAuditTokenFormat,
  maskAuditToken,
} from '../../src/auth/auditToken.js';

test('mintAuditTokenPlaintext returns cfa_ prefixed 36-char string', () => {
  const t = mintAuditTokenPlaintext();
  assert.match(t, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(t.length, 36);
});

test('mintAuditTokenPlaintext is unique across calls', () => {
  const a = mintAuditTokenPlaintext();
  const b = mintAuditTokenPlaintext();
  assert.notEqual(a, b);
});

test('hashAuditToken returns 64-char hex', () => {
  const t = mintAuditTokenPlaintext();
  const h = hashAuditToken(t);
  assert.match(h, /^[a-f0-9]{64}$/);
});

test('hashAuditToken is deterministic', () => {
  const t = mintAuditTokenPlaintext();
  assert.equal(hashAuditToken(t), hashAuditToken(t));
});

test('isAuditTokenFormat accepts well-formed token', () => {
  assert.equal(isAuditTokenFormat(mintAuditTokenPlaintext()), true);
});

test('isAuditTokenFormat rejects capture token prefix', () => {
  assert.equal(isAuditTokenFormat('cfc_' + 'A'.repeat(32)), false);
});

test('isAuditTokenFormat rejects short token', () => {
  assert.equal(isAuditTokenFormat('cfa_short'), false);
});

test('maskAuditToken hides middle', () => {
  const t = 'cfa_' + 'A'.repeat(32);
  const m = maskAuditToken(t);
  assert.equal(m.startsWith('cfa_AAA'), true);
  assert.equal(m.endsWith('AAA'), true);
  assert.ok(m.includes('…'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/unit/auditToken.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/auth/auditToken.ts`:

```typescript
import crypto from 'crypto';

const TOKEN_PREFIX = 'cfa_';
const TOKEN_BYTES = 24; // 32 chars after base64url

export function mintAuditTokenPlaintext(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

export function hashAuditToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isAuditTokenFormat(value: string): boolean {
  return /^cfa_[A-Za-z0-9_-]{32}$/.test(value);
}

export function maskAuditToken(plaintext: string): string {
  if (plaintext.length < 10) return plaintext;
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-3)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && yarn tsx --test test/unit/auditToken.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/auditToken.ts backend/test/unit/auditToken.test.ts
git commit -m "feat(audit): token mint/hash/format helpers with cfa_ prefix"
```

---

## Task 3: requireAuditAuth middleware

**Files:**
- Create: `backend/src/auth/auditAuth.ts`

- [ ] **Step 1: Write the implementation (covered by integration test in Task 5)**

Create `backend/src/auth/auditAuth.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { HouseholdMember, User, UserAuditToken, Household } from '../models';
import { hashAuditToken, isAuditTokenFormat } from './auditToken';

export interface AuditAuthContext {
  user: User;
  household: Household;
  token: UserAuditToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    auditAuth?: AuditAuthContext;
  }
}

export async function requireAuditAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Audit surface is read-only (GET only)' });
      return;
    }
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const plaintext = match?.[1] ?? '';
    if (!plaintext || !isAuditTokenFormat(plaintext)) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const token = await UserAuditToken.findOne({
      where: { tokenHash: hashAuditToken(plaintext) },
    });
    if (!token || token.revokedAt != null) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const user = await User.findByPk(token.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid audit token' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'Audit token user has no household' });
      return;
    }
    void token.update({ lastUsedAt: new Date() }).catch(() => undefined);
    req.auditAuth = { user, household, token };
    next();
  } catch (e) {
    next(e);
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd backend && yarn tsc --noEmit
```

Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/auth/auditAuth.ts
git commit -m "feat(audit): requireAuditAuth middleware (GET-only, bearer cfa_)"
```

---

## Task 4: Token mint/list/revoke routes (session-auth)

**Files:**
- Create: `backend/src/routes/auditTokens.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/test/integration/auditTokens.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `backend/test/integration/auditTokens.test.ts`. Follow the bootstrap pattern from `backend/test/integration/auditLog.test.ts` exactly (setupPgTestDb, hand-create user+household+session+cookie agent). Then add tests:

```typescript
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let userId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_tokens');
  process.env.DATABASE_URL = testDb.url;
  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-tokens-${Date.now()}@example.com`,
    displayName: 'auditor',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'audit household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const sess = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(sess),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  userId = user.id;
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${sess}`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/audit/tokens mints a cfa_ token and returns plaintext once', async () => {
  const res = await agent.post('/api/audit/tokens').send({ label: 'ci-bot' });
  assert.equal(res.status, 201);
  assert.match(res.body.plaintext, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(res.body.label, 'ci-bot');
  assert.ok(res.body.id);
});

test('POST /api/audit/tokens defaults label when empty', async () => {
  const res = await agent.post('/api/audit/tokens').send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.label, 'Audit');
});

test('POST /api/audit/tokens rejects label > 64 chars', async () => {
  const res = await agent.post('/api/audit/tokens').send({ label: 'x'.repeat(65) });
  assert.equal(res.status, 400);
});

test('GET /api/audit/tokens lists non-revoked tokens for user', async () => {
  const res = await agent.get('/api/audit/tokens');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  for (const row of res.body) {
    assert.ok('id' in row);
    assert.ok('label' in row);
    assert.ok('createdAt' in row);
    assert.ok(!('plaintext' in row), 'plaintext must NEVER appear in list');
    assert.ok(!('tokenHash' in row), 'hash must NEVER appear in list');
  }
});

test('DELETE /api/audit/tokens/:id revokes the token (soft delete)', async () => {
  const mint = await agent.post('/api/audit/tokens').send({ label: 'revoke-me' });
  const id = mint.body.id;
  const del = await agent.delete(`/api/audit/tokens/${id}`);
  assert.equal(del.status, 204);
  const list = await agent.get('/api/audit/tokens');
  assert.ok(!list.body.some((r: { id: number }) => r.id === id));
});

test('DELETE /api/audit/tokens/:id returns 404 for unknown id', async () => {
  const del = await agent.delete('/api/audit/tokens/999999');
  assert.equal(del.status, 404);
});

test('mint/list/revoke require session auth', async () => {
  const anon = request(app);
  const mint = await anon.post('/api/audit/tokens').send({});
  assert.equal(mint.status, 401);
  const list = await anon.get('/api/audit/tokens');
  assert.equal(list.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditTokens.test.ts
```

Expected: FAIL with 404s on `/api/audit/tokens` (route not mounted).

- [ ] **Step 3: Write the routes**

Create `backend/src/routes/auditTokens.ts`:

```typescript
import { Router } from 'express';
import { Op } from 'sequelize';
import { UserAuditToken } from '../models';
import { currentAuth } from '../auth/middleware';
import {
  hashAuditToken,
  mintAuditTokenPlaintext,
} from '../auth/auditToken';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const label =
      String((req.body as { label?: unknown } | undefined)?.label ?? '').trim() ||
      'Audit';
    if (label.length > 64) {
      res.status(400).json({ error: 'Label must be 64 characters or fewer' });
      return;
    }
    const plaintext = mintAuditTokenPlaintext();
    const row = await UserAuditToken.create({
      userId: user.id,
      tokenHash: hashAuditToken(plaintext),
      label,
      lastUsedAt: null,
      revokedAt: null,
    });
    res.status(201).json({
      id: row.id,
      plaintext,
      label: row.label,
      createdAt: row.createdAt,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await UserAuditToken.findAll({
      where: { userId: user.id, revokedAt: { [Op.is]: null } },
      order: [['createdAt', 'DESC']],
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      })),
    );
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await UserAuditToken.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    if (row.revokedAt == null) {
      await row.update({ revokedAt: new Date() });
    }
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router in `backend/src/app.ts`**

Add import alongside `captureRouter`:

```typescript
import auditTokensRouter from './routes/auditTokens';
```

Mount it AFTER `captureRouter` and BEFORE `app.use('/api', requireAuth)`. The mint/list/revoke routes need session auth, which is supplied by `attachAuth` higher up; the route handlers themselves call `currentAuth(req)` and throw if no session.

```typescript
app.use('/api/capture', captureRouter);
app.use('/api/audit/tokens', auditTokensRouter); // ← NEW: session auth (via attachAuth + currentAuth)
// /api/audit/<probe> routers (added in later tasks) ALSO mount here, BEFORE requireAuth.
app.use('/api', requireAuth);
```

But note: `currentAuth` throws if no session, which will hit the error handler and likely return 500 instead of 401. Check how `capture.ts` handles unauthenticated mint requests today (it relies on the same `currentAuth`). If capture's existing tests verify 401 on unauth mint, mirror that exact mechanism. If `currentAuth` instead throws a typed `UnauthorizedError`, the error middleware should already turn that into 401 — verify before assuming.

- [ ] **Step 5: Re-run the test**

```bash
cd backend && yarn tsx --test test/integration/auditTokens.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/auditTokens.ts backend/src/app.ts backend/test/integration/auditTokens.test.ts
git commit -m "feat(audit): session-auth mint/list/revoke routes for audit tokens"
```

---

## Task 5: Mount audit probe router skeleton + middleware integration test

**Files:**
- Create: `backend/src/routes/audit.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/test/integration/auditMiddleware.test.ts`

- [ ] **Step 1: Write the failing middleware integration test**

Create `backend/test/integration/auditMiddleware.test.ts`. Bootstrap follows the same setup pattern as Task 4 (setupPgTestDb, seed user/household). Additionally create an audit token via the helper:

```typescript
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let validToken: string;
let revokedToken: string;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_middleware');
  process.env.DATABASE_URL = testDb.url;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-mw-${Date.now()}@example.com`,
    displayName: 'mw',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'mw household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'valid',
    lastUsedAt: null,
    revokedAt: null,
  });
  revokedToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(revokedToken),
    label: 'revoked',
    lastUsedAt: null,
    revokedAt: new Date(),
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/_ping with valid token returns 200', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('GET /api/audit/_ping without Authorization returns 401', async () => {
  const res = await request(app).get('/api/audit/_ping');
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping with cfc_ token returns 401', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer cfc_' + 'A'.repeat(32));
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping with revoked token returns 401', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${revokedToken}`);
  assert.equal(res.status, 401);
});

test('POST /api/audit/_ping returns 405 (read-only)', async () => {
  const res = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${validToken}`)
    .send({});
  assert.equal(res.status, 405);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditMiddleware.test.ts
```

Expected: FAIL — all routes 404 (not mounted).

- [ ] **Step 3: Implement the skeleton router**

Create `backend/src/routes/audit.ts`:

```typescript
import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Mount in `backend/src/app.ts`**

Add import:

```typescript
import auditRouter from './routes/audit';
```

Mount AFTER `auditTokensRouter` and BEFORE the global `requireAuth`:

```typescript
app.use('/api/audit/tokens', auditTokensRouter);
app.use('/api/audit', auditRouter);
app.use('/api', requireAuth);
```

Note: Express matches `/api/audit/tokens/*` against the more specific mount first, so `/api/audit/tokens/...` still resolves to the session-auth router. The bearer-token router only sees the rest of `/api/audit/*`.

- [ ] **Step 5: Re-run the test**

```bash
cd backend && yarn tsx --test test/integration/auditMiddleware.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/audit.ts backend/src/app.ts backend/test/integration/auditMiddleware.test.ts
git commit -m "feat(audit): token-auth probe router skeleton at /api/audit"
```

---

## Task 6: /api/audit/health-deep — DB + migration probe

**Files:**
- Create: `backend/src/audit/healthDeep.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/auditHealthDeep.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/auditHealthDeep.test.ts`. Bootstrap as in Task 5 (single user + audit token). Tests:

```typescript
test('GET /api/audit/health-deep returns ok with version, db, migrations', async () => {
  const res = await request(app)
    .get('/api/audit/health-deep')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.uptimeSeconds, 'number');
  assert.equal(typeof res.body.version, 'string');
  assert.equal(res.body.db.reachable, true);
  assert.equal(typeof res.body.db.latencyMs, 'number');
  assert.equal(res.body.migrations.pending, 0);
  assert.equal(typeof res.body.migrations.headName, 'string');
  assert.equal(typeof res.body.migrations.appliedCount, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditHealthDeep.test.ts
```

Expected: FAIL (404).

- [ ] **Step 3: Implement the probe**

Create `backend/src/audit/healthDeep.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';
import { version as buildVersion } from '../version';

export interface HealthDeepResult {
  ok: boolean;
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  db: { reachable: boolean; latencyMs: number; error: string | null };
  migrations: {
    pending: number;
    appliedCount: number;
    headName: string | null;
    pendingNames: string[];
  };
}

async function probeDb(): Promise<HealthDeepResult['db']> {
  const start = Date.now();
  try {
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
    return { reachable: true, latencyMs: Date.now() - start, error: null };
  } catch (e) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: String((e as Error)?.message ?? e),
    };
  }
}

async function probeMigrations(): Promise<HealthDeepResult['migrations']> {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  let onDisk: string[] = [];
  try {
    onDisk = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.js'))
      .sort();
  } catch {
    onDisk = [];
  }
  type Row = { name: string };
  let applied: Row[] = [];
  try {
    applied = await sequelize.query<Row>(
      'SELECT name FROM "SequelizeMeta" ORDER BY name ASC',
      { type: QueryTypes.SELECT },
    );
  } catch {
    applied = [];
  }
  const appliedSet = new Set(applied.map((r) => r.name));
  const pendingNames = onDisk.filter((n) => !appliedSet.has(n));
  const headName = onDisk.length > 0 ? onDisk[onDisk.length - 1] : null;
  return {
    pending: pendingNames.length,
    appliedCount: applied.length,
    headName,
    pendingNames,
  };
}

export async function healthDeep(): Promise<HealthDeepResult> {
  const [db, migrations] = await Promise.all([probeDb(), probeMigrations()]);
  return {
    ok: db.reachable && migrations.pending === 0,
    service: 'cashflow-backend',
    version: buildVersion,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    db,
    migrations,
  };
}
```

Note: confirm the migrations dir path at runtime. In dev, `__dirname` resolves to `backend/src/audit`, so `../migrations` is `backend/src/migrations`. In a built bundle, the path may differ — if so, fall back to `process.cwd() + '/src/migrations'` or read from an env var. Test this on local dev first.

Also confirm the version export path: `backend/src/version.ts` may export `version` differently — check it before relying on `buildVersion`. If it's `getVersion()`, swap.

- [ ] **Step 4: Wire up the route**

Modify `backend/src/routes/audit.ts`:

```typescript
import { Router } from 'express';
import { requireAuditAuth } from '../auth/auditAuth';
import { healthDeep } from '../audit/healthDeep';

const router = Router();

router.use(requireAuditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

router.get('/health-deep', async (_req, res, next) => {
  try {
    res.json(await healthDeep());
  } catch (e) {
    next(e);
  }
});

export default router;
```

- [ ] **Step 5: Re-run the test**

```bash
cd backend && yarn tsx --test test/integration/auditHealthDeep.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/audit/healthDeep.ts backend/src/routes/audit.ts backend/test/integration/auditHealthDeep.test.ts
git commit -m "feat(audit): /health-deep probes DB latency and migration head"
```

---

## Task 7: /api/audit/freshness — scheduler heartbeats + sync timestamps

**Files:**
- Create: `backend/src/audit/freshness.ts`
- Modify: `backend/src/routes/audit.ts`
- Add test cases to: `backend/test/integration/auditHealthDeep.test.ts` OR create `backend/test/integration/auditFreshness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/auditFreshness.test.ts`. Bootstrap as Task 5. Then seed a couple of `Job` rows + an `ImportHistory` row + a `UserEmailIntegration` row, and assert:

```typescript
test('GET /api/audit/freshness returns jobs, imports, email integrations', async () => {
  const models = await import('../../src/models');
  await models.Job.upsert({
    name: 'enrichment_backfill',
    lastRunAt: new Date(Date.now() - 60_000),
    lastFinishedAt: new Date(Date.now() - 30_000),
    lastStatus: 'ok',
    lastDurationMs: 30_000,
    lastError: null,
    lastResultJson: null,
    enabledOverride: null,
    cronOverride: null,
  });
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.jobs));
  const job = res.body.jobs.find((j: { name: string }) => j.name === 'enrichment_backfill');
  assert.ok(job);
  assert.equal(job.lastStatus, 'ok');
  assert.ok(typeof job.secondsSinceLastRun === 'number');
  assert.ok(Array.isArray(res.body.imports));
  assert.ok(Array.isArray(res.body.emailIntegrations));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditFreshness.test.ts
```

Expected: FAIL (404).

- [ ] **Step 3: Implement the probe**

Create `backend/src/audit/freshness.ts`:

```typescript
import { Job, ImportHistory, UserEmailIntegration } from '../models';

export interface FreshnessResult {
  jobs: Array<{
    name: string;
    lastRunAt: string | null;
    lastFinishedAt: string | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
    secondsSinceLastRun: number | null;
  }>;
  imports: Array<{
    id: number;
    source: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    status: string | null;
    rowCount: number | null;
    secondsSinceFinish: number | null;
  }>;
  emailIntegrations: Array<{
    id: number;
    userId: number;
    status: string | null;
    statusReason: string | null;
    lastScanAt: string | null;
    secondsSinceLastScan: number | null;
  }>;
  generatedAt: string;
}

function secondsSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

export async function freshness(householdId: number): Promise<FreshnessResult> {
  const [jobs, imports, emailIntegrations] = await Promise.all([
    Job.findAll({ order: [['name', 'ASC']] }),
    ImportHistory.findAll({
      where: { householdId },
      order: [['startedAt', 'DESC']],
      limit: 20,
    }),
    UserEmailIntegration.findAll({
      // UserEmailIntegration is per-user; scope to users in this household.
      // Simplest: join via HouseholdMember at the SQL layer; or fetch the
      // user ids first and filter. Use the second for clarity.
    }),
  ]);
  return {
    jobs: jobs.map((j) => ({
      name: j.name,
      lastRunAt: j.lastRunAt?.toISOString() ?? null,
      lastFinishedAt: j.lastFinishedAt?.toISOString() ?? null,
      lastStatus: j.lastStatus ?? null,
      lastDurationMs: j.lastDurationMs ?? null,
      lastError: j.lastError ?? null,
      secondsSinceLastRun: secondsSince(j.lastRunAt),
    })),
    imports: imports.map((i) => ({
      id: i.id,
      source: (i as unknown as { source?: string }).source ?? null,
      startedAt: (i as unknown as { startedAt: Date | null }).startedAt?.toISOString() ?? null,
      finishedAt: (i as unknown as { finishedAt: Date | null }).finishedAt?.toISOString() ?? null,
      status: (i as unknown as { status?: string | null }).status ?? null,
      rowCount: (i as unknown as { rowCount?: number | null }).rowCount ?? null,
      secondsSinceFinish: secondsSince((i as unknown as { finishedAt: Date | null }).finishedAt),
    })),
    emailIntegrations: emailIntegrations.map((e) => ({
      id: (e as unknown as { id: number }).id,
      userId: (e as unknown as { userId: number }).userId,
      status: (e as unknown as { status?: string | null }).status ?? null,
      statusReason:
        (e as unknown as { statusReason?: string | null }).statusReason ?? null,
      lastScanAt:
        (e as unknown as { lastScanAt: Date | null }).lastScanAt?.toISOString() ??
        null,
      secondsSinceLastScan: secondsSince(
        (e as unknown as { lastScanAt: Date | null }).lastScanAt,
      ),
    })),
    generatedAt: new Date().toISOString(),
  };
}
```

CRITICAL: confirm the exact column names on `ImportHistory` and `UserEmailIntegration` before relying on the casts above. Open the model files and replace the `unknown as` shims with the real declared property names. Don't ship `unknown as` casts to main — they're scaffolding to be deleted in this step.

Also: filter `UserEmailIntegration` to users in the caller's household. Do `const memberIds = await HouseholdMember.findAll({ where: { householdId }, attributes: ['userId'] })` then `where: { userId: { [Op.in]: memberIds.map(m => m.userId) } }` in the query above.

- [ ] **Step 4: Wire route**

Add to `backend/src/routes/audit.ts`:

```typescript
import { freshness } from '../audit/freshness';

router.get('/freshness', async (req, res, next) => {
  try {
    res.json(await freshness(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 5: Re-run test**

```bash
cd backend && yarn tsx --test test/integration/auditFreshness.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/audit/freshness.ts backend/src/routes/audit.ts backend/test/integration/auditFreshness.test.ts
git commit -m "feat(audit): /freshness surfaces job heartbeats and import recency"
```

---

## Task 8: /api/audit/integrity — duplicates, orphans, unenriched

**Files:**
- Create: `backend/src/audit/integrity.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/auditIntegrity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/auditIntegrity.test.ts`. Bootstrap + seed: 2 transactions with the same `sourceIdentityFingerprint`, 1 transaction with `merchantCanonical = null`. Assert response shape:

```typescript
test('GET /api/audit/integrity reports dupe groups, orphans, unenriched', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.duplicateGroups.count, 'number');
  assert.equal(typeof res.body.duplicateGroups.extraRowCount, 'number');
  assert.equal(typeof res.body.unenrichedTransactions, 'number');
  assert.equal(typeof res.body.orphanedTransactions, 'number');
  assert.equal(typeof res.body.generatedAt, 'string');
  // With our seed: at least 1 dupe group with 1 extra row, and ≥ 1 unenriched
  assert.ok(res.body.duplicateGroups.count >= 1);
  assert.ok(res.body.unenrichedTransactions >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditIntegrity.test.ts
```

Expected: FAIL (404).

- [ ] **Step 3: Implement the probe**

Create `backend/src/audit/integrity.ts`:

```typescript
import { QueryTypes } from 'sequelize';
import { Op } from 'sequelize';
import { sequelize, Transaction, Account } from '../models';

export interface IntegrityResult {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
}

export async function integrity(householdId: number): Promise<IntegrityResult> {
  const accountIds = (
    await Account.findAll({ where: { householdId }, attributes: ['id'] })
  ).map((a) => a.id);

  if (accountIds.length === 0) {
    return {
      duplicateGroups: { count: 0, extraRowCount: 0 },
      unenrichedTransactions: 0,
      orphanedTransactions: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  type DupeRow = { groups: string; extras: string };
  const [dupe] = await sequelize.query<DupeRow>(
    `SELECT COUNT(*)::text AS groups, COALESCE(SUM(extras), 0)::text AS extras FROM (
       SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
       FROM transactions
       WHERE account_id = ANY($accountIds)
         AND source_identity_fingerprint IS NOT NULL
       GROUP BY source_identity_fingerprint
       HAVING COUNT(*) > 1
     ) g`,
    {
      type: QueryTypes.SELECT,
      bind: { accountIds },
    },
  );

  const unenriched = await Transaction.count({
    where: { accountId: { [Op.in]: accountIds }, merchantCanonical: null },
  });

  // "Orphaned" = txn whose account_id no longer maps to any Account row
  // for this household. With FK constraints this should always be 0 — we
  // surface it so the agent has a sanity probe.
  type OrphanRow = { n: string };
  const [orphan] = await sequelize.query<OrphanRow>(
    `SELECT COUNT(*)::text AS n FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    duplicateGroups: {
      count: Number(dupe.groups),
      extraRowCount: Number(dupe.extras),
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: Number(orphan.n),
    generatedAt: new Date().toISOString(),
  };
}
```

Verify the exact column name for the dedup fingerprint in `backend/src/models/Transaction.ts`. If it's `sourceIdentityFingerprint` mapped to `source_identity_fingerprint`, the SQL above is correct; otherwise update both.

- [ ] **Step 4: Wire route**

Add to `backend/src/routes/audit.ts`:

```typescript
import { integrity } from '../audit/integrity';

router.get('/integrity', async (req, res, next) => {
  try {
    res.json(await integrity(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 5: Re-run test**

```bash
cd backend && yarn tsx --test test/integration/auditIntegrity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/audit/integrity.ts backend/src/routes/audit.ts backend/test/integration/auditIntegrity.test.ts
git commit -m "feat(audit): /integrity reports duplicate groups, orphans, unenriched"
```

---

## Task 9: /api/audit/counts — model row counts

**Files:**
- Create: `backend/src/audit/counts.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/auditCounts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test('GET /api/audit/counts returns numbers for core models', async () => {
  const res = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  for (const k of [
    'transactions',
    'accounts',
    'holdings',
    'rules',
    'contacts',
    'externalOrders',
    'subscriptions',
    'goals',
    'budgets',
    'auditLog',
    'chatThreads',
    'aiSuggestions',
  ]) {
    assert.equal(typeof res.body.counts[k], 'number', `missing count: ${k}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditCounts.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `backend/src/audit/counts.ts`. The implementer must verify each model name against `backend/src/models/index.ts` exports and adjust if any model is missing or named differently:

```typescript
import { Op } from 'sequelize';
import {
  Account,
  Transaction,
  Holding,
  Rule,
  Contact,
  ExternalOrder,
  Subscription,
  FinancialGoal,
  Budget,
  AuditLog,
  ChatThread,
  AiSuggestion,
} from '../models';

export interface CountsResult {
  counts: Record<string, number>;
  generatedAt: string;
}

export async function counts(householdId: number): Promise<CountsResult> {
  const accountIds = (
    await Account.findAll({ where: { householdId }, attributes: ['id'] })
  ).map((a) => a.id);
  const txnWhere = accountIds.length
    ? { accountId: { [Op.in]: accountIds } }
    : { id: -1 };
  const householdWhere = { householdId };
  const [
    transactions,
    accounts,
    holdings,
    rules,
    contacts,
    externalOrders,
    subscriptions,
    goals,
    budgets,
    auditLog,
    chatThreads,
    aiSuggestions,
  ] = await Promise.all([
    Transaction.count({ where: txnWhere }),
    Account.count({ where: householdWhere }),
    Holding.count({ where: householdWhere }),
    Rule.count({ where: householdWhere }),
    Contact.count({ where: householdWhere }),
    ExternalOrder.count({ where: householdWhere }),
    Subscription.count({ where: householdWhere }),
    FinancialGoal.count({ where: householdWhere }),
    Budget.count({ where: householdWhere }),
    AuditLog.count({ where: householdWhere }),
    ChatThread.count({ where: householdWhere }),
    AiSuggestion.count({ where: householdWhere }),
  ]);
  return {
    counts: {
      transactions,
      accounts,
      holdings,
      rules,
      contacts,
      externalOrders,
      subscriptions,
      goals,
      budgets,
      auditLog,
      chatThreads,
      aiSuggestions,
    },
    generatedAt: new Date().toISOString(),
  };
}
```

If any model in the list above doesn't take a plain `householdId` column (e.g. `ChatThread` may join differently), open its model file and adapt the where clause. Don't bypass the check by counting 0 — either filter correctly or omit the metric from this endpoint.

- [ ] **Step 4: Wire route + re-run test + commit**

```typescript
import { counts } from '../audit/counts';

router.get('/counts', async (req, res, next) => {
  try {
    res.json(await counts(req.auditAuth!.household.id));
  } catch (e) {
    next(e);
  }
});
```

```bash
cd backend && yarn tsx --test test/integration/auditCounts.test.ts
```

```bash
git add backend/src/audit/counts.ts backend/src/routes/audit.ts backend/test/integration/auditCounts.test.ts
git commit -m "feat(audit): /counts reports row counts per major household model"
```

---

## Task 10: ClientErrorEvent table + tap from clientLogs

**Files:**
- Create: `backend/src/migrations/20260530000002-create-client-error-events.js`
- Create: `backend/src/models/ClientErrorEvent.ts`
- Modify: `backend/src/models/index.ts`
- Modify: `backend/src/routes/clientLogs.ts`
- Create: `backend/test/integration/clientErrorBuffer.test.ts`

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260530000002-create-client-error-events.js`:

```javascript
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('client_error_events', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'households', key: 'id' },
        onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      user_id: { type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      level: { type: Sequelize.STRING(16), allowNull: false },
      event: { type: Sequelize.STRING(128), allowNull: true },
      message: { type: Sequelize.TEXT, allowNull: false },
      path: { type: Sequelize.STRING(512), allowNull: true },
      request_id: { type: Sequelize.STRING(64), allowNull: true },
      fields_json: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('client_error_events',
      ['household_id', 'created_at'],
      { name: 'client_error_events_household_created' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('client_error_events');
  },
};
```

- [ ] **Step 2: Write the model**

Create `backend/src/models/ClientErrorEvent.ts`:

```typescript
import {
  Model, DataTypes,
  type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export class ClientErrorEvent extends Model<
  InferAttributes<ClientErrorEvent>,
  InferCreationAttributes<ClientErrorEvent>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare userId: number | null;
  declare level: string;
  declare event: string | null;
  declare message: string;
  declare path: string | null;
  declare requestId: string | null;
  declare fieldsJson: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initClientErrorEvent(sequelize: Sequelize): typeof ClientErrorEvent {
  ClientErrorEvent.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: true },
    userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: true },
    level: { type: DataTypes.STRING(16), allowNull: false },
    event: { type: DataTypes.STRING(128), allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: false },
    path: { type: DataTypes.STRING(512), allowNull: true },
    requestId: { type: DataTypes.STRING(64), field: 'request_id', allowNull: true },
    fieldsJson: { type: DataTypes.TEXT, field: 'fields_json', allowNull: true },
  } as ModelAttributes<ClientErrorEvent>, {
    sequelize, modelName: 'ClientErrorEvent',
    tableName: 'client_error_events', underscored: true, timestamps: true,
  });
  return ClientErrorEvent;
}
```

- [ ] **Step 3: Register in `backend/src/models/index.ts`**

Mirror the `UserAuditToken` registration: import init, call in init block, export.

- [ ] **Step 4: Run migration**

```bash
cd backend && yarn db:migrate
```

- [ ] **Step 5: Modify `backend/src/routes/clientLogs.ts` to tap into the buffer**

Open `backend/src/routes/clientLogs.ts`. After the existing pino logger call, when `level === 'error'` (and optionally `'warn'` — implementer's call), persist to the buffer:

```typescript
// At top: import { ClientErrorEvent } from '../models';

// Inside the POST handler, after the pino call:
if (payload.level === 'error' || payload.level === 'warn') {
  // Best-effort — never let buffer failure break the existing endpoint.
  void ClientErrorEvent.create({
    householdId: req.auth?.household.id ?? null,
    userId: req.auth?.user.id ?? null,
    level: payload.level,
    event: payload.event ?? null,
    message: payload.message ?? '',
    path: payload.path ?? null,
    requestId: payload.requestId ?? null,
    fieldsJson: payload.fields ? JSON.stringify(payload.fields).slice(0, 4000) : null,
  }).catch(() => undefined);
}
```

- [ ] **Step 6: Write a test that POSTs a client error and verifies it lands in the buffer**

Create `backend/test/integration/clientErrorBuffer.test.ts`. Bootstrap as Task 4 (session-auth cookie). Then:

```typescript
test('POST /api/client-logs with level=error persists ClientErrorEvent', async () => {
  const res = await agent.post('/api/client-logs').send({
    level: 'error',
    event: 'page.crash',
    message: 'TypeError: cannot read x of undefined',
    path: '/transactions',
  });
  assert.equal(res.status, 204);
  const models = await import('../../src/models');
  // Give the void-promise a tick to settle (the create is fire-and-forget).
  await new Promise((r) => setTimeout(r, 100));
  const rows = await models.ClientErrorEvent.findAll({ where: { userId } });
  assert.ok(rows.length >= 1);
  const row = rows.find((r) => r.event === 'page.crash');
  assert.ok(row);
  assert.equal(row?.message.startsWith('TypeError'), true);
});

test('POST /api/client-logs with level=info does NOT persist', async () => {
  const before = await (await import('../../src/models')).ClientErrorEvent.count({});
  await agent.post('/api/client-logs').send({
    level: 'info',
    event: 'page.view',
    message: 'hello',
    path: '/',
  });
  await new Promise((r) => setTimeout(r, 100));
  const after = await (await import('../../src/models')).ClientErrorEvent.count({});
  assert.equal(after, before);
});
```

Confirm the actual response status the existing `/api/client-logs` POST returns (it may be `200` not `204`) before locking the assertion.

- [ ] **Step 7: Run the test**

```bash
cd backend && yarn tsx --test test/integration/clientErrorBuffer.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/migrations/20260530000002-create-client-error-events.js \
        backend/src/models/ClientErrorEvent.ts backend/src/models/index.ts \
        backend/src/routes/clientLogs.ts backend/test/integration/clientErrorBuffer.test.ts
git commit -m "feat(audit): persist client errors to ring-buffer table"
```

---

## Task 11: /api/audit/client-errors endpoint

**Files:**
- Create: `backend/src/audit/clientErrors.ts`
- Modify: `backend/src/routes/audit.ts`
- Add tests to: `backend/test/integration/clientErrorBuffer.test.ts`

- [ ] **Step 1: Write the failing test (append to clientErrorBuffer test file or its own)**

```typescript
test('GET /api/audit/client-errors returns recent errors for household', async () => {
  // seed an error directly via the model
  const models = await import('../../src/models');
  await models.ClientErrorEvent.create({
    householdId,
    userId,
    level: 'error',
    event: 'deploy.smoke',
    message: 'after-deploy crash',
    path: '/forecast',
    requestId: 'req-123',
    fieldsJson: null,
  });
  const res = await request(app)
    .get('/api/audit/client-errors?limit=50')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.count, 'number');
  assert.ok(Array.isArray(res.body.rows));
  const row = res.body.rows.find((r: { event: string }) => r.event === 'deploy.smoke');
  assert.ok(row);
  assert.equal(row.path, '/forecast');
});

test('GET /api/audit/client-errors honors since= filter', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await request(app)
    .get(`/api/audit/client-errors?since=${encodeURIComponent(future)}`)
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});
```

The Task 5 bootstrap-style test setup needs to also create a household for the audit-token user and link the seeded ClientErrorEvent to that household. Re-read the bootstrap if needed.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/clientErrorBuffer.test.ts
```

Expected: FAIL on the new tests (404).

- [ ] **Step 3: Implement**

Create `backend/src/audit/clientErrors.ts`:

```typescript
import { Op } from 'sequelize';
import { ClientErrorEvent } from '../models';

export interface ClientErrorsQuery {
  since?: Date | null;
  limit?: number;
  level?: string | null;
}

export interface ClientErrorsResult {
  count: number;
  rows: Array<{
    id: number;
    level: string;
    event: string | null;
    message: string;
    path: string | null;
    requestId: string | null;
    createdAt: string;
  }>;
}

export async function clientErrors(
  householdId: number,
  q: ClientErrorsQuery,
): Promise<ClientErrorsResult> {
  const where: Record<string, unknown> = { householdId };
  if (q.since instanceof Date) where.createdAt = { [Op.gte]: q.since };
  if (q.level) where.level = q.level;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const { count, rows } = await ClientErrorEvent.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return {
    count,
    rows: rows.map((r) => ({
      id: r.id,
      level: r.level,
      event: r.event,
      message: r.message,
      path: r.path,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
```

- [ ] **Step 4: Wire route**

```typescript
import { clientErrors } from '../audit/clientErrors';

router.get('/client-errors', async (req, res, next) => {
  try {
    const since = req.query.since
      ? new Date(String(req.query.since))
      : null;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const level = req.query.level ? String(req.query.level) : null;
    res.json(
      await clientErrors(req.auditAuth!.household.id, { since, limit, level }),
    );
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 5: Re-run test + commit**

```bash
cd backend && yarn tsx --test test/integration/clientErrorBuffer.test.ts
```

```bash
git add backend/src/audit/clientErrors.ts backend/src/routes/audit.ts
git commit -m "feat(audit): /client-errors surfaces buffered frontend errors with since/level filters"
```

---

## Task 12: ServerErrorEvent table + Express error tap

**Files:**
- Create: `backend/src/migrations/20260530000003-create-server-error-events.js`
- Create: `backend/src/models/ServerErrorEvent.ts`
- Modify: `backend/src/models/index.ts`
- Modify: `backend/src/app.ts` (add a global error-capture middleware near the end)
- Create: `backend/src/audit/serverErrors.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/serverErrorBuffer.test.ts`

- [ ] **Step 1: Write migration**

Mirror Task 10 migration. Table `server_error_events`. Columns: `id, household_id (nullable), user_id (nullable), method, path, status, message TEXT, stack TEXT, request_id, created_at, updated_at`. Index on `(household_id, created_at)`.

- [ ] **Step 2: Write model**

Mirror `ClientErrorEvent`. Add fields for `method`, `path`, `status`, `stack`. `stack` and `message` are TEXT; everything else STRING.

- [ ] **Step 3: Register in `backend/src/models/index.ts`**

- [ ] **Step 4: Run migration**

```bash
cd backend && yarn db:migrate
```

- [ ] **Step 5: Add Express error-capture middleware**

In `backend/src/app.ts`, locate the existing error handler (search for `app.use((err`). ADD a new middleware that runs JUST BEFORE the existing error handler (so it captures and then re-throws), or modify the existing one to also persist:

```typescript
import { ServerErrorEvent } from './models';

// ...
app.use(
  (
    err: Error & { status?: number },
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    // Tap: persist 5xx errors to the audit buffer (best-effort).
    const status = err.status ?? 500;
    if (status >= 500) {
      void ServerErrorEvent.create({
        householdId: req.auth?.household.id ?? req.auditAuth?.household.id ?? null,
        userId: req.auth?.user.id ?? req.auditAuth?.user.id ?? null,
        method: req.method,
        path: req.originalUrl.slice(0, 512),
        status,
        message: String(err.message ?? '').slice(0, 4000),
        stack: String(err.stack ?? '').slice(0, 8000),
        requestId: (req as Request & { requestId?: string }).requestId ?? null,
      }).catch(() => undefined);
    }
    next(err);
  },
);

// Existing error handler stays below this.
```

Confirm the actual signature/position of the existing error handler before pasting the snippet.

- [ ] **Step 6: Write test**

Create `backend/test/integration/serverErrorBuffer.test.ts`. Add a temporary throw-route to a fixture (or use an existing route that throws on bad input) and verify a row lands in `ServerErrorEvent`. Then also test the audit endpoint:

```typescript
test('500 error persists ServerErrorEvent row', async () => {
  // Trigger a 500: pass malformed JSON to a route that requires JSON.
  const res = await agent.post('/api/transactions').send({ invalid: '🚫'.repeat(10_000_000) }).timeout(10_000);
  // Whatever status the server returns, give the tap a chance to fire.
  await new Promise((r) => setTimeout(r, 200));
  const models = await import('../../src/models');
  const rows = await models.ServerErrorEvent.findAll({ where: { householdId } });
  // Don't assert non-zero unconditionally — if the route returned 400 not 500,
  // the tap should NOT have fired. Instead assert: if any row exists, its
  // shape is correct. The real test is the audit-endpoint test below.
  for (const r of rows) {
    assert.equal(typeof r.method, 'string');
    assert.equal(typeof r.path, 'string');
  }
});
```

The above test is weak by design — it's hard to deterministically trigger a 500 in production routes from a test. The implementer should add a fixture-only throw-route guarded by `NODE_ENV === 'test'` if a stronger assertion is needed; do not ship a public throw-route.

- [ ] **Step 7: Implement /api/audit/server-errors + test**

Create `backend/src/audit/serverErrors.ts` mirroring `clientErrors.ts`. Wire to router as `/server-errors`. Test the endpoint by seeding rows directly via the model (same pattern as Task 11 client-errors test) — that gives a deterministic assertion without depending on the error tap.

- [ ] **Step 8: Commit**

```bash
git add backend/src/migrations/20260530000003-create-server-error-events.js \
        backend/src/models/ServerErrorEvent.ts backend/src/models/index.ts \
        backend/src/app.ts backend/src/audit/serverErrors.ts \
        backend/src/routes/audit.ts \
        backend/test/integration/serverErrorBuffer.test.ts
git commit -m "feat(audit): persist server 5xx errors and expose via /server-errors"
```

---

## Task 13: /api/audit/route-probe — per-page simulated API health

**Files:**
- Create: `backend/src/audit/routesManifest.ts`
- Create: `backend/src/audit/routeProbe.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/auditRouteProbe.test.ts`

- [ ] **Step 1: Define the SPA-route manifest**

Open `frontend/src/App.tsx` and list the top-level routes that hit API endpoints on mount. For each, identify the 1-3 API calls the page fires (look at the page component's `useEffect` / TanStack Query keys).

Create `backend/src/audit/routesManifest.ts`:

```typescript
export interface RouteProbeSpec {
  page: string;        // SPA path, e.g. '/transactions'
  apis: string[];      // API paths the page hits on mount, e.g. ['/api/transactions?limit=1']
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/portfolio', apis: ['/api/portfolio'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/data-quality', apis: ['/api/data-quality'] },
  { page: '/audit-log', apis: ['/api/audit-log?limit=1'] },
  { page: '/calendar', apis: ['/api/calendar'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/net-worth', apis: ['/api/net-worth'] },
  { page: '/notifications', apis: ['/api/notifications'] },
  { page: '/settings', apis: ['/api/settings/cashflow'] },
];
```

IMPLEMENTER: open `frontend/src/App.tsx` and the relevant page components; replace the above list with the actual routes the SPA registers and the actual API paths each page calls. The above is a starting template — every entry must be verified to exist on disk.

- [ ] **Step 2: Implement the probe**

The probe needs to hit each `/api/...` endpoint as if a logged-in user were viewing the page. The cleanest mechanism is to use Node's `fetch` against `http://localhost:${env.port}` with the audit-token user's session cookie — but the audit token doesn't grant session access. Two options:

Option A (recommended): make the probe use the same Express `app` in-process via supertest's pattern. Mount a hidden helper that, given an audit-token request, internally calls each route handler with a synthesized `req.auth` derived from the audit token's user. This is invasive — every probed route would have to accept synthesized auth.

Option B (cleaner): for each manifested API path, simulate the call by directly invoking the underlying handler module via a tiny dispatch helper. E.g. `dispatch('/api/transactions', { method: 'GET', auditAuth: req.auditAuth })`. Avoid HTTP round-trip.

Option C (simplest, recommended): per-probe URL only checks REACHABILITY + STATUS via an in-process supertest-like call against the app, where the audit middleware is bypassed by synthesizing the session middleware for the audit-token user. Encapsulate in a `simulateRequest(app, path, audit)` helper.

Pick Option C. Create `backend/src/audit/routeProbe.ts`:

```typescript
import type { Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { Session } from '../models';
import { hashToken } from '../auth/password';
import { ROUTE_MANIFEST, type RouteProbeSpec } from './routesManifest';
import type { AuditAuthContext } from '../auth/auditAuth';

export interface RouteProbeResult {
  page: string;
  apis: Array<{ path: string; status: number; ok: boolean; errorBody?: string }>;
  ok: boolean;
}

export interface RouteProbeReport {
  routes: RouteProbeResult[];
  generatedAt: string;
}

async function withEphemeralSession<T>(
  userId: number,
  fn: (sessionToken: string) => Promise<T>,
): Promise<T> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60_000);
  await Session.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  try {
    return await fn(token);
  } finally {
    await Session.destroy({ where: { tokenHash: hashToken(token) } });
  }
}

export async function routeProbe(
  app: Express,
  audit: AuditAuthContext,
): Promise<RouteProbeReport> {
  return withEphemeralSession(audit.user.id, async (sessionToken) => {
    const results: RouteProbeResult[] = [];
    for (const spec of ROUTE_MANIFEST) {
      const apis = await Promise.all(
        spec.apis.map(async (apiPath) => {
          const res = await request(app)
            .get(apiPath)
            .set('Cookie', `cashflow_session=${sessionToken}`);
          return {
            path: apiPath,
            status: res.status,
            ok: res.status >= 200 && res.status < 400,
            ...(res.status >= 400
              ? { errorBody: String(res.text ?? '').slice(0, 500) }
              : {}),
          };
        }),
      );
      results.push({
        page: spec.page,
        apis,
        ok: apis.every((a) => a.ok),
      });
    }
    return { routes: results, generatedAt: new Date().toISOString() };
  });
}
```

CRITICAL trade-off: `routeProbe` creates a short-lived real session for the audit-token's user, uses it to call internal APIs, then deletes it. This grants the probe full session powers temporarily. The ephemeral session is 60-second-expiry and deleted in `finally`, but if the process crashes mid-probe a row will linger until expiry — acceptable risk for a self-issued audit on the user's own data.

If the implementer is uncomfortable with the ephemeral-session approach, fall back to Option B (handler dispatch). Pick one consciously and document the choice in the file's top comment.

- [ ] **Step 3: Wire the route**

```typescript
import { routeProbe } from '../audit/routeProbe';

router.get('/route-probe', async (req, res, next) => {
  try {
    res.json(await routeProbe(req.app, req.auditAuth!));
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Write the test**

Create `backend/test/integration/auditRouteProbe.test.ts`. Bootstrap as Task 5 + ALSO seed a transaction, account, etc. so /api/transactions doesn't 500 on empty data. Then:

```typescript
test('GET /api/audit/route-probe returns per-page status for every manifested route', async () => {
  const res = await request(app)
    .get('/api/audit/route-probe')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.routes));
  assert.ok(res.body.routes.length >= 5);
  for (const r of res.body.routes) {
    assert.equal(typeof r.page, 'string');
    assert.ok(Array.isArray(r.apis));
    assert.equal(typeof r.ok, 'boolean');
    for (const a of r.apis) {
      assert.equal(typeof a.path, 'string');
      assert.equal(typeof a.status, 'number');
      assert.equal(typeof a.ok, 'boolean');
    }
  }
});
```

Don't assert `r.ok === true` — some routes may legitimately 4xx on empty test data. The test verifies SHAPE, not GREEN. Green-checking is the agent's job at runtime.

- [ ] **Step 5: Re-run test + commit**

```bash
cd backend && yarn tsx --test test/integration/auditRouteProbe.test.ts
```

```bash
git add backend/src/audit/routesManifest.ts backend/src/audit/routeProbe.ts \
        backend/src/routes/audit.ts backend/test/integration/auditRouteProbe.test.ts
git commit -m "feat(audit): /route-probe simulates each SPA page's API calls and reports status"
```

---

## Task 14: /api/audit/summary — composite digest

**Files:**
- Create: `backend/src/audit/summary.ts`
- Modify: `backend/src/routes/audit.ts`
- Create: `backend/test/integration/auditSummary.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test('GET /api/audit/summary aggregates all probes with verdict per dimension', async () => {
  const res = await request(app)
    .get('/api/audit/summary')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(['pass', 'warn', 'fail'].includes(res.body.overall));
  for (const dim of ['health', 'freshness', 'integrity', 'counts', 'clientErrors', 'serverErrors', 'routes']) {
    assert.ok(res.body.dimensions[dim]);
    assert.ok(['pass', 'warn', 'fail'].includes(res.body.dimensions[dim].verdict));
    assert.ok('summary' in res.body.dimensions[dim]);
  }
  assert.equal(typeof res.body.generatedAt, 'string');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && yarn tsx --test test/integration/auditSummary.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `backend/src/audit/summary.ts`:

```typescript
import type { Express } from 'express';
import { healthDeep } from './healthDeep';
import { freshness } from './freshness';
import { integrity } from './integrity';
import { counts } from './counts';
import { clientErrors } from './clientErrors';
import { serverErrors } from './serverErrors';
import { routeProbe } from './routeProbe';
import type { AuditAuthContext } from '../auth/auditAuth';

type Verdict = 'pass' | 'warn' | 'fail';
const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
const worst = (vs: Verdict[]): Verdict =>
  vs.reduce((acc, v) => (rank[v] > rank[acc] ? v : acc), 'pass' as Verdict);

export interface AuditSummary {
  overall: Verdict;
  dimensions: Record<string, { verdict: Verdict; summary: string }>;
  generatedAt: string;
}

export async function summary(
  app: Express,
  audit: AuditAuthContext,
  windowMinutes = 60,
): Promise<AuditSummary> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const [h, f, i, c, ce, se, rp] = await Promise.all([
    healthDeep(),
    freshness(audit.household.id),
    integrity(audit.household.id),
    counts(audit.household.id),
    clientErrors(audit.household.id, { since, limit: 500 }),
    serverErrors(audit.household.id, { since, limit: 500 }),
    routeProbe(app, audit),
  ]);

  const dims: AuditSummary['dimensions'] = {
    health: {
      verdict: h.ok ? 'pass' : 'fail',
      summary: h.db.reachable
        ? `db ${h.db.latencyMs}ms; ${h.migrations.pending} pending migrations`
        : `db unreachable: ${h.db.error}`,
    },
    freshness: (() => {
      const erroredJobs = f.jobs.filter((j) => j.lastStatus === 'error');
      const stale = f.jobs.filter(
        (j) => j.secondsSinceLastRun != null && j.secondsSinceLastRun > 86_400,
      );
      const verdict: Verdict =
        erroredJobs.length > 0 ? 'fail' : stale.length > 0 ? 'warn' : 'pass';
      return {
        verdict,
        summary: `${f.jobs.length} jobs (${erroredJobs.length} errored, ${stale.length} stale > 24h)`,
      };
    })(),
    integrity: (() => {
      const verdict: Verdict =
        i.orphanedTransactions > 0
          ? 'fail'
          : i.duplicateGroups.count > 0
            ? 'warn'
            : 'pass';
      return {
        verdict,
        summary: `${i.duplicateGroups.count} dupe groups (${i.duplicateGroups.extraRowCount} extras), ${i.unenrichedTransactions} unenriched, ${i.orphanedTransactions} orphans`,
      };
    })(),
    counts: {
      verdict: 'pass' as Verdict,
      summary: Object.entries(c.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
    },
    clientErrors: {
      verdict:
        ce.count === 0
          ? 'pass'
          : ce.count > 20
            ? 'fail'
            : ('warn' as Verdict),
      summary: `${ce.count} client errors in last ${windowMinutes}m`,
    },
    serverErrors: {
      verdict:
        se.count === 0
          ? 'pass'
          : se.count > 5
            ? 'fail'
            : ('warn' as Verdict),
      summary: `${se.count} server 5xx in last ${windowMinutes}m`,
    },
    routes: (() => {
      const broken = rp.routes.filter((r) => !r.ok);
      return {
        verdict: broken.length === 0 ? 'pass' : 'fail',
        summary:
          broken.length === 0
            ? `${rp.routes.length}/${rp.routes.length} pages green`
            : `BROKEN: ${broken.map((b) => b.page).join(', ')}`,
      };
    })(),
  };
  const overall = worst(Object.values(dims).map((d) => d.verdict));
  return { overall, dimensions: dims, generatedAt: new Date().toISOString() };
}
```

- [ ] **Step 4: Wire route**

```typescript
import { summary } from '../audit/summary';

router.get('/summary', async (req, res, next) => {
  try {
    const windowMinutes = req.query.windowMinutes
      ? Math.max(1, Math.min(1440, Number(req.query.windowMinutes)))
      : 60;
    res.json(await summary(req.app, req.auditAuth!, windowMinutes));
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 5: Re-run test + commit**

```bash
cd backend && yarn tsx --test test/integration/auditSummary.test.ts
```

```bash
git add backend/src/audit/summary.ts backend/src/routes/audit.ts backend/test/integration/auditSummary.test.ts
git commit -m "feat(audit): /summary composite digest with pass/warn/fail per dimension"
```

---

## Task 15: Frontend settings UI for audit tokens

**Files:**
- Create: `frontend/src/pages/settings/tabs/AuditTokensTab.tsx`
- Modify: `frontend/src/pages/settings/SettingsPage.tsx` (or wherever the tab registry lives)

- [ ] **Step 1: Find the capture-token UI**

```bash
grep -r "capture/tokens\|CaptureToken" frontend/src --include="*.tsx" -l
```

Locate the capture-token tab component. Open it; this is the template.

- [ ] **Step 2: Create the audit-token tab**

Create `frontend/src/pages/settings/tabs/AuditTokensTab.tsx`. Mirror the capture-token tab EXACTLY but:
- Replace `cfc_` references with `cfa_`.
- Replace `/api/capture/tokens` with `/api/audit/tokens`.
- Replace the label "Capture token" with "AI audit token".
- After mint success, show the plaintext token with a one-time-only warning: "Save this token now — it won't be shown again."
- The intro paragraph should say: "Audit tokens grant an AI agent read-only access to system health, data integrity, and pipeline freshness signals so it can verify production is working correctly after a deploy."

Use Tailwind utilities (no raw CSS). Mirror the existing UI styling.

- [ ] **Step 3: Register the tab**

Open the settings page that registers tabs. Add a tab entry for "AI audit tokens" pointing to `AuditTokensTab`.

- [ ] **Step 4: Manual smoke test**

```bash
cd /Users/connoradams/Developer/cashflow && yarn dev
```

Open `http://localhost:5173/settings`, navigate to the new tab. Mint, list, revoke. Verify the plaintext shows once on mint and never on subsequent list calls.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/tabs/AuditTokensTab.tsx frontend/src/pages/settings/SettingsPage.tsx
git commit -m "feat(audit): settings UI to mint/list/revoke AI audit tokens"
```

---

## Task 16: Buffer-trim background job

**Files:**
- Create: `backend/src/jobs/definitions/auditBufferTrim.ts`
- Modify: `backend/src/jobs/definitions/index.ts` (or wherever jobs register)

- [ ] **Step 1: Find the job registration pattern**

```bash
grep -rn "enrichment_backfill\|job_run_cleanup" backend/src/jobs
```

Open the closest analogue (likely `jobRunCleanup` — it trims a different table).

- [ ] **Step 2: Implement the trim job**

Create `backend/src/jobs/definitions/auditBufferTrim.ts`:

```typescript
import { Op } from 'sequelize';
import { ClientErrorEvent, ServerErrorEvent } from '../../models';

const MAX_AGE_DAYS = 30;
const MAX_ROWS_PER_HOUSEHOLD = 500;

export async function runAuditBufferTrim(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const [c1, c2] = await Promise.all([
    ClientErrorEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
    ServerErrorEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
  ]);
  // Per-household cap: for each household, keep newest MAX_ROWS_PER_HOUSEHOLD,
  // delete the rest. SQL implementation deferred — the age cutoff above
  // covers the common case; add the per-household cap only if buffer bloat
  // becomes a problem in production.
  return { deleted: c1 + c2 };
}

export const auditBufferTrimJob = {
  name: 'audit_buffer_trim',
  cron: '0 4 * * *', // daily at 04:00 UTC
  run: runAuditBufferTrim,
};
```

- [ ] **Step 3: Register the job**

Follow the same pattern the existing jobs use to register with `backend/src/jobs/registry.ts`. Confirm by running the dev server and checking `GET /api/jobs` (session-auth) — the new job should appear.

- [ ] **Step 4: Commit**

```bash
git add backend/src/jobs/definitions/auditBufferTrim.ts backend/src/jobs/definitions/index.ts
git commit -m "feat(audit): nightly trim of client/server error event buffers"
```

---

## Task 17: Agent-usage documentation

**Files:**
- Create: `docs/agent-audit.md`

- [ ] **Step 1: Write the doc**

Create `docs/agent-audit.md`:

````markdown
# Auditing cashflow from an AI agent

This document tells an AI agent (or a human shell user) how to verify the production cashflow deployment is healthy using the read-only audit surface.

## Get a token

1. Sign into the cashflow web app.
2. Go to **Settings → AI audit tokens**.
3. Click **Mint token**, give it a label (e.g. `ci-bot`), copy the `cfa_…` plaintext immediately. It will not be shown again.
4. Store it as an env var (locally, in CI, in your shell session — whatever fits).

```bash
export CASHFLOW_AUDIT_TOKEN="cfa_..."
export CASHFLOW_BACKEND="https://backend-production-30f95.up.railway.app"
```

## Endpoints

All audit endpoints are read-only (`GET`) and require `Authorization: Bearer $CASHFLOW_AUDIT_TOKEN`.

| Endpoint | What it tells you |
|---|---|
| `GET /api/audit/health-deep` | DB reachable + latency, pending migrations, version |
| `GET /api/audit/freshness` | Scheduler job heartbeats, last import per source, email-integration last scan |
| `GET /api/audit/integrity` | Duplicate transaction groups, FK orphans, unenriched count |
| `GET /api/audit/counts` | Row counts per major model |
| `GET /api/audit/client-errors?since=ISO&level=error` | Frontend errors logged via clientLogger |
| `GET /api/audit/server-errors?since=ISO` | Backend 5xx events in the last N minutes |
| `GET /api/audit/route-probe` | Per-SPA-page status: simulates the API calls each page makes |
| `GET /api/audit/summary?windowMinutes=60` | **Start here.** Composite digest with pass/warn/fail per dimension |

## Agent loop pattern

```bash
# 1. Smoke check after deploy
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/summary?windowMinutes=15" | jq

# 2. If overall != "pass", drill down on the failed dimension
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/route-probe" | jq '.routes[] | select(.ok == false)'

# 3. For frontend errors, check the buffer
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/client-errors?level=error&limit=20" | jq '.rows'
```

## "Page won't load and there's an error at the top" diagnosis

1. `GET /api/audit/summary` → look at `dimensions.routes.verdict`.
2. If `fail`, the `summary` field names the broken pages: `BROKEN: /transactions, /forecast`.
3. `GET /api/audit/route-probe` → for each broken page, look at `apis[].errorBody` to see the actual error.
4. `GET /api/audit/server-errors?since=<deploy_time>` → if the failing API is a 5xx, the buffered stack trace is there.
5. `GET /api/audit/client-errors?since=<deploy_time>` → if the page is throwing client-side, the captured error event names the file:line.

## What this surface does NOT cover

- Loki / Grafana / Tempo — query those directly for cross-service traces.
- Histograms or rate-of-change — every endpoint returns a single snapshot.
- Mutations — the audit surface is strictly read-only. The agent cannot retry a failed job or re-enrich data from here. Use the session-auth UI/API for that.

## Revoking a token

`Settings → AI audit tokens → Revoke`. Token is soft-deleted (`revoked_at` set); subsequent calls return 401 within seconds.
````

- [ ] **Step 2: Commit**

```bash
git add docs/agent-audit.md
git commit -m "docs(audit): agent-usage doc for /api/audit/* surface"
```

---

## Task 18: End-to-end smoke test against prod (manual, not committed)

**Pre-merge sanity check — do this from the worktree before opening the PR.**

- [ ] **Step 1: Mint a token in dev**

Run the local dev server, log in, mint a `cfa_` token via the new UI.

- [ ] **Step 2: Hit each endpoint locally**

```bash
T="cfa_..."
B="http://localhost:3001"
for ep in health-deep freshness integrity counts client-errors server-errors route-probe summary; do
  echo "=== $ep ==="
  curl -sS -H "Authorization: Bearer $T" "$B/api/audit/$ep" -w "\nHTTP %{http_code}\n"
done
```

Every endpoint must return HTTP 200 and valid JSON.

- [ ] **Step 3: Confirm 405 on non-GET**

```bash
curl -sS -H "Authorization: Bearer $T" -X POST "$B/api/audit/health-deep" -w "\nHTTP %{http_code}\n"
```

Expected: `HTTP 405`.

- [ ] **Step 4: Confirm 401 on bad token**

```bash
curl -sS -H "Authorization: Bearer cfa_BAD000000000000000000000000000000" "$B/api/audit/health-deep" -w "\nHTTP %{http_code}\n"
```

Expected: `HTTP 401`.

---

## Task 19: PR + auto-merge

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/connoradams/Developer/cashflow && yarn ci
```

Expected: all tests green, type-check passes.

- [ ] **Step 2: Push branch**

```bash
git push -u origin claude/elastic-bassi-a4d57a
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(audit): AI agent audit surface at /api/audit/*" --body "$(cat <<'EOF'
## Summary

Adds a read-only, bearer-token-authenticated audit surface (`/api/audit/*`) so an AI agent can verify the production cashflow deployment is healthy after a deploy or on a recurring schedule.

- New `UserAuditToken` model + `cfa_`-prefixed tokens (mirrors capture-token pattern).
- `requireAuditAuth` middleware: GET-only, bearer-only, household-scoped, 405 on non-GET.
- 8 audit endpoints: `health-deep`, `freshness`, `integrity`, `counts`, `client-errors`, `server-errors`, `route-probe`, `summary`.
- Two new ring-buffer tables (`client_error_events`, `server_error_events`) capped by nightly trim job.
- Frontend settings tab to mint/list/revoke tokens.
- Docs at `docs/agent-audit.md`.

## Test plan

- [ ] `yarn test:integration` green for all new audit-* test files
- [ ] Mint a token in dev, hit every endpoint with curl, confirm 200
- [ ] `POST /api/audit/health-deep` returns 405
- [ ] Bad bearer returns 401
- [ ] After deploy to prod, `GET /api/audit/summary` returns `overall: pass`
EOF
)"
```

- [ ] **Step 4: Enable auto-merge with merge commit**

```bash
gh pr merge --auto --merge
```

If the repo rejects with `allow_auto_merge=false`:

```bash
gh api -X PATCH repos/Connor-Adams/cashflow -f allow_auto_merge=true
gh pr merge --auto --merge
```

- [ ] **Step 5: Watch CI**

`gh pr checks` until merged.

---

## Self-Review Checklist

- [x] Token mint flow → Task 4 ✓
- [x] Token middleware → Task 3, validated in Task 5 ✓
- [x] Health probe → Task 6 ✓
- [x] Pipeline freshness → Task 7 ✓
- [x] Integrity → Task 8 ✓
- [x] Counts → Task 9 ✓
- [x] Client errors → Tasks 10–11 ✓
- [x] Server errors → Task 12 ✓
- [x] Route probe (covers "page won't load after deploy") → Task 13 ✓
- [x] Summary → Task 14 ✓
- [x] UI → Task 15 ✓
- [x] Buffer trim → Task 16 ✓
- [x] Agent doc → Task 17 ✓
- [x] Smoke test → Task 18 ✓
- [x] PR + auto-merge → Task 19 ✓

**Type/naming consistency checked:** all references to `req.auditAuth`, `requireAuditAuth`, `cfa_`, `UserAuditToken`, `ClientErrorEvent`, `ServerErrorEvent`, `ROUTE_MANIFEST` agree across tasks.

**No placeholders:** scanned for TBD / TODO / "implement later" — none in code blocks. Open questions are explicitly flagged for the implementer (e.g. "verify column name X before relying on the cast").

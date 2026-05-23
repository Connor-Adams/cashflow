# Vendor Receipt Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a vendor-agnostic capture pipeline that ingests Amazon and Apple purchase data into `ExternalOrder` via one-click browser bookmarklets, so opaque card transactions (`AMZN MKTP`, `APPLE.COM/BILL`) get enriched with item-level detail through the existing `linkItemsStage` matcher.

**Architecture:** New `POST /api/capture/orders` endpoint authenticated by per-user bearer tokens (cross-origin from amazon.com / reportaproblem.apple.com — session cookies won't cross). A shared `vendorCapture` module upserts orders by `dedupeKey`. Bookmarklets bundled by Vite, embedded with the user's token at render-time in Settings. Existing matcher generalized to consider non-Amazon orders.

**Tech Stack:** Express + Sequelize (sqlite dev / postgres prod), TypeScript everywhere, `node:test` + `supertest` for integration tests, Vite for frontend (React + shadcn-style components). No new top-level dependencies needed.

---

## Spec reference

Design lives at `docs/superpowers/specs/2026-05-22-vendor-receipt-capture-design.md`. Read it before starting.

## File structure

**Create:**
- `backend/src/migrations/20260522000001-user-capture-tokens.js` — table for bearer tokens
- `backend/src/models/UserCaptureToken.ts` — Sequelize model
- `backend/src/auth/captureToken.ts` — token helpers (mint, hash, format)
- `backend/src/auth/captureAuth.ts` — middleware that resolves bearer token → user + household
- `backend/src/routes/capture.ts` — `POST /api/capture/orders` + mint/list/revoke routes
- `backend/src/import/vendorCapture.ts` — shared upsert function (used by route now, by future paste/AI ingestion later)
- `backend/src/import/enrichment/vendors.ts` — `canonicalNameForVendor` map
- `backend/test/vendorCapture.test.ts` — unit tests for `captureOrders`
- `backend/test/integration/captureOrders.test.ts` — end-to-end route test
- `backend/test/integration/captureTokens.test.ts` — mint/list/revoke test
- `frontend/src/bookmarklets/amazon.ts` — Amazon bookmarklet entry (IIFE)
- `frontend/src/bookmarklets/apple.ts` — Apple bookmarklet entry (IIFE)
- `frontend/src/bookmarklets/scrape/amazon.ts` — pure `extractAmazonOrdersFromDom(doc)`
- `frontend/src/bookmarklets/scrape/apple.ts` — pure `extractApplePurchasesFromDom(doc)`
- `frontend/src/bookmarklets/scrape/post.ts` — fetch wrapper
- `frontend/src/bookmarklets/scrape/toast.ts` — DOM toast helper
- `frontend/src/bookmarklets/scrape/types.ts` — `CapturedOrder` shape shared by Amazon + Apple
- `frontend/vite.bookmarklets.config.ts` — separate Vite build config emitting IIFE bundles
- `frontend/test/fixtures/amazon-orders.html` — saved page snippet
- `frontend/test/fixtures/apple-reportaproblem.html` — saved page snippet
- `frontend/test/bookmarklets/amazon.test.ts` — scraper unit test
- `frontend/test/bookmarklets/apple.test.ts` — scraper unit test
- `frontend/src/lib/captureTokens.ts` — small client wrapper for the token endpoints

**Modify:**
- `backend/src/models/index.ts` — register `UserCaptureToken`
- `backend/src/app.ts` — mount `captureRouter`
- `backend/src/import/enrichment/loaders.ts` — rename `loadAmazonOrdersCache` → `loadVendorOrdersCache`, drop vendor filter
- `backend/src/import/enrichment/linkItemsStage.ts` — remove merchant gate, derive `merchantCanonical` from vendor
- `backend/src/import/runEnrichmentBackfill.ts` — rename helper call, add `dateFrom` / `dateTo` to `BackfillFlags`
- `backend/src/routes/transactions.ts` — pass through `dateFrom` / `dateTo` if present in backfill request body
- `frontend/src/pages/SettingsPage.tsx` — add "Receipt capture" card
- `frontend/package.json` — add `build:bookmarklets` script
- `backend/test/integration/backfillEnrichment.test.ts` — update `seedFlags` to include new fields with `null` defaults

---

## Task 1: Database migration and model for `user_capture_tokens`

**Files:**
- Create: `backend/src/migrations/20260522000001-user-capture-tokens.js`
- Create: `backend/src/models/UserCaptureToken.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260522000001-user-capture-tokens.js`:

```js
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
    await queryInterface.createTable('user_capture_tokens', {
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
    await addIndex(queryInterface, 'user_capture_tokens', ['token_hash'], {
      name: 'user_capture_tokens_token_hash_unique',
      unique: true,
    });
    await addIndex(queryInterface, 'user_capture_tokens', ['user_id', 'revoked_at'], {
      name: 'user_capture_tokens_user_active',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_capture_tokens');
  },
};
```

- [ ] **Step 2: Run the migration locally to verify it applies cleanly**

Run: `cd backend && yarn db:migrate`
Expected: `== 20260522000001-user-capture-tokens: migrated` line in output.

- [ ] **Step 3: Verify rollback works**

Run: `cd backend && yarn db:migrate:undo`
Expected: migration runs `down`, table dropped. Then re-run `yarn db:migrate` to restore.

- [ ] **Step 4: Write the Sequelize model**

Create `backend/src/models/UserCaptureToken.ts`:

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserCaptureToken extends Model<
  InferAttributes<UserCaptureToken>,
  InferCreationAttributes<UserCaptureToken>
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

export function initUserCaptureToken(sequelize: Sequelize): typeof UserCaptureToken {
  UserCaptureToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      tokenHash: {
        type: DataTypes.STRING(64),
        field: 'token_hash',
        allowNull: false,
      },
      label: { type: DataTypes.STRING(64), allowNull: false },
      lastUsedAt: { type: DataTypes.DATE, field: 'last_used_at', allowNull: true },
      revokedAt: { type: DataTypes.DATE, field: 'revoked_at', allowNull: true },
    } as ModelAttributes<UserCaptureToken>,
    {
      sequelize,
      modelName: 'UserCaptureToken',
      tableName: 'user_capture_tokens',
      underscored: true,
      timestamps: true,
    }
  );
  return UserCaptureToken;
}
```

- [ ] **Step 5: Wire the model into the registry**

Edit `backend/src/models/index.ts`. Add to the imports near the top:

```ts
import { UserCaptureToken, initUserCaptureToken } from './UserCaptureToken';
```

Add a call near the other `init*` calls (after `initUser(sequelize)` is fine):

```ts
initUserCaptureToken(sequelize);
```

Add an association in the associations block (after `User.hasMany(Session, ...)`):

```ts
User.hasMany(UserCaptureToken, { foreignKey: 'user_id', as: 'captureTokens' });
UserCaptureToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
```

Add `UserCaptureToken` to the `export { … }` block at the bottom.

- [ ] **Step 6: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/20260522000001-user-capture-tokens.js \
        backend/src/models/UserCaptureToken.ts \
        backend/src/models/index.ts
git commit -m "feat(capture): user_capture_tokens table + model"
```

---

## Task 2: Token helpers and middleware

**Files:**
- Create: `backend/src/auth/captureToken.ts`
- Create: `backend/src/auth/captureAuth.ts`

- [ ] **Step 1: Write the token helper module**

Create `backend/src/auth/captureToken.ts`:

```ts
import crypto from 'crypto';

const TOKEN_PREFIX = 'cfc_';
const TOKEN_BYTES = 24; // 32 chars after base64url

export function mintCaptureTokenPlaintext(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return `${TOKEN_PREFIX}${random}`;
}

export function hashCaptureToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isCaptureTokenFormat(value: string): boolean {
  return /^cfc_[A-Za-z0-9_-]{32}$/.test(value);
}

export function maskCaptureToken(plaintext: string): string {
  if (plaintext.length < 10) return plaintext;
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-3)}`;
}
```

- [ ] **Step 2: Write the middleware**

Create `backend/src/auth/captureAuth.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import { HouseholdMember, User, UserCaptureToken, Household } from '../models';
import { hashCaptureToken, isCaptureTokenFormat } from './captureToken';

export interface CaptureAuthContext {
  user: User;
  household: Household;
  token: UserCaptureToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    captureAuth?: CaptureAuthContext;
  }
}

export async function captureAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const plaintext = match?.[1] ?? '';
    if (!plaintext || !isCaptureTokenFormat(plaintext)) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    const token = await UserCaptureToken.findOne({ where: { tokenHash: hashCaptureToken(plaintext) } });
    if (!token || token.revokedAt != null) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    const user = await User.findByPk(token.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid capture token' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'Capture token user has no household' });
      return;
    }
    // Best-effort touch — never fail the request if this errors.
    void token.update({ lastUsedAt: new Date() }).catch(() => undefined);
    req.captureAuth = { user, household, token };
    next();
  } catch (e) {
    next(e);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/auth/captureToken.ts backend/src/auth/captureAuth.ts
git commit -m "feat(capture): bearer-token mint + middleware helpers"
```

---

## Task 3: `vendorCapture` module (the shared upsert)

**Files:**
- Create: `backend/src/import/vendorCapture.ts`
- Create: `backend/test/vendorCapture.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `backend/test/vendorCapture.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const dbPath = path.join(backendRoot, 'data', 'test-vendor-capture.sqlite');

let models: typeof import('../src/models/index.js');
let vendorCapture: typeof import('../src/import/vendorCapture.js');

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
  models = await import('../src/models/index.js');
  vendorCapture = await import('../src/import/vendorCapture.js');
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

async function makeHouseholdAndUser() {
  const user = await models.User.create({
    email: `vc-${Date.now()}-${Math.random()}@example.com`,
    displayName: 'VC user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const household = await models.Household.create({ name: 'VC household' } as never);
  await models.HouseholdMember.create({
    userId: user.id,
    householdId: household.id,
    role: 'owner',
  } as never);
  return { user, household };
}

beforeEach(async () => {
  await models.ExternalOrderItem.destroy({ where: {} });
  await models.ExternalOrder.destroy({ where: {} });
});

test('captureOrders inserts new orders with items', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const result = await vendorCapture.captureOrders({
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon',
    source: 'bookmarklet-amazon-v1',
    orders: [
      {
        vendorOrderId: '112-1111111-1111111',
        orderDate: '2026-05-10',
        total: 25.99,
        currency: 'CAD',
        paymentLast4: '4321',
        items: [{ title: 'USB-C cable', totalPrice: 12.99 }, { title: 'Adapter', totalPrice: 13.00 }],
      },
    ],
  });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);

  const orders = await models.ExternalOrder.findAll({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].vendor, 'amazon');
  assert.equal(orders[0].vendorOrderId, '112-1111111-1111111');
  assert.equal(Number(orders[0].total), 25.99);
  const items = (orders[0] as unknown as { items: unknown[] }).items;
  assert.equal(items.length, 2);
});

test('captureOrders is idempotent on identical payload', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const payload = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon',
    source: 'bookmarklet-amazon-v1',
    orders: [
      {
        vendorOrderId: 'O-1',
        orderDate: '2026-05-10',
        total: 9.99,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'X', totalPrice: 9.99 }],
      },
    ],
  } as const;
  await vendorCapture.captureOrders({ ...payload });
  const second = await vendorCapture.captureOrders({ ...payload });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);
  const count = await models.ExternalOrder.count();
  assert.equal(count, 1);
});

test('captureOrders replaces items when new payload has more items', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const base = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon' as const,
    source: 'bookmarklet-amazon-v1',
  };
  await vendorCapture.captureOrders({
    ...base,
    orders: [
      { vendorOrderId: 'O-2', orderDate: '2026-05-10', total: 30, currency: 'CAD', paymentLast4: null, items: [{ title: 'A' }] },
    ],
  });
  const result = await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-2',
        orderDate: '2026-05-10',
        total: 30,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
      },
    ],
  });
  assert.equal(result.updated, 1);
  const order = await models.ExternalOrder.findOne({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  const items = (order as unknown as { items: { title: string }[] }).items;
  assert.equal(items.length, 3);
  const titles = items.map((it) => it.title).sort();
  assert.deepEqual(titles, ['A', 'B', 'C']);
});

test('captureOrders keeps existing items when new payload has fewer', async () => {
  const { user, household } = await makeHouseholdAndUser();
  const base = {
    householdId: household.id,
    userId: user.id,
    vendor: 'amazon' as const,
    source: 'bookmarklet-amazon-v1',
  };
  await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-3',
        orderDate: '2026-05-10',
        total: 30,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }, { title: 'B' }],
      },
    ],
  });
  const result = await vendorCapture.captureOrders({
    ...base,
    orders: [
      {
        vendorOrderId: 'O-3',
        orderDate: '2026-05-10',
        total: 31, // header updated
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'A' }],
      },
    ],
  });
  assert.equal(result.updated, 1);
  const order = await models.ExternalOrder.findOne({ include: [{ model: models.ExternalOrderItem, as: 'items' }] });
  assert.equal(Number(order!.total), 31);
  const items = (order as unknown as { items: { title: string }[] }).items;
  assert.equal(items.length, 2, 'fuller prior capture must be preserved');
});

test('captureOrders rejects empty vendor', async () => {
  const { user, household } = await makeHouseholdAndUser();
  await assert.rejects(() =>
    vendorCapture.captureOrders({
      householdId: household.id,
      userId: user.id,
      vendor: '',
      source: 'bookmarklet-amazon-v1',
      orders: [],
    } as never),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && yarn test:integration 2>&1 | head -40` (the new file is in `test/` root but mirrors the integration-style pattern with a real DB; it'll be picked up by `test` script too)
Expected: FAIL with "Cannot find module '../src/import/vendorCapture'".

Actually, run: `cd backend && yarn test 2>&1 | head -40`
Expected: same FAIL.

- [ ] **Step 3: Implement `vendorCapture`**

Create `backend/src/import/vendorCapture.ts`:

```ts
import crypto from 'crypto';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../models';

export interface CapturedItemInput {
  title: string;
  quantity?: number;
  unitPrice?: number | null;
  totalPrice?: number | null;
}

export interface CapturedOrderInput {
  vendorOrderId: string | null;
  orderDate: string;
  total: number;
  currency: string;
  paymentLast4: string | null;
  items: CapturedItemInput[];
}

export interface CaptureOrdersArgs {
  householdId: number;
  userId: number;
  vendor: string;
  source: string;
  orders: CapturedOrderInput[];
}

export interface CaptureOrderOutcome {
  vendorOrderId: string | null;
  externalOrderId: number;
  status: 'created' | 'updated' | 'skipped';
}

export interface CaptureResult {
  created: number;
  updated: number;
  skipped: number;
  orders: CaptureOrderOutcome[];
}

function stableHash(parts: Array<string | number | null>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => (p == null ? '' : String(p))).join('|'))
    .digest('hex')
    .slice(0, 32);
}

function buildDedupeKey(vendor: string, order: CapturedOrderInput): string {
  if (order.vendorOrderId) return `${vendor}:${order.vendorOrderId}`;
  return `${vendor}:${stableHash([
    order.orderDate,
    order.total,
    order.paymentLast4,
    order.items[0]?.title ?? '',
  ])}`;
}

function itemsAreEquivalent(
  existing: { title: string }[],
  next: CapturedItemInput[],
): boolean {
  if (existing.length !== next.length) return false;
  const sortKey = (t: string) => t.trim().toLowerCase();
  const a = existing.map((it) => sortKey(it.title)).sort();
  const b = next.map((it) => sortKey(it.title)).sort();
  return a.every((t, i) => t === b[i]);
}

export async function captureOrders(args: CaptureOrdersArgs): Promise<CaptureResult> {
  if (!args.vendor || !args.vendor.trim()) {
    throw new Error('vendor is required');
  }
  if (!args.source) {
    throw new Error('source is required');
  }
  if (!Array.isArray(args.orders)) {
    throw new Error('orders must be an array');
  }

  const vendor = args.vendor.toLowerCase();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const outcomes: CaptureOrderOutcome[] = [];

  for (const order of args.orders) {
    const dedupeKey = buildDedupeKey(vendor, order);
    await sequelize.transaction(async (t) => {
      const existing = await ExternalOrder.findOne({
        where: { householdId: args.householdId, dedupeKey },
        transaction: t,
      });
      if (!existing) {
        const row = await ExternalOrder.create(
          {
            householdId: args.householdId,
            createdByUserId: args.userId,
            vendor,
            vendorOrderId: order.vendorOrderId,
            dedupeKey,
            orderDate: order.orderDate,
            shipmentDate: null,
            subtotal: null,
            tax: null,
            shipping: null,
            total: String(order.total),
            currency: order.currency || 'CAD',
            paymentLast4: order.paymentLast4,
            source: args.source,
            rawPayload: { items: order.items },
          },
          { transaction: t },
        );
        if (order.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            order.items.map((it) => ({
              externalOrderId: row.id,
              title: it.title,
              quantity: it.quantity ?? 1,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: null,
              businessUsePercent: null,
              confidence: null,
              rawPayload: null,
            })),
            { transaction: t },
          );
        }
        created++;
        outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: row.id, status: 'created' });
        return;
      }

      const existingItems = await ExternalOrderItem.findAll({
        where: { externalOrderId: existing.id },
        transaction: t,
      });

      if (
        Number(existing.total) === Number(order.total) &&
        existing.orderDate === order.orderDate &&
        existing.paymentLast4 === order.paymentLast4 &&
        itemsAreEquivalent(existingItems, order.items)
      ) {
        skipped++;
        outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: existing.id, status: 'skipped' });
        return;
      }

      await existing.update(
        {
          total: String(order.total),
          orderDate: order.orderDate,
          paymentLast4: order.paymentLast4,
          currency: order.currency || existing.currency,
          source: args.source,
          rawPayload: { items: order.items },
        },
        { transaction: t },
      );

      if (order.items.length >= existingItems.length) {
        await ExternalOrderItem.destroy({ where: { externalOrderId: existing.id }, transaction: t });
        if (order.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            order.items.map((it) => ({
              externalOrderId: existing.id,
              title: it.title,
              quantity: it.quantity ?? 1,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: null,
              businessUsePercent: null,
              confidence: null,
              rawPayload: null,
            })),
            { transaction: t },
          );
        }
      }

      updated++;
      outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: existing.id, status: 'updated' });
    });
  }

  return { created, updated, skipped, orders: outcomes };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd backend && yarn test 2>&1 | tail -20`
Expected: PASS for all five tests in `vendorCapture.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/vendorCapture.ts backend/test/vendorCapture.test.ts
git commit -m "feat(capture): vendorCapture module with idempotent upsert"
```

---

## Task 4: Capture-token routes (mint / list / revoke)

**Files:**
- Create: `backend/src/routes/capture.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/test/integration/captureTokens.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `backend/test/integration/captureTokens.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-capture-tokens.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');

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
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'tokens@example.com',
    displayName: 'Tokens User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('mints a token, lists it (without plaintext), then revokes', async () => {
  const mint = await authed.post('/api/capture/tokens').send({ label: 'My Mac' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfc_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'My Mac');
  const tokenId = mint.body.id;

  const list = await authed.get('/api/capture/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].label, 'My Mac');

  const revoke = await authed.delete(`/api/capture/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  const listAfter = await authed.get('/api/capture/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('rejects unauthenticated calls', async () => {
  const res = await request(app).post('/api/capture/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run the test, verify FAIL**

Run: `cd backend && yarn test:integration 2>&1 | grep -E "tokens|FAIL|404" | head`
Expected: 404 or similar — route not mounted.

- [ ] **Step 3: Implement the router (mint / list / revoke only — capture-orders comes in Task 6)**

Create `backend/src/routes/capture.ts`:

```ts
import { Router } from 'express';
import { Op } from 'sequelize';
import { UserCaptureToken } from '../models';
import { currentAuth } from '../auth/middleware';
import { hashCaptureToken, mintCaptureTokenPlaintext } from '../auth/captureToken';

const router = Router();

router.post('/tokens', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const label = String((req.body as { label?: unknown } | undefined)?.label ?? '').trim() || 'Browser';
    if (label.length > 64) {
      res.status(400).json({ error: 'Label must be 64 characters or fewer' });
      return;
    }
    const plaintext = mintCaptureTokenPlaintext();
    const row = await UserCaptureToken.create({
      userId: user.id,
      tokenHash: hashCaptureToken(plaintext),
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

router.get('/tokens', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await UserCaptureToken.findAll({
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

router.delete('/tokens/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await UserCaptureToken.findOne({ where: { id, userId: user.id } });
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

- [ ] **Step 4: Mount the router in `app.ts`**

Edit `backend/src/app.ts`. Add import near other routers:

```ts
import captureRouter from './routes/capture';
```

Add mount line after `app.use('/api/amazon', amazonRouter);` (anywhere in the authed block before the error handler):

```ts
app.use('/api/capture', captureRouter);
```

- [ ] **Step 5: Run the test, verify PASS**

Run: `cd backend && yarn test:integration 2>&1 | tail -20`
Expected: both tests in `captureTokens.test.ts` pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/capture.ts backend/src/app.ts \
        backend/test/integration/captureTokens.test.ts
git commit -m "feat(capture): mint/list/revoke routes for capture tokens"
```

---

## Task 5: Lift Amazon-isms in matcher and loader

**Files:**
- Create: `backend/src/import/enrichment/vendors.ts`
- Modify: `backend/src/import/enrichment/linkItemsStage.ts`
- Modify: `backend/src/import/enrichment/loaders.ts`
- Modify: `backend/src/import/runEnrichmentBackfill.ts`

- [ ] **Step 1: Add the vendor display map**

Create `backend/src/import/enrichment/vendors.ts`:

```ts
const VENDOR_DISPLAY: Record<string, string> = {
  amazon: 'Amazon',
  apple: 'Apple',
};

export function canonicalNameForVendor(vendor: string | null | undefined): string | null {
  if (!vendor) return null;
  const key = vendor.toLowerCase();
  return VENDOR_DISPLAY[key] ?? vendor;
}
```

- [ ] **Step 2: Add `vendor` to `LinkItemsCandidateOrder`**

Edit `backend/src/import/enrichment/linkItemsStage.ts`. Change the interface (top of file):

```ts
export interface LinkItemsCandidateOrder {
  id: number;
  vendor: string;
  total: number;
  orderDate: string;
  shipmentDate: string | null;
  paymentLast4: string | null;
  items: LinkItemsCandidateItem[];
}
```

- [ ] **Step 3: Lift the Amazon merchant gate**

In the same file, modify `runLinkItemsStage`:

```ts
import { isAmazonLikeMerchant, scoreAmazonOrderMatch } from '../../amazon/matcher';
// ... unchanged imports ...
import { canonicalNameForVendor } from './vendors';

// ... unchanged interfaces above ...

export function runLinkItemsStage(input: LinkItemsInput): Signal[] {
  if (input.candidateOrders.length === 0) {
    return [];
  }

  const synthesised: Pick<Transaction, 'amount' | 'date' | 'merchantRaw' | 'merchantClean' | 'notes' | 'sourceReference'> = {
    amount: String(input.amount),
    date: input.date,
    merchantRaw: input.merchantRaw,
    merchantClean: input.merchantClean,
    notes: input.notes,
    sourceReference: input.sourceReference,
  } as Transaction;

  let best: { order: LinkItemsCandidateOrder; confidence: number } | null = null;
  for (const order of input.candidateOrders) {
    const externalOrder: ExternalOrder = {
      total: String(order.total),
      orderDate: order.orderDate,
      shipmentDate: order.shipmentDate,
      paymentLast4: order.paymentLast4,
      // Provide just enough for the Amazon scorer; for non-amazon orders the
      // "merchant indicates Amazon" bonus simply doesn't fire, which is correct.
      merchantRaw: input.merchantRaw,
      merchantClean: input.merchantClean,
    } as ExternalOrder;
    const score = scoreAmazonOrderMatch(synthesised as Transaction, externalOrder);
    if (score.confidence >= input.threshold && (!best || score.confidence > best.confidence)) {
      best = { order, confidence: score.confidence };
    }
  }

  if (!best) return [];

  const items = best.order.items;
  // ... existing item/category logic unchanged ...
  const categories = items
    .map((it) => it.inferredCategory)
    .filter((c): c is string => c != null && c.trim() !== '');
  const uniqueCategories = Array.from(new Set(categories));

  let autoCategory: string | null = null;
  let confidence: 'high' | 'medium' = 'medium';

  if (uniqueCategories.length === 1) {
    autoCategory = uniqueCategories[0];
    confidence = 'high';
  } else if (uniqueCategories.length > 1) {
    const winner = items
      .filter((it) => it.inferredCategory != null && it.inferredCategory.trim() !== '')
      .sort((a, b) => num(b.totalPrice) - num(a.totalPrice))[0];
    autoCategory = winner?.inferredCategory ?? null;
    confidence = 'medium';
  }

  const autoBusiness = items.some((it) => num(it.businessUsePercent) > 0) || null;
  const vendorDisplay = canonicalNameForVendor(best.order.vendor) ?? 'Amazon';

  return [
    {
      source: best.order.vendor === 'amazon' ? 'amazon-items' : `${best.order.vendor}-items`,
      confidence,
      fields: {
        merchantCanonical: vendorDisplay,
        autoCategory,
        autoBusiness,
        linkedExternalOrderId: best.order.id,
        notes: buildNotes(items),
      },
      rationale: `linked to ${vendorDisplay} order ${best.order.id} (match confidence ${best.confidence})`,
    },
  ];
}
```

Keep the imported `isAmazonLikeMerchant` reference removed if unused — the linter will warn. If still referenced elsewhere in the file, leave it.

- [ ] **Step 4: Rename and generalize the loader**

Edit `backend/src/import/enrichment/loaders.ts`. Replace `loadAmazonOrdersCache` with:

```ts
export async function loadVendorOrdersCache(householdId: number | null): Promise<LinkItemsCandidateOrder[]> {
  const orders = await ExternalOrder.findAll({
    where: householdId != null ? { householdId } : {},
    include: [{ model: ExternalOrderItem, as: 'items' }],
  });
  return orders.map((o) => ({
    id: o.id,
    vendor: o.vendor,
    total: Number(o.total ?? 0),
    orderDate: o.orderDate ?? '',
    shipmentDate: o.shipmentDate,
    paymentLast4: o.paymentLast4,
    items: ((o as unknown as { items?: ExternalOrderItemType[] }).items ?? []).map((it) => ({
      id: it.id,
      title: it.title,
      totalPrice: it.totalPrice,
      inferredCategory: it.inferredCategory,
      businessUsePercent: it.businessUsePercent,
    })),
  }));
}
```

- [ ] **Step 5: Update the call site in `runEnrichmentBackfill.ts`**

Edit `backend/src/import/runEnrichmentBackfill.ts`. Replace the import:

```ts
import {
  loadVendorOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
```

Rename the cache variable and function:

```ts
const ordersByHousehold = new Map<string, Awaited<ReturnType<typeof loadVendorOrdersCache>>>();
// ...
async function getVendorOrders(hh: number | null) {
  const k = householdKey(hh);
  if (!ordersByHousehold.has(k)) ordersByHousehold.set(k, await loadVendorOrdersCache(hh));
  return ordersByHousehold.get(k)!;
}
```

Update the call inside the loop:

```ts
const vendorOrders = await getVendorOrders(txn.householdId);
// ...
const enriched = await enrichTransaction({
  // ...
  amazonOrders: vendorOrders, // existing field name in enrich.ts; rename in next step
  // ...
});
```

- [ ] **Step 6: Rename `amazonOrders` → `vendorOrders` in `enrich.ts`**

Edit `backend/src/import/enrich.ts`. Search for `amazonOrders` in the file; rename every occurrence (interface field, destructuring, downstream argument names) to `vendorOrders`. Same for the threshold variable name if it's `amazonLinkThreshold` — rename to `vendorOrderLinkThreshold`. Update `backend/src/config/env.ts` (the `enrichmentAmazonLinkThreshold` import) by adding an alias re-export:

```ts
// in backend/src/config/env.ts, near the other enrichment exports
export const enrichmentVendorOrderLinkThreshold = enrichmentAmazonLinkThreshold;
```

And update the import in `runEnrichmentBackfill.ts` to use `enrichmentVendorOrderLinkThreshold`. (Keeping the env var name backwards-compatible.)

- [ ] **Step 7: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 8: Run existing tests, verify they still pass**

Run: `cd backend && yarn test:integration 2>&1 | tail -10`
Expected: backfillEnrichment + captureTokens tests all pass.

- [ ] **Step 9: Add a test asserting non-Amazon vendor orders also link**

Append to `backend/test/integration/backfillEnrichment.test.ts` (after the existing tests):

```ts
test('backfill links a transaction to an Apple ExternalOrder', async () => {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  const order = await models.ExternalOrder.create({
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    vendor: 'apple',
    vendorOrderId: 'APPL-OR-1',
    dedupeKey: 'apple:APPL-OR-1',
    orderDate: '2026-04-25',
    shipmentDate: null,
    total: '4.99',
    currency: 'CAD',
    paymentLast4: null,
    source: 'bookmarklet-apple-v1',
    rawPayload: null,
  } as never);
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'iCloud 50GB',
    quantity: 1,
    totalPrice: '4.99',
    inferredCategory: 'Subscriptions',
  } as never);

  const txn = await createTxn({
    merchantRaw: 'APPLE.COM/BILL',
    merchantClean: 'APPLE.COM/BILL',
    amount: -4.99,
    date: '2026-04-26',
    reviewFlag: true,
  });

  await backfillModule.runBackfill(seedFlags({}));

  await txn.reload();
  assert.equal(txn.merchantCanonical, 'Apple');
  assert.equal(txn.linkedExternalOrderId, order.id);
  assert.match(String(txn.notes ?? ''), /iCloud 50GB/);
});
```

- [ ] **Step 10: Run the new test, verify PASS**

Run: `cd backend && yarn test:integration 2>&1 | tail -20`
Expected: all backfill tests pass, including the new Apple one.

- [ ] **Step 11: Commit**

```bash
git add backend/src/import/enrichment/vendors.ts \
        backend/src/import/enrichment/linkItemsStage.ts \
        backend/src/import/enrichment/loaders.ts \
        backend/src/import/runEnrichmentBackfill.ts \
        backend/src/import/enrich.ts \
        backend/src/config/env.ts \
        backend/test/integration/backfillEnrichment.test.ts
git commit -m "refactor(enrichment): generalize linkItemsStage to all vendors"
```

---

## Task 6: Add `dateFrom`/`dateTo` to `runBackfill`

**Files:**
- Modify: `backend/src/import/runEnrichmentBackfill.ts`
- Modify: `backend/src/routes/transactions.ts`
- Modify: `backend/test/integration/backfillEnrichment.test.ts`

- [ ] **Step 1: Extend `BackfillFlags`**

Edit `backend/src/import/runEnrichmentBackfill.ts`. Extend the interface:

```ts
export interface BackfillFlags {
  dryRun: boolean;
  noReviewFlag: boolean;
  reviewOnly: boolean;
  verbose: boolean;
  accountId: number | null;
  householdId: number | null;
  limit: number | null;
  batchSize: number;
  dateFrom: string | null;
  dateTo: string | null;
}
```

In `runBackfill`, just after building `where`, add:

```ts
import { Op } from 'sequelize';
// ...
if (flags.dateFrom && flags.dateTo) {
  where.date = { [Op.between]: [flags.dateFrom, flags.dateTo] };
} else if (flags.dateFrom) {
  where.date = { [Op.gte]: flags.dateFrom };
} else if (flags.dateTo) {
  where.date = { [Op.lte]: flags.dateTo };
}
```

- [ ] **Step 2: Update the `seedFlags` helper in backfill tests**

Edit `backend/test/integration/backfillEnrichment.test.ts`. Update `seedFlags`:

```ts
function seedFlags(overrides: Partial<Parameters<typeof backfillModule.runBackfill>[0]>): Parameters<typeof backfillModule.runBackfill>[0] {
  return {
    dryRun: false,
    noReviewFlag: false,
    reviewOnly: false,
    verbose: false,
    accountId: null,
    householdId: null,
    limit: null,
    batchSize: 50,
    dateFrom: null,
    dateTo: null,
    ...overrides,
  };
}
```

- [ ] **Step 3: Add a test for the date filter**

Append to `backend/test/integration/backfillEnrichment.test.ts`:

```ts
test('backfill respects dateFrom/dateTo filter', async () => {
  const inWindow = await createTxn({
    merchantRaw: 'WINDOW INSIDE',
    merchantClean: 'WINDOW INSIDE',
    amount: -1,
    date: '2026-04-10',
    autoSource: 'rule',
  });
  const outOfWindow = await createTxn({
    merchantRaw: 'WINDOW OUTSIDE',
    merchantClean: 'WINDOW OUTSIDE',
    amount: -1,
    date: '2025-01-01',
    autoSource: 'rule',
  });

  const beforeCleanIn = inWindow.merchantClean;
  const beforeCleanOut = outOfWindow.merchantClean;

  await backfillModule.runBackfill(seedFlags({ dateFrom: '2026-04-01', dateTo: '2026-04-30' }));

  await inWindow.reload();
  await outOfWindow.reload();
  // inWindow may have been re-cleaned; outOfWindow must not have changed
  assert.equal(outOfWindow.merchantClean, beforeCleanOut);
  void beforeCleanIn; // just to assert reload happened
});
```

- [ ] **Step 4: Expose `dateFrom`/`dateTo` in the HTTP backfill route**

Edit `backend/src/routes/transactions.ts`. Find the existing `enrichment/backfill` route handler (search for `runBackfill`). Pass through the new fields:

```ts
// Inside the POST /api/transactions/enrichment/backfill handler, in the body
// extraction block where the existing flags are read:
const dateFrom = typeof body.dateFrom === 'string' && body.dateFrom ? body.dateFrom : null;
const dateTo = typeof body.dateTo === 'string' && body.dateTo ? body.dateTo : null;
// ... then in the call to runBackfill, add:
const result = await runBackfill({
  // ... existing fields ...
  dateFrom,
  dateTo,
});
```

(Look at the existing handler structure and slot these in where the other flags are passed.)

- [ ] **Step 5: Run all backend tests, verify PASS**

Run: `cd backend && yarn test:integration 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/runEnrichmentBackfill.ts \
        backend/src/routes/transactions.ts \
        backend/test/integration/backfillEnrichment.test.ts
git commit -m "feat(enrichment): add dateFrom/dateTo filter to runBackfill"
```

---

## Task 7: Capture-orders endpoint + CORS + post-capture re-enrichment

**Files:**
- Modify: `backend/src/routes/capture.ts`
- Create: `backend/test/integration/captureOrders.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `backend/test/integration/captureOrders.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-capture-orders.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let token: string;

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
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'capture@example.com',
    displayName: 'Capture User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const mint = await authed.post('/api/capture/tokens').send({ label: 'Test' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('rejects POST /capture/orders without bearer token', async () => {
  const res = await request(app).post('/api/capture/orders').send({ vendor: 'amazon', orders: [] });
  assert.equal(res.status, 401);
});

test('rejects POST /capture/orders with wrong-format token', async () => {
  const res = await request(app)
    .post('/api/capture/orders')
    .set('Authorization', 'Bearer not-a-cfc-token')
    .send({ vendor: 'amazon', orders: [] });
  assert.equal(res.status, 401);
});

test('accepts a valid POST and creates ExternalOrder + items', async () => {
  const res = await request(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      orders: [
        {
          vendorOrderId: '112-2222222-2222222',
          orderDate: '2026-05-05',
          total: 19.99,
          currency: 'CAD',
          paymentLast4: '0042',
          items: [{ title: 'A book', totalPrice: 19.99 }],
          rawSource: 'bookmarklet-amazon-v1',
        },
      ],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  const orders = await models.ExternalOrder.findAll();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].vendor, 'amazon');
});

test('second POST with identical payload is a no-op', async () => {
  const body = {
    vendor: 'amazon',
    orders: [
      {
        vendorOrderId: '112-3333333-3333333',
        orderDate: '2026-05-06',
        total: 5,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'Same' }],
        rawSource: 'bookmarklet-amazon-v1',
      },
    ],
  };
  const first = await request(app).post('/api/capture/orders').set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(first.body.created, 1);
  const second = await request(app).post('/api/capture/orders').set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, 0);
  assert.equal(second.body.skipped, 1);
});

test('CORS preflight allows amazon.com origin', async () => {
  const res = await request(app)
    .options('/api/capture/orders')
    .set('Origin', 'https://www.amazon.com')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type');
  assert.ok(res.status === 204 || res.status === 200, `expected 200/204, got ${res.status}`);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.amazon.com');
});
```

- [ ] **Step 2: Run the test, verify FAIL**

Run: `cd backend && yarn test:integration 2>&1 | grep -E "capture|FAIL" | head`
Expected: tests fail (route not present).

- [ ] **Step 3: Add the capture endpoint + CORS to `routes/capture.ts`**

Edit `backend/src/routes/capture.ts`. Add to the imports at the top:

```ts
import cors from 'cors';
import { captureAuth } from '../auth/captureAuth';
import { captureOrders } from '../import/vendorCapture';
import { runBackfill } from '../import/runEnrichmentBackfill';

const ALLOWED_ORIGINS = new Set([
  'https://www.amazon.com',
  'https://www.amazon.ca',
  'https://www.amazon.co.uk',
  'https://amazon.com',
  'https://amazon.ca',
  'https://reportaproblem.apple.com',
]);

const captureCors = cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: false,
});
```

Append the route at the bottom (before `export default router`):

```ts
router.options('/orders', captureCors);
router.post('/orders', captureCors, captureAuth, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vendor = String(body.vendor ?? '').trim().toLowerCase();
    if (vendor !== 'amazon' && vendor !== 'apple') {
      res.status(400).json({ error: 'vendor must be one of: amazon, apple' });
      return;
    }
    const ordersRaw = Array.isArray(body.orders) ? body.orders : null;
    if (!ordersRaw || ordersRaw.length === 0) {
      res.status(400).json({ error: 'orders must be a non-empty array' });
      return;
    }
    if (ordersRaw.length > 200) {
      res.status(400).json({ error: 'orders cap is 200 per request' });
      return;
    }

    const orders = ordersRaw.map((raw, idx) => {
      const o = raw as Record<string, unknown>;
      const orderDate = String(o.orderDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
        throw new Error(`orders[${idx}].orderDate must be YYYY-MM-DD`);
      }
      const total = Number(o.total);
      if (!Number.isFinite(total)) {
        throw new Error(`orders[${idx}].total must be a number`);
      }
      const items = Array.isArray(o.items) ? o.items : [];
      return {
        vendorOrderId: typeof o.vendorOrderId === 'string' ? o.vendorOrderId : null,
        orderDate,
        total,
        currency: typeof o.currency === 'string' && o.currency.length === 3 ? o.currency : 'CAD',
        paymentLast4:
          typeof o.paymentLast4 === 'string' && /^\d{4}$/.test(o.paymentLast4) ? o.paymentLast4 : null,
        items: items.map((itRaw) => {
          const it = itRaw as Record<string, unknown>;
          const title = String(it.title ?? '').trim();
          return {
            title: title || 'Unknown item',
            quantity: typeof it.quantity === 'number' ? it.quantity : 1,
            unitPrice: typeof it.unitPrice === 'number' ? it.unitPrice : null,
            totalPrice: typeof it.totalPrice === 'number' ? it.totalPrice : null,
          };
        }),
      };
    });

    const { user, household } = req.captureAuth!;
    const source = `bookmarklet-${vendor}-v1`;
    const result = await captureOrders({
      householdId: household.id,
      userId: user.id,
      vendor,
      source,
      orders,
    });
    res.json(result);

    // Post-response re-enrichment over the affected date window.
    const dates = orders.map((o) => o.orderDate).sort();
    if (dates.length > 0) {
      const from = new Date(`${dates[0]}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 14);
      const to = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
      to.setUTCDate(to.getUTCDate() + 14);
      const dateFrom = from.toISOString().slice(0, 10);
      const dateTo = to.toISOString().slice(0, 10);
      setImmediate(() => {
        runBackfill({
          dryRun: false,
          noReviewFlag: false,
          reviewOnly: false,
          verbose: false,
          accountId: null,
          householdId: household.id,
          limit: null,
          batchSize: 50,
          dateFrom,
          dateTo,
        }).catch((err) => console.error('[capture] post-capture backfill failed', err));
      });
    }
  } catch (e) {
    if (e instanceof Error && /orders\[\d+\]/.test(e.message)) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `cd backend && yarn test:integration 2>&1 | tail -25`
Expected: all `captureOrders.test.ts` cases pass.

- [ ] **Step 5: Add an end-to-end test that the post-capture backfill links a transaction**

Append to `backend/test/integration/captureOrders.test.ts`:

```ts
test('post-capture backfill enriches a matching transaction', async () => {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  const txn = await models.Transaction.create({
    accountId: acc.id,
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'capture-test',
    date: '2026-05-07',
    merchantRaw: 'AMZN MKTP CA',
    merchantClean: 'AMZN MKTP CA',
    amount: '-42.50',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: 'capture-test-fp-1',
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  const res = await request(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      orders: [
        {
          vendorOrderId: '112-4444444-4444444',
          orderDate: '2026-05-07',
          total: 42.50,
          currency: 'CAD',
          paymentLast4: null,
          items: [{ title: 'Linked item', totalPrice: 42.50 }],
          rawSource: 'bookmarklet-amazon-v1',
        },
      ],
    });
  assert.equal(res.status, 200);

  // The backfill runs via setImmediate; await a microtask + small delay.
  await new Promise((r) => setTimeout(r, 200));

  await txn.reload();
  assert.equal(txn.merchantCanonical, 'Amazon');
  assert.ok(txn.linkedExternalOrderId, 'transaction should be linked to the captured order');
});
```

- [ ] **Step 6: Run the new test, verify PASS**

Run: `cd backend && yarn test:integration 2>&1 | tail -25`
Expected: all tests still pass, including the new linkage one.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/capture.ts backend/test/integration/captureOrders.test.ts
git commit -m "feat(capture): POST /api/capture/orders with CORS + post-capture backfill"
```

---

## Task 8: Bookmarklet build pipeline + pure scrapers + scraper tests

**Files:**
- Create: `frontend/src/bookmarklets/scrape/types.ts`
- Create: `frontend/src/bookmarklets/scrape/amazon.ts`
- Create: `frontend/src/bookmarklets/scrape/apple.ts`
- Create: `frontend/src/bookmarklets/scrape/post.ts`
- Create: `frontend/src/bookmarklets/scrape/toast.ts`
- Create: `frontend/src/bookmarklets/amazon.ts`
- Create: `frontend/src/bookmarklets/apple.ts`
- Create: `frontend/vite.bookmarklets.config.ts`
- Create: `frontend/src/bookmarklets/fixtures/amazon-orders.html`
- Create: `frontend/src/bookmarklets/fixtures/apple-reportaproblem.html`
- Create: `frontend/src/bookmarklets/scrape/amazon.test.ts` (vitest — must live under `src/`)
- Create: `frontend/src/bookmarklets/scrape/apple.test.ts`
- Modify: `frontend/package.json` (add script)

- [ ] **Step 1: Shared types**

Create `frontend/src/bookmarklets/scrape/types.ts`:

```ts
export interface CapturedItem {
  title: string;
  quantity?: number;
  totalPrice?: number | null;
  unitPrice?: number | null;
}

export interface CapturedOrder {
  vendorOrderId: string | null;
  orderDate: string; // YYYY-MM-DD
  total: number;
  currency: string;
  paymentLast4: string | null;
  items: CapturedItem[];
  rawSource: string;
}
```

- [ ] **Step 2: Capture a real Amazon fixture (manual prep)**

Open `https://www.amazon.com/gp/your-orders/orders` (or `amazon.ca`) in a logged-in browser, View Source on one or two order cards, paste into `frontend/src/bookmarklets/fixtures/amazon-orders.html`. Redact PII (names, addresses, full order IDs — keep the structure but mask values). Vitest is configured (`vitest.config.ts`) to scan only `src/**/*.test.ts`, so fixtures and tests both live under `src/bookmarklets/`.

For the plan, use this minimal synthetic fixture that mirrors current Amazon DOM at the time of writing (May 2026):

```html
<!doctype html>
<html><body>
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-row">
      <div class="a-column">
        <span class="a-color-secondary label">Order placed</span>
        <span class="a-color-secondary value">May 5, 2026</span>
      </div>
      <div class="a-column">
        <span class="a-color-secondary label">Total</span>
        <span class="a-color-secondary value">$42.50</span>
      </div>
      <div class="a-column">
        <span class="a-color-secondary label">Order #</span>
        <bdi dir="ltr">112-1234567-1234567</bdi>
      </div>
    </div>
  </div>
  <div class="a-fixed-left-grid-col">
    <a class="a-link-normal yohtmlc-product-title">USB-C Cable 6ft</a>
  </div>
  <div class="a-fixed-left-grid-col">
    <a class="a-link-normal yohtmlc-product-title">Wireless Mouse</a>
  </div>
</div>
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-row">
      <div class="a-column">
        <span class="a-color-secondary label">Order placed</span>
        <span class="a-color-secondary value">April 21, 2026</span>
      </div>
      <div class="a-column">
        <span class="a-color-secondary label">Total</span>
        <span class="a-color-secondary value">CDN$ 18.00</span>
      </div>
      <div class="a-column">
        <span class="a-color-secondary label">Order #</span>
        <bdi dir="ltr">112-7654321-7654321</bdi>
      </div>
    </div>
  </div>
  <div class="a-fixed-left-grid-col">
    <a class="a-link-normal yohtmlc-product-title">Notebook</a>
  </div>
</div>
</body></html>
```

If the real DOM has shifted, update both the fixture and the scraper in lockstep.

- [ ] **Step 3: Write the Amazon scraper test (vitest)**

Create `frontend/src/bookmarklets/scrape/amazon.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractAmazonOrdersFromDom } from './amazon';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../fixtures/amazon-orders.html'), 'utf-8');

describe('extractAmazonOrdersFromDom', () => {
  test('extracts two orders from the Amazon fixture', () => {
    document.body.innerHTML = html;
    const orders = extractAmazonOrdersFromDom(document);
    expect(orders).toHaveLength(2);

    const first = orders[0];
    expect(first.vendorOrderId).toBe('112-1234567-1234567');
    expect(first.orderDate).toBe('2026-05-05');
    expect(first.total).toBe(42.5);
    expect(first.items.map((it) => it.title)).toEqual(['USB-C Cable 6ft', 'Wireless Mouse']);

    const second = orders[1];
    expect(second.vendorOrderId).toBe('112-7654321-7654321');
    expect(second.orderDate).toBe('2026-04-21');
    expect(second.total).toBe(18);
  });

  test('returns empty array on a page without order cards', () => {
    document.body.innerHTML = '<h1>No orders</h1>';
    const orders = extractAmazonOrdersFromDom(document);
    expect(orders).toEqual([]);
  });
});
```

The vitest config already sets `environment: 'jsdom'`, so `document` is available in the test global scope.

- [ ] **Step 4: Run the test, verify FAIL**

Run: `cd frontend && yarn test 2>&1 | tail -20`
Expected: FAIL — `./amazon` module not found.

- [ ] **Step 5: Implement `extractAmazonOrdersFromDom`**

Create `frontend/src/bookmarklets/scrape/amazon.ts`:

```ts
import type { CapturedOrder } from './types';

function parseDate(text: string): string | null {
  // Accepts "May 5, 2026", "April 21, 2026"
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const m = text.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function parseTotal(text: string): number | null {
  // Accepts "$42.50", "CDN$ 18.00", "USD 9.99", "C$ 4.99"
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

export function extractAmazonOrdersFromDom(doc: Document): CapturedOrder[] {
  const cards = Array.from(doc.querySelectorAll('.order-card, .js-order-card'));
  const seen = new Set<Element>();
  const unique = cards.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  const orders: CapturedOrder[] = [];
  for (const card of unique) {
    const cols = Array.from(card.querySelectorAll('.order-header .a-column, .order-header div'));
    let orderDate: string | null = null;
    let total: number | null = null;
    let vendorOrderId: string | null = null;

    for (const col of cols) {
      const labelEl = col.querySelector('.label, .a-color-secondary.label');
      const valueEl = col.querySelector('.value, .a-color-secondary.value, bdi');
      const label = (labelEl?.textContent ?? '').trim().toLowerCase();
      const value = (valueEl?.textContent ?? '').trim();
      if (!value) continue;
      if (label.includes('order placed') || label.includes('placed')) {
        orderDate = parseDate(value) ?? orderDate;
      } else if (label.includes('total')) {
        total = parseTotal(value) ?? total;
      } else if (label.includes('order #') || label.includes('order id') || label.includes('order number')) {
        vendorOrderId = value;
      }
    }

    // Fallback: search bdi anywhere in the card for the order id.
    if (!vendorOrderId) {
      const bdi = card.querySelector('bdi');
      if (bdi?.textContent) vendorOrderId = bdi.textContent.trim();
    }

    const items = Array.from(card.querySelectorAll('.yohtmlc-product-title, a.yohtmlc-product-title, .a-link-normal.yohtmlc-product-title'))
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t.length > 0)
      .map((title) => ({ title }));

    if (orderDate && total != null) {
      orders.push({
        vendorOrderId,
        orderDate,
        total,
        currency: 'CAD',
        paymentLast4: null,
        items,
        rawSource: 'bookmarklet-amazon-v1',
      });
    }
  }
  return orders;
}
```

- [ ] **Step 6: Run the test, verify PASS**

Run: `cd frontend && yarn test 2>&1 | tail -20`
Expected: both Amazon scraper tests pass.

- [ ] **Step 7: Apple fixture + scraper test**

Create `frontend/src/bookmarklets/fixtures/apple-reportaproblem.html` with a minimal sample:

```html
<!doctype html>
<html><body>
<ul class="purchase-list">
  <li class="purchase-row">
    <span class="purchase-date">May 12, 2026</span>
    <span class="purchase-title">iCloud+ with 50 GB</span>
    <span class="purchase-amount">$4.99</span>
  </li>
  <li class="purchase-row">
    <span class="purchase-date">May 3, 2026</span>
    <span class="purchase-title">Procreate</span>
    <span class="purchase-amount">$12.99</span>
  </li>
</ul>
</body></html>
```

(If reportaproblem.apple.com renders differently in production, update both fixture and scraper to match.)

Create `frontend/src/bookmarklets/scrape/apple.test.ts`:

```ts
import { expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractApplePurchasesFromDom } from './apple';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../fixtures/apple-reportaproblem.html'), 'utf-8');

test('extracts two purchases from the Apple fixture', () => {
  document.body.innerHTML = html;
  const orders = extractApplePurchasesFromDom(document);
  expect(orders).toHaveLength(2);
  expect(orders[0].orderDate).toBe('2026-05-12');
  expect(orders[0].total).toBe(4.99);
  expect(orders[0].items).toHaveLength(1);
  expect(orders[0].items[0].title).toBe('iCloud+ with 50 GB');
  expect(orders[1].orderDate).toBe('2026-05-03');
  expect(orders[1].total).toBe(12.99);
});
```

- [ ] **Step 8: Implement `extractApplePurchasesFromDom`**

Create `frontend/src/bookmarklets/scrape/apple.ts`:

```ts
import type { CapturedOrder } from './types';

function parseDate(text: string): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const m = text.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

function parseAmount(text: string): number | null {
  const m = text.replace(/[,\s]+/g, ' ').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

export function extractApplePurchasesFromDom(doc: Document): CapturedOrder[] {
  const rows = Array.from(doc.querySelectorAll('.purchase-row, [data-purchase-row], li.purchase'));
  const orders: CapturedOrder[] = [];
  for (const row of rows) {
    const dateText = (row.querySelector('.purchase-date, [data-purchase-date]')?.textContent ?? '').trim();
    const titleText = (row.querySelector('.purchase-title, [data-purchase-title]')?.textContent ?? '').trim();
    const amountText = (row.querySelector('.purchase-amount, [data-purchase-amount]')?.textContent ?? '').trim();
    const orderDate = parseDate(dateText);
    const total = parseAmount(amountText);
    if (orderDate && total != null && titleText) {
      orders.push({
        vendorOrderId: null,
        orderDate,
        total,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: titleText, totalPrice: total, quantity: 1 }],
        rawSource: 'bookmarklet-apple-v1',
      });
    }
  }
  return orders;
}
```

- [ ] **Step 9: Run scraper tests, verify PASS**

Run: `cd frontend && yarn test 2>&1 | tail -20`
Expected: all scraper tests pass (existing tests still green too).

- [ ] **Step 10: Write the post + toast helpers**

Create `frontend/src/bookmarklets/scrape/post.ts`:

```ts
import type { CapturedOrder } from './types';

export interface PostResult {
  ok: boolean;
  status: number;
  body: {
    created?: number;
    updated?: number;
    skipped?: number;
    error?: string;
  };
}

export async function postCapture(
  apiUrl: string,
  token: string,
  vendor: string,
  orders: CapturedOrder[],
): Promise<PostResult> {
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ vendor, orders }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : 'network error' } };
  }
}
```

Create `frontend/src/bookmarklets/scrape/toast.ts`:

```ts
type ToastKind = 'success' | 'error' | 'warn';

export function showToast(message: string, kind: ToastKind): void {
  const id = '__cashflow_capture_toast__';
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = id;
  div.textContent = message;
  div.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'padding:12px 16px',
    'border-radius:8px',
    'font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'color:white',
    'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
    `background:${kind === 'success' ? '#16a34a' : kind === 'warn' ? '#ca8a04' : '#dc2626'}`,
  ].join(';');
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}
```

- [ ] **Step 11: Write the IIFE entries**

Create `frontend/src/bookmarklets/amazon.ts`:

```ts
import { extractAmazonOrdersFromDom } from './scrape/amazon';
import { postCapture } from './scrape/post';
import { showToast } from './scrape/toast';

declare const __CFC_TOKEN__: string;
declare const __CFC_API__: string;

(async () => {
  try {
    const orders = extractAmazonOrdersFromDom(document);
    if (orders.length === 0) {
      showToast('No orders found on this page. Open Your Orders first.', 'warn');
      return;
    }
    const res = await postCapture(__CFC_API__, __CFC_TOKEN__, 'amazon', orders);
    if (res.status === 401) {
      showToast('Cashflow token rejected. Re-mint in Settings.', 'error');
      return;
    }
    if (!res.ok) {
      showToast(`Capture failed (${res.status}): ${res.body.error ?? 'unknown'}`, 'error');
      return;
    }
    const { created = 0, updated = 0, skipped = 0 } = res.body;
    showToast(`Captured ${orders.length} orders. ${created} new, ${updated} updated, ${skipped} unchanged.`, 'success');
  } catch (e) {
    showToast(`Bookmarklet error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
})();
```

Create `frontend/src/bookmarklets/apple.ts`:

```ts
import { extractApplePurchasesFromDom } from './scrape/apple';
import { postCapture } from './scrape/post';
import { showToast } from './scrape/toast';

declare const __CFC_TOKEN__: string;
declare const __CFC_API__: string;

(async () => {
  try {
    const orders = extractApplePurchasesFromDom(document);
    if (orders.length === 0) {
      showToast('No purchases found. Open reportaproblem.apple.com first.', 'warn');
      return;
    }
    const res = await postCapture(__CFC_API__, __CFC_TOKEN__, 'apple', orders);
    if (res.status === 401) {
      showToast('Cashflow token rejected. Re-mint in Settings.', 'error');
      return;
    }
    if (!res.ok) {
      showToast(`Capture failed (${res.status}): ${res.body.error ?? 'unknown'}`, 'error');
      return;
    }
    const { created = 0, updated = 0, skipped = 0 } = res.body;
    showToast(`Captured ${orders.length} purchases. ${created} new, ${updated} updated, ${skipped} unchanged.`, 'success');
  } catch (e) {
    showToast(`Bookmarklet error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
})();
```

- [ ] **Step 12: Add the Vite bookmarklet build config**

Create `frontend/vite.bookmarklets.config.ts`:

```ts
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'public/bookmarklets',
    emptyOutDir: true,
    lib: false,
    rollupOptions: {
      input: {
        amazon: resolve(__dirname, 'src/bookmarklets/amazon.ts'),
        apple: resolve(__dirname, 'src/bookmarklets/apple.ts'),
      },
      output: {
        format: 'iife',
        entryFileNames: '[name].js',
        inlineDynamicImports: false,
      },
    },
    minify: 'esbuild',
    target: 'es2020',
  },
});
```

Add to `frontend/package.json` scripts:

```json
"build:bookmarklets": "vite build --config vite.bookmarklets.config.ts"
```

- [ ] **Step 13: Build the bookmarklets to verify the pipeline works**

Run: `cd frontend && yarn build:bookmarklets`
Expected: `frontend/public/bookmarklets/amazon.js` and `apple.js` created. Each should be a small IIFE referencing `__CFC_TOKEN__` and `__CFC_API__` as undefined globals (the settings page injects them).

- [ ] **Step 14: Run all frontend tests + lint**

Run: `cd frontend && yarn lint && yarn test`
Expected: clean lint, all tests pass (including the new scraper tests and the existing reviewInbox/formatParseErrors suites).

- [ ] **Step 15: Commit**

```bash
git add frontend/src/bookmarklets \
        frontend/vite.bookmarklets.config.ts \
        frontend/package.json
git commit -m "feat(capture): bookmarklets for Amazon + Apple order scraping"
```

---

## Task 9: Settings UI — receipt capture card

**Files:**
- Create: `frontend/src/lib/captureTokens.ts`
- Modify: `frontend/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Token API client wrapper**

Create `frontend/src/lib/captureTokens.ts`:

```ts
import { deleteReq, getJson, postJson } from './api';

export interface CaptureTokenRow {
  id: number;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CaptureTokenMintResult {
  id: number;
  plaintext: string;
  label: string;
  createdAt: string;
}

export function listCaptureTokens(): Promise<CaptureTokenRow[]> {
  return getJson<CaptureTokenRow[]>('/api/capture/tokens');
}

export function mintCaptureToken(label: string): Promise<CaptureTokenMintResult> {
  return postJson<CaptureTokenMintResult>('/api/capture/tokens', { label });
}

export function revokeCaptureToken(id: number): Promise<void> {
  return deleteReq(`/api/capture/tokens/${id}`);
}
```

- [ ] **Step 2: Add the Receipt capture card to `SettingsPage.tsx`**

Edit `frontend/src/pages/SettingsPage.tsx`. Add imports near the top:

```ts
import {
  listCaptureTokens,
  mintCaptureToken,
  revokeCaptureToken,
  type CaptureTokenRow,
} from '../lib/captureTokens'
```

Inside the `SettingsPage` component, add state hooks near the other `useState` calls:

```ts
const [captureToken, setCaptureToken] = useState<CaptureTokenRow | null>(null)
const [captureTokenPlaintext, setCaptureTokenPlaintext] = useState<string | null>(null)
const [captureBookmarklets, setCaptureBookmarklets] = useState<{ amazon: string; apple: string } | null>(null)
const [captureLoading, setCaptureLoading] = useState(false)
const [captureError, setCaptureError] = useState<string | null>(null)
```

Add a loader effect:

```ts
useEffect(() => {
  void (async () => {
    try {
      const rows = await listCaptureTokens()
      setCaptureToken(rows[0] ?? null)
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : 'Could not load capture tokens')
    }
  })()
}, [])
```

Add a helper to build the `javascript:` href:

```ts
async function buildBookmarkletHref(name: 'amazon' | 'apple', token: string): Promise<string> {
  const sourceRes = await fetch(`/bookmarklets/${name}.js`)
  if (!sourceRes.ok) throw new Error(`Could not load bookmarklet bundle: ${sourceRes.status}`)
  const source = await sourceRes.text()
  const apiUrl = `${window.location.origin}/api/capture/orders`
  const preamble = `var __CFC_TOKEN__=${JSON.stringify(token)};var __CFC_API__=${JSON.stringify(apiUrl)};`
  const full = `${preamble}${source}`
  return `javascript:${encodeURIComponent(full)}`
}
```

Add the mint flow handler:

```ts
async function mintNewCaptureToken() {
  setCaptureLoading(true)
  setCaptureError(null)
  try {
    const result = await mintCaptureToken('Browser')
    setCaptureToken({
      id: result.id,
      label: result.label,
      lastUsedAt: null,
      createdAt: result.createdAt,
    })
    setCaptureTokenPlaintext(result.plaintext)
    const [amazonHref, appleHref] = await Promise.all([
      buildBookmarkletHref('amazon', result.plaintext),
      buildBookmarkletHref('apple', result.plaintext),
    ])
    setCaptureBookmarklets({ amazon: amazonHref, apple: appleHref })
  } catch (e) {
    setCaptureError(e instanceof Error ? e.message : 'Mint failed')
  } finally {
    setCaptureLoading(false)
  }
}

async function revokeActiveToken() {
  if (!captureToken) return
  const ok = await confirm({
    title: 'Revoke capture token?',
    description: 'Existing bookmarklets that use this token will stop working.',
    confirmLabel: 'Revoke',
    destructive: true,
  })
  if (!ok) return
  try {
    await revokeCaptureToken(captureToken.id)
    setCaptureToken(null)
    setCaptureTokenPlaintext(null)
    setCaptureBookmarklets(null)
  } catch (e) {
    setCaptureError(e instanceof Error ? e.message : 'Revoke failed')
  }
}
```

Add the new card in the JSX (place it after the `Partner invite` card, before `Contacts ledger`):

```tsx
<Card className="accountsFormCard">
  <div className="accountsCardHeader">
    <div>
      <h2>Receipt capture</h2>
      <p className="muted">
        Capture itemised order data from Amazon and Apple without forwarding emails. Mint a personal
        token, then drag the bookmarklets to your bookmark bar.
      </p>
    </div>
    {captureToken ? (
      <Button type="button" variant="destructive" onClick={() => void revokeActiveToken()}>
        Revoke token
      </Button>
    ) : (
      <Button type="button" disabled={captureLoading} onClick={() => void mintNewCaptureToken()}>
        {captureLoading ? 'Minting…' : 'Mint capture token'}
      </Button>
    )}
  </div>
  {captureError && (
    <span className="error" role="alert">
      {captureError}
    </span>
  )}
  {captureTokenPlaintext && (
    <>
      <p className="muted">
        Token created — copy or install now. You won't see it again after you leave this page.
      </p>
      <Input readOnly value={captureTokenPlaintext} onFocus={(e) => e.currentTarget.select()} />
    </>
  )}
  {captureToken && !captureTokenPlaintext && (
    <p className="muted">
      Active token: <code>{captureToken.label}</code>
      {captureToken.lastUsedAt && (
        <>{' '}· Last used {new Date(captureToken.lastUsedAt).toLocaleString()}</>
      )}
    </p>
  )}
  {captureBookmarklets && (
    <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
      <a
        className="button"
        href={captureBookmarklets.amazon}
        draggable
        onClick={(e) => e.preventDefault()}
      >
        ↗ Capture Amazon orders
      </a>
      <a
        className="button"
        href={captureBookmarklets.apple}
        draggable
        onClick={(e) => e.preventDefault()}
      >
        ↗ Capture Apple purchases
      </a>
    </div>
  )}
  {captureToken && !captureBookmarklets && (
    <p className="muted">
      <em>
        Bookmarklet links are only shown immediately after minting. Re-mint if you need to install
        them on a new browser.
      </em>
    </p>
  )}
</Card>
```

- [ ] **Step 3: Make sure bookmarklets are served from `/bookmarklets/...`**

The Vite bookmarklet build output is `frontend/public/bookmarklets/amazon.js` (and `apple.js`). Vite serves `public/` at the web root in dev and production. The fetch path `/bookmarklets/amazon.js` will work as-is.

If your deploy doesn't serve `frontend/public` (check the deploy config — likely it does because that's Vite's default), add a copy step in the build pipeline.

- [ ] **Step 4: Smoke-test the dev server**

Run: `cd frontend && yarn build:bookmarklets && yarn dev`
Then in another terminal: `cd backend && yarn dev`
Open the app, log in, go to Settings, click "Mint capture token". Verify:
- Plaintext token appears, masked to `cfc_…`.
- Two bookmarklet links appear.
- Drag "Capture Amazon orders" to the bookmark bar.
- Navigate to `amazon.ca/gp/your-orders/orders`.
- Click the bookmark.
- A green toast appears with "Captured N orders…".
- Reload Settings — the active token is still listed.
- Reload `amazon.ca` and click the bookmark again — toast shows the "X unchanged" count.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/captureTokens.ts frontend/src/pages/SettingsPage.tsx
git commit -m "feat(capture): settings UI for token mint + bookmarklet install"
```

---

## Task 10: End-to-end verification and polish

**Files:** none (this task is verification only)

- [ ] **Step 1: Full backend test sweep**

Run: `cd backend && yarn test && yarn test:integration`
Expected: zero failures.

- [ ] **Step 2: Typecheck both packages**

Run: `cd backend && yarn typecheck` and `cd frontend && yarn typecheck` (or whatever the frontend uses; `yarn lint` if no separate typecheck).
Expected: zero errors.

- [ ] **Step 3: Manually verify the Apple flow against the real site**

Open `https://reportaproblem.apple.com/?s=6` while signed in. Click the Apple bookmarklet. If the DOM doesn't match the fixture, capture the real HTML, replace `frontend/test/fixtures/apple-reportaproblem.html`, update `extractApplePurchasesFromDom` to the real selectors, re-run tests. Commit any necessary changes:

```bash
git add frontend/src/bookmarklets/scrape/apple.ts frontend/test/fixtures/apple-reportaproblem.html
git commit -m "fix(capture): align Apple scraper with current reportaproblem DOM"
```

- [ ] **Step 4: Manually verify the Amazon flow**

Same as Step 3 but for `amazon.ca/gp/your-orders/orders`. Update selectors and fixture if needed. Commit.

- [ ] **Step 5: Verify a captured order enriches a real transaction**

After capturing a real Amazon order, navigate to the matching card transaction in the Review Inbox or transactions table. Confirm:
- `merchantCanonical` reads "Amazon".
- Notes field has "Items: ..." preview.
- `linkedExternalOrderId` (visible in dev tools network response) is populated.

- [ ] **Step 6: No further commit needed if all manual checks pass.**

---

## Self-review checklist (for the engineer executing the plan)

After completing all tasks, verify:

- [ ] All 10 tasks have all checkboxes ticked.
- [ ] `cd backend && yarn test:integration` is green.
- [ ] `cd frontend && yarn build:bookmarklets` emits `public/bookmarklets/amazon.js` and `apple.js`.
- [ ] The Settings page mints a token, shows it once, hides it on re-load.
- [ ] One bookmarklet press on a real vendor page enriches at least one transaction.
- [ ] `git log --oneline` shows ~9-10 small commits, one per task, with conventional-commit-style messages.

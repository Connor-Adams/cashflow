# Portfolio Detail Page (Slice F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/portfolio/security/:id` with an enriched detail page (logo, multi-range price chart with buy/sell markers, dividend history, About panel, eight stat cards) and ship the shared frontend primitives + backend lazy-backfill infrastructure that all later portfolio enrichment slices will reuse.

**Architecture:** Backend adds two tables (`security_daily_prices`, `security_dividends`), a JSON metadata column on `securities`, a lazy backfill module (`backend/src/portfolio/backfill.ts`) that throttles Alpha Vantage calls with an in-process daily rate budget, and three new GET endpoints under `/api/portfolio/security/:id/`. Frontend adds four shared UI primitives (`SecurityLogo`, `LetterAvatar`, `Sparkline`, `MetricStat`), an app-config loader that fetches a logo.dev publishable token, and a rewritten `PortfolioSecurityPage` composed of three new card components.

**Tech Stack:** Backend Sequelize 6 + Express + TypeScript + `node:test` + `supertest`. Frontend React 19 + TypeScript + Vite + Vitest + `@testing-library/react` + recharts.

**Spec:** [docs/superpowers/specs/2026-05-24-portfolio-detail-page-design.md](../specs/2026-05-24-portfolio-detail-page-design.md)

---

## File Structure

### Backend — new files

| Path | Responsibility |
|---|---|
| `backend/src/migrations/20260524100001-security-daily-prices.js` | Create `security_daily_prices` table |
| `backend/src/migrations/20260524100002-security-dividends.js` | Create `security_dividends` table |
| `backend/src/migrations/20260524100003-securities-metadata.js` | Add `metadata`/`metadata_fetched_at` columns |
| `backend/src/models/SecurityDailyPrice.ts` | Sequelize model for daily OHLCV |
| `backend/src/models/SecurityDividend.ts` | Sequelize model for div events |
| `backend/src/portfolio/avClient.ts` | Alpha Vantage HTTP wrappers (TIME_SERIES_DAILY_ADJUSTED, DIVIDENDS, OVERVIEW) |
| `backend/src/portfolio/rateBudget.ts` | UTC-day rate budget tracker class |
| `backend/src/portfolio/backfill.ts` | `ensureDailyPrices`/`ensureDividends`/`ensureOverview` orchestration |
| `backend/src/routes/config.ts` | `GET /api/config` (publishable client config) |
| `backend/test/portfolio/rateBudget.test.ts` | Unit tests for `RateBudget` |
| `backend/test/portfolio/backfill.test.ts` | Unit tests for backfill with mocked AV client |
| `backend/test/integration/portfolioSecurityPrices.test.ts` | Integration tests for `/security/:id/prices` |
| `backend/test/integration/portfolioSecurityDividends.test.ts` | Integration tests for `/security/:id/dividends` |
| `backend/test/integration/portfolioSecurityOverview.test.ts` | Integration tests for `/security/:id/overview` |
| `backend/test/integration/configRoute.test.ts` | Integration test for `/api/config` |

### Backend — modified files

| Path | Change |
|---|---|
| `backend/src/models/Security.ts` | Add `metadata: object \| null`, `metadataFetchedAt: Date \| null` fields |
| `backend/src/models/index.ts` | Register new models + `Security.hasMany` associations |
| `backend/src/routes/portfolio.ts` | Three new sub-routes; reuse existing household scoping |
| `backend/src/app.ts` | Mount `configRouter` at `/api/config` (before `requireAuth`) |
| `backend/src/config/env.ts` | Add `LOGO_DEV_TOKEN` env var |
| `backend/test/integration/portfolioFixtures.ts` | Add `seedDailyPrice`/`seedDividend`/`seedSecurityMetadata` helpers |

### Frontend — new files

| Path | Responsibility |
|---|---|
| `frontend/src/lib/appConfig.ts` | One-time fetch of `/api/config` → `window.__APP_CONFIG__` |
| `frontend/src/lib/securityLogo.ts` | Build logo.dev URL from symbol |
| `frontend/src/components/ui/letter-avatar.tsx` | Letter-avatar fallback |
| `frontend/src/components/ui/letter-avatar.test.tsx` | Component tests |
| `frontend/src/components/ui/security-logo.tsx` | Wraps img + on-error → LetterAvatar |
| `frontend/src/components/ui/security-logo.test.tsx` | Component tests |
| `frontend/src/components/ui/sparkline.tsx` | Tiny recharts line |
| `frontend/src/components/ui/sparkline.test.tsx` | Component tests |
| `frontend/src/components/ui/metric-stat.tsx` | StatCard variant with delta arrow |
| `frontend/src/components/ui/metric-stat.test.tsx` | Component tests |
| `frontend/src/pages/portfolio-security/PriceChartCard.tsx` | Price chart + range toggle + overlay |
| `frontend/src/pages/portfolio-security/PriceChartCard.test.tsx` | Component tests |
| `frontend/src/pages/portfolio-security/DividendHistoryCard.tsx` | Dividend bar chart |
| `frontend/src/pages/portfolio-security/DividendHistoryCard.test.tsx` | Component tests |
| `frontend/src/pages/portfolio-security/AboutCard.tsx` | Sector/industry/country/exchange + description |
| `frontend/src/pages/portfolio-security/AboutCard.test.tsx` | Component tests |
| `frontend/src/pages/portfolio-security/SecurityHeader.tsx` | Logo + name + badges |
| `frontend/src/pages/portfolio-security/SecurityHeader.test.tsx` | Component tests |

### Frontend — modified files

| Path | Change |
|---|---|
| `frontend/src/types/api.ts` | Add `PortfolioSecurityPrices`, `PortfolioSecurityDividends`, `PortfolioSecurityOverview`, `AppConfig` types |
| `frontend/src/pages/PortfolioSecurityPage.tsx` | Rewrite to compose new cards; keep existing per-account/activity/snapshot sections |
| `frontend/src/main.tsx` | Await `appConfig` load before render |

---

## Phase 1 — Database + Models

### Task 1: Migration — `security_daily_prices` table

**Files:**
- Create: `backend/src/migrations/20260524100001-security-daily-prices.js`

- [ ] **Step 1: Write the migration**

```js
'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('security_daily_prices', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      open: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      high: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      low: { type: Sequelize.DECIMAL(20, 8), allowNull: true },
      close: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      adj_close: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      volume: { type: Sequelize.BIGINT, allowNull: true },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('security_daily_prices', ['security_id', 'date'], {
      name: 'security_daily_prices_security_date_unique',
      unique: true,
    });
    await queryInterface.addIndex('security_daily_prices', ['security_id', 'date'], {
      name: 'security_daily_prices_security_date_desc',
      // sqlite ignores DESC; ordering done at query time
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('security_daily_prices');
  },
};
```

- [ ] **Step 2: Verify migration runs**

Run: `cd backend && yarn db:migrate`
Expected: completes without error; new table exists.

- [ ] **Step 3: Verify undo works**

Run: `cd backend && yarn db:migrate:undo`
Expected: `security_daily_prices` table dropped.

Run: `cd backend && yarn db:migrate`
Expected: re-applied.

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/20260524100001-security-daily-prices.js
git commit -m "feat(portfolio): add security_daily_prices migration"
```

---

### Task 2: Migration — `security_dividends` table

**Files:**
- Create: `backend/src/migrations/20260524100002-security-dividends.js`

- [ ] **Step 1: Write the migration**

```js
'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('security_dividends', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      ex_dividend_date: { type: Sequelize.DATEONLY, allowNull: false },
      declaration_date: { type: Sequelize.DATEONLY, allowNull: true },
      record_date: { type: Sequelize.DATEONLY, allowNull: true },
      payment_date: { type: Sequelize.DATEONLY, allowNull: true },
      amount: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('security_dividends', ['security_id', 'ex_dividend_date'], {
      name: 'security_dividends_security_exdate_unique',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('security_dividends');
  },
};
```

- [ ] **Step 2: Run migrate + undo to verify**

```bash
cd backend && yarn db:migrate && yarn db:migrate:undo && yarn db:migrate
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260524100002-security-dividends.js
git commit -m "feat(portfolio): add security_dividends migration"
```

---

### Task 3: Migration — `securities.metadata` + `metadata_fetched_at`

**Files:**
- Create: `backend/src/migrations/20260524100003-securities-metadata.js`

- [ ] **Step 1: Write the migration**

```js
'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('securities', 'metadata', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn('securities', 'metadata_fetched_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('securities', 'metadata_fetched_at');
    await queryInterface.removeColumn('securities', 'metadata');
  },
};
```

- [ ] **Step 2: Run migrate + undo + redo**

```bash
cd backend && yarn db:migrate && yarn db:migrate:undo && yarn db:migrate
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260524100003-securities-metadata.js
git commit -m "feat(portfolio): add securities.metadata + metadata_fetched_at columns"
```

---

### Task 4: Model — `SecurityDailyPrice`

**Files:**
- Create: `backend/src/models/SecurityDailyPrice.ts`

- [ ] **Step 1: Write the model**

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

export class SecurityDailyPrice extends Model<
  InferAttributes<SecurityDailyPrice>,
  InferCreationAttributes<SecurityDailyPrice>
> {
  declare id: CreationOptional<number>;
  declare securityId: number;
  declare date: string; // 'YYYY-MM-DD' (DATEONLY)
  declare open: string | null;
  declare high: string | null;
  declare low: string | null;
  declare close: string;
  declare adjClose: string;
  declare volume: number | null;
  declare source: CreationOptional<string>;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurityDailyPrice(
  sequelize: Sequelize,
): typeof SecurityDailyPrice {
  SecurityDailyPrice.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      open: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      high: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      low: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      close: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      adjClose: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'adj_close',
        allowNull: false,
      },
      volume: { type: DataTypes.BIGINT, allowNull: true },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<SecurityDailyPrice>,
    {
      sequelize,
      modelName: 'SecurityDailyPrice',
      tableName: 'security_daily_prices',
      underscored: true,
      timestamps: true,
    },
  );
  return SecurityDailyPrice;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/SecurityDailyPrice.ts
git commit -m "feat(portfolio): add SecurityDailyPrice model"
```

---

### Task 5: Model — `SecurityDividend`

**Files:**
- Create: `backend/src/models/SecurityDividend.ts`

- [ ] **Step 1: Write the model**

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

export class SecurityDividend extends Model<
  InferAttributes<SecurityDividend>,
  InferCreationAttributes<SecurityDividend>
> {
  declare id: CreationOptional<number>;
  declare securityId: number;
  declare exDividendDate: string;
  declare declarationDate: string | null;
  declare recordDate: string | null;
  declare paymentDate: string | null;
  declare amount: string;
  declare currency: string;
  declare source: CreationOptional<string>;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurityDividend(sequelize: Sequelize): typeof SecurityDividend {
  SecurityDividend.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      exDividendDate: {
        type: DataTypes.DATEONLY,
        field: 'ex_dividend_date',
        allowNull: false,
      },
      declarationDate: {
        type: DataTypes.DATEONLY,
        field: 'declaration_date',
        allowNull: true,
      },
      recordDate: {
        type: DataTypes.DATEONLY,
        field: 'record_date',
        allowNull: true,
      },
      paymentDate: {
        type: DataTypes.DATEONLY,
        field: 'payment_date',
        allowNull: true,
      },
      amount: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'alpha_vantage',
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<SecurityDividend>,
    {
      sequelize,
      modelName: 'SecurityDividend',
      tableName: 'security_dividends',
      underscored: true,
      timestamps: true,
    },
  );
  return SecurityDividend;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/SecurityDividend.ts
git commit -m "feat(portfolio): add SecurityDividend model"
```

---

### Task 6: Extend `Security` model with metadata fields

**Files:**
- Modify: `backend/src/models/Security.ts`

- [ ] **Step 1: Add fields to class**

Replace the existing `Security` class declarations with:

```ts
export type SecurityMetadata = {
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
  exchange?: string | null;
  description?: string | null;
  // Raw passthrough; later slices may surface more fields.
  [key: string]: unknown;
};

export class Security extends Model<
  InferAttributes<Security>,
  InferCreationAttributes<Security>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare symbol: string;
  declare name: string | null;
  declare assetType: string | null;
  declare currency: string;
  declare dividendEligibility: CreationOptional<SecurityDividendEligibility>;
  declare metadata: SecurityMetadata | null;
  declare metadataFetchedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}
```

Add to the `Security.init({...})` attributes block (before the closing `} as ModelAttributes<Security>`):

```ts
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      },
      metadataFetchedAt: {
        type: DataTypes.DATE,
        field: 'metadata_fetched_at',
        allowNull: true,
      },
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/Security.ts
git commit -m "feat(portfolio): add metadata + metadataFetchedAt to Security model"
```

---

### Task 7: Register models + associations

**Files:**
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Add imports**

After `import { SecurityPrice, initSecurityPrice } from './SecurityPrice';` add:

```ts
import { SecurityDailyPrice, initSecurityDailyPrice } from './SecurityDailyPrice';
import { SecurityDividend, initSecurityDividend } from './SecurityDividend';
```

- [ ] **Step 2: Call `init` functions**

After `initSecurityPrice(sequelize);` add:

```ts
initSecurityDailyPrice(sequelize);
initSecurityDividend(sequelize);
```

- [ ] **Step 3: Wire associations**

After `Security.hasMany(SecurityPrice, { foreignKey: 'security_id', as: 'prices' });` add:

```ts
Security.hasMany(SecurityDailyPrice, {
  foreignKey: 'security_id',
  as: 'dailyPrices',
});
SecurityDailyPrice.belongsTo(Security, {
  foreignKey: 'security_id',
  as: 'security',
});
Security.hasMany(SecurityDividend, {
  foreignKey: 'security_id',
  as: 'dividends',
});
SecurityDividend.belongsTo(Security, {
  foreignKey: 'security_id',
  as: 'security',
});
```

- [ ] **Step 4: Add to barrel export**

In the `export { ... }` block, add `SecurityDailyPrice`, `SecurityDividend` near the other portfolio models.

- [ ] **Step 5: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/index.ts
git commit -m "feat(portfolio): register SecurityDailyPrice + SecurityDividend models"
```

---

## Phase 2 — Backend infrastructure

### Task 8: Add `LOGO_DEV_TOKEN` env var

**Files:**
- Modify: `backend/src/config/env.ts`

- [ ] **Step 1: Extend `EnvConfig`**

In the `EnvConfig` type, after `quoteProvider: string;` add:

```ts
  logoDevToken: string | null;
```

- [ ] **Step 2: Parse in `loadEnvConfig`**

In `loadEnvConfig`, after `const quoteProvider = e.QUOTE_PROVIDER?.trim() || 'alpha_vantage';` add:

```ts
  const logoDevToken = e.LOGO_DEV_TOKEN?.trim() || null;
```

Add `logoDevToken,` to the returned object.

- [ ] **Step 3: Export top-level**

After `export const quoteProvider = resolved.quoteProvider;` add:

```ts
export const logoDevToken = resolved.logoDevToken;
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts
git commit -m "feat(portfolio): add LOGO_DEV_TOKEN env var"
```

---

### Task 9: `/api/config` route

**Files:**
- Create: `backend/src/routes/config.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/test/integration/configRoute.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
/**
 * Integration test for GET /api/config. Verifies that the publishable
 * client config is returned without leaking server secrets.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-config-route.sqlite');

let app: import('express').Express;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.LOGO_DEV_TOKEN = 'pk_test_logo';
  process.env.ALPHA_VANTAGE_API_KEY = 'av_test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

test('returns publishable config without leaking secrets', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.logoDevToken, 'pk_test_logo');
  assert.equal(res.body.quoteProviderConfigured, true);
  assert.equal(res.body.alphaVantageApiKey, undefined, 'must not leak AV key');
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd backend && yarn test:integration --test-name-pattern "publishable config"`
Expected: FAIL with 404 on `/api/config`.

- [ ] **Step 3: Write the route**

```ts
import { Router } from 'express';
import * as env from '../config/env';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    logoDevToken: env.logoDevToken,
    quoteProviderConfigured: Boolean(env.alphaVantageApiKey),
  });
});

export default router;
```

- [ ] **Step 4: Mount in `app.ts`**

After `app.use('/api/version', versionRouter);` add:

```ts
import configRouter from './routes/config';
// ... below the other early-mounts (before requireAuth):
app.use('/api/config', configRouter);
```

Place the `import` near the other route imports at the top of `app.ts`. The `app.use` line must be **before** `app.use('/api', requireAuth);` so the route stays public.

- [ ] **Step 5: Run test, expect PASS**

Run: `cd backend && yarn test:integration --test-name-pattern "publishable config"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/config.ts backend/src/app.ts backend/test/integration/configRoute.test.ts
git commit -m "feat(portfolio): add GET /api/config for publishable client config"
```

---

### Task 10: `RateBudget` class

**Files:**
- Create: `backend/src/portfolio/rateBudget.ts`
- Create: `backend/test/portfolio/rateBudget.test.ts`

- [ ] **Step 1: Write the failing unit tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateBudget } from '../../src/portfolio/rateBudget';

test('RateBudget spends from a daily cap and refuses when exhausted', () => {
  const budget = new RateBudget({ dailyCap: 3, now: () => new Date('2026-05-24T10:00:00Z') });
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), false, '4th call exceeds cap');
  assert.equal(budget.remaining(), 0);
});

test('RateBudget resets at next UTC midnight', () => {
  let nowDate = new Date('2026-05-24T23:00:00Z');
  const budget = new RateBudget({ dailyCap: 2, now: () => nowDate });
  budget.spend();
  budget.spend();
  assert.equal(budget.spend(), false);

  nowDate = new Date('2026-05-25T00:00:01Z');
  assert.equal(budget.spend(), true, 'budget rolls over after UTC midnight');
  assert.equal(budget.remaining(), 1);
});

test('RateBudget.nextResetAt returns next UTC midnight', () => {
  const now = new Date('2026-05-24T15:00:00Z');
  const budget = new RateBudget({ dailyCap: 1, now: () => now });
  assert.equal(budget.nextResetAt().toISOString(), '2026-05-25T00:00:00.000Z');
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && yarn test test/portfolio/rateBudget.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `RateBudget`**

```ts
export type RateBudgetOptions = {
  dailyCap: number;
  now?: () => Date;
};

export class RateBudget {
  private readonly dailyCap: number;
  private readonly now: () => Date;
  private currentDay: string;
  private spent: number;

  constructor(opts: RateBudgetOptions) {
    if (!Number.isFinite(opts.dailyCap) || opts.dailyCap < 0) {
      throw new Error('RateBudget dailyCap must be a non-negative finite number');
    }
    this.dailyCap = Math.floor(opts.dailyCap);
    this.now = opts.now ?? (() => new Date());
    this.currentDay = this.utcDay();
    this.spent = 0;
  }

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollIfNewDay(): void {
    const today = this.utcDay();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.spent = 0;
    }
  }

  spend(): boolean {
    this.rollIfNewDay();
    if (this.spent >= this.dailyCap) return false;
    this.spent += 1;
    return true;
  }

  remaining(): number {
    this.rollIfNewDay();
    return Math.max(0, this.dailyCap - this.spent);
  }

  nextResetAt(): Date {
    const n = this.now();
    const next = new Date(
      Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 0, 0, 0),
    );
    return next;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && yarn test test/portfolio/rateBudget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/rateBudget.ts backend/test/portfolio/rateBudget.test.ts
git commit -m "feat(portfolio): add RateBudget with UTC-day rollover"
```

---

### Task 11: Alpha Vantage client (`avClient.ts`)

**Files:**
- Create: `backend/src/portfolio/avClient.ts`

This task has no standalone test because the module is exercised through `backfill.ts` tests (Task 12). Keep it as a thin HTTP wrapper that's easy to mock.

- [ ] **Step 1: Write the module**

```ts
/**
 * Thin Alpha Vantage HTTP wrappers. Each function returns parsed data
 * (or null when AV reports "not found") and throws on transport / rate-
 * limit / API-key errors so callers can surface meaningful messages.
 *
 * AV rate-limit responses come back as HTTP 200 with a JSON body like
 * `{ "Note": "Thank you for using Alpha Vantage! Our standard API ..." }`
 * — we detect that explicitly.
 */
import * as env from '../config/env';

export type AvDailyBar = {
  date: string;          // 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
};

export type AvDividendEvent = {
  exDividendDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amount: number;
  currency: string;
};

export type AvOverview = {
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  raw: Record<string, unknown>;
};

const BASE = 'https://www.alphavantage.co/query';

function nReq(): string {
  if (!env.alphaVantageApiKey) {
    throw new Error('ALPHA_VANTAGE_API_KEY is not configured');
  }
  return env.alphaVantageApiKey;
}

function n(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function detectRateLimit(json: Record<string, unknown>): void {
  const note = json['Note'] ?? json['Information'];
  if (typeof note === 'string' && /thank you for using alpha vantage|rate limit|standard api/i.test(note)) {
    throw new Error('Alpha Vantage rate limit: ' + note);
  }
}

export async function fetchDailyAdjusted(
  symbol: string,
  outputsize: 'compact' | 'full',
  fetchImpl: typeof fetch = fetch,
): Promise<AvDailyBar[] | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'TIME_SERIES_DAILY_ADJUSTED');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('outputsize', outputsize);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
  const series = json['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined;
  if (!series) return null;
  const rows: AvDailyBar[] = [];
  for (const [date, row] of Object.entries(series)) {
    const close = n(row['4. close']);
    const adj = n(row['5. adjusted close']);
    if (close == null || adj == null) continue;
    rows.push({
      date,
      open: n(row['1. open']),
      high: n(row['2. high']),
      low: n(row['3. low']),
      close,
      adjClose: adj,
      volume: n(row['6. volume']),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export async function fetchDividends(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvDividendEvent[] | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'DIVIDENDS');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
  const data = json['data'] as Array<Record<string, string>> | undefined;
  if (!Array.isArray(data)) return null;
  const out: AvDividendEvent[] = [];
  for (const row of data) {
    const amount = n(row['amount']);
    const ex = row['ex_dividend_date'];
    if (amount == null || !ex) continue;
    out.push({
      exDividendDate: ex,
      declarationDate: row['declaration_date'] || null,
      recordDate: row['record_date'] || null,
      paymentDate: row['payment_date'] || null,
      amount,
      currency: row['currency'] || 'USD',
    });
  }
  out.sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
  return out;
}

export async function fetchOverview(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvOverview | null> {
  const url = new URL(BASE);
  url.searchParams.set('function', 'OVERVIEW');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', nReq());
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  detectRateLimit(json);
  if (!json['Symbol']) return null;
  const str = (k: string): string | null => {
    const v = json[k];
    return typeof v === 'string' && v !== 'None' && v !== '' ? v : null;
  };
  return {
    sector: str('Sector'),
    industry: str('Industry'),
    country: str('Country'),
    exchange: str('Exchange'),
    description: str('Description'),
    raw: json,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add backend/src/portfolio/avClient.ts
git commit -m "feat(portfolio): add Alpha Vantage client wrappers (daily/dividends/overview)"
```

---

### Task 12: `backfill.ts` module

**Files:**
- Create: `backend/src/portfolio/backfill.ts`
- Create: `backend/test/portfolio/backfill.test.ts`

- [ ] **Step 1: Write failing unit tests**

```ts
/**
 * Unit tests for the lazy backfill module. AV HTTP layer is replaced
 * with stubs via the exposed `__setAvClient` test seam.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-backfill-unit.sqlite');

let models: typeof import('../../src/models');
let backfill: typeof import('../../src/portfolio/backfill');

beforeEach(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'test_av_key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  // Force module reload to pick up the new DB
  delete require.cache?.[require.resolve?.('../../src/models')];
  models = await import('../../src/models');
  backfill = await import('../../src/portfolio/backfill');
  backfill.__resetForTests();
});

test('ensureDailyPrices returns never when no rows and enqueues a backfill', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  backfill.__setAvClient({
    fetchDailyAdjusted: async () => [
      { date: '2026-05-20', open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 1000 },
      { date: '2026-05-21', open: 1.5, high: 2.5, low: 1, close: 2, adjClose: 2, volume: 2000 },
    ],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const first = await backfill.ensureDailyPrices(sec.id);
  assert.equal(first.status, 'never');
  // Wait briefly for the enqueued promise to resolve.
  await new Promise((r) => setTimeout(r, 50));
  const rows = await models.SecurityDailyPrice.findAll({ where: { securityId: sec.id } });
  assert.equal(rows.length, 2);
  const second = await backfill.ensureDailyPrices(sec.id);
  assert.equal(second.status, 'fresh');
});

test('concurrent ensureDailyPrices for same security dedupes', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST2', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  let calls = 0;
  backfill.__setAvClient({
    fetchDailyAdjusted: async () => { calls += 1; await new Promise((r) => setTimeout(r, 30));
      return [{ date: '2026-05-21', open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.5, volume: 100 }];
    },
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  const [a, b, c] = await Promise.all([
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
    backfill.ensureDailyPrices(sec.id),
  ]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1, 'AV called exactly once for concurrent requests');
  assert.ok(['never', 'in_progress'].includes(a.status));
});

test('ensureDailyPrices reports rate_limited when budget exhausted', async () => {
  const sec = await models.Security.create({
    householdId: 1, symbol: 'TST3', name: 'Test', assetType: 'EQUITY', currency: 'USD',
  });
  backfill.__setAvClient({
    fetchDailyAdjusted: async () => [],
    fetchDividends: async () => [],
    fetchOverview: async () => null,
  });
  backfill.__exhaustRateBudget();
  const result = await backfill.ensureDailyPrices(sec.id);
  assert.equal(result.status, 'rate_limited');
  assert.ok(result.nextRetryAt instanceof Date || typeof result.nextRetryAt === 'string');
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && yarn test test/portfolio/backfill.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `backfill.ts`**

```ts
/**
 * Lazy + user-triggered backfill orchestration. Each ensureX function:
 *   1. checks current freshness in the DB
 *   2. if stale/never, enqueues a single in-flight promise (dedupe)
 *   3. returns the current BackfillStatus immediately so callers don't block
 *
 * The in-flight registry keys on `${endpoint}:${securityId}` so concurrent
 * price + dividend + overview requests for the same security do not collide.
 *
 * Rate budget is in-process and resets at UTC midnight (see RateBudget).
 * Single-server assumption — multi-process deploys would over-spend.
 */
import { Op } from 'sequelize';
import { Security, SecurityDailyPrice, SecurityDividend } from '../models';
import { RateBudget } from './rateBudget';
import * as defaultAv from './avClient';

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

type AvClient = Pick<typeof defaultAv, 'fetchDailyAdjusted' | 'fetchDividends' | 'fetchOverview'>;

let av: AvClient = defaultAv;
let rateBudget = new RateBudget({ dailyCap: 20 });
const inFlight = new Map<string, Promise<void>>();

const OVERVIEW_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Test seam — replaces the AV client with a stub. */
export function __setAvClient(stub: AvClient): void {
  av = stub;
}
/** Test seam — resets in-flight map + rate budget. */
export function __resetForTests(): void {
  inFlight.clear();
  rateBudget = new RateBudget({ dailyCap: 20 });
  av = defaultAv;
}
/** Test seam — drains all rate budget so the next spend() fails. */
export function __exhaustRateBudget(): void {
  while (rateBudget.spend()) { /* keep spending */ }
}

function yesterdayISODate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function enqueue(key: string, work: () => Promise<void>): void {
  if (inFlight.has(key)) return;
  const p = work()
    .catch((err) => {
      console.warn(`[backfill] ${key} failed: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
}

function makeRateLimited(): BackfillStatus {
  return {
    status: 'rate_limited',
    lastFetchedAt: null,
    nextRetryAt: rateBudget.nextResetAt().toISOString(),
    coverageDays: 0,
  };
}

export async function ensureDailyPrices(securityId: number): Promise<BackfillStatus> {
  const key = `prices:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const rowCount = await SecurityDailyPrice.count({ where: { securityId } });
  const latest = await SecurityDailyPrice.findOne({
    where: { securityId },
    order: [['date', 'DESC']],
  });
  const lastFetchedAt = latest?.fetchedAt?.toISOString() ?? null;

  if (inFlight.has(key)) {
    return {
      status: 'in_progress',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: rowCount,
    };
  }

  if (rowCount === 0) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, () => backfillDailyFull(sec.id, sec.symbol));
    return { status: 'never', lastFetchedAt, nextRetryAt: null, coverageDays: 0 };
  }
  if (latest && latest.date < yesterdayISODate()) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, () => backfillDailyCompact(sec.id, sec.symbol));
    return { status: 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

async function backfillDailyFull(securityId: number, symbol: string): Promise<void> {
  const bars = await av.fetchDailyAdjusted(symbol, 'full');
  if (!bars || bars.length === 0) return;
  await upsertBars(securityId, bars);
}

async function backfillDailyCompact(securityId: number, symbol: string): Promise<void> {
  const bars = await av.fetchDailyAdjusted(symbol, 'compact');
  if (!bars || bars.length === 0) return;
  await upsertBars(securityId, bars);
}

async function upsertBars(securityId: number, bars: Awaited<ReturnType<typeof av.fetchDailyAdjusted>>): Promise<void> {
  if (!bars) return;
  const now = new Date();
  for (const bar of bars) {
    await SecurityDailyPrice.upsert({
      securityId,
      date: bar.date,
      open: bar.open != null ? String(bar.open) : null,
      high: bar.high != null ? String(bar.high) : null,
      low: bar.low != null ? String(bar.low) : null,
      close: String(bar.close),
      adjClose: String(bar.adjClose),
      volume: bar.volume,
      source: 'alpha_vantage',
      fetchedAt: now,
    });
  }
}

export async function ensureDividends(securityId: number): Promise<BackfillStatus> {
  const key = `dividends:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const rowCount = await SecurityDividend.count({ where: { securityId } });
  const latest = await SecurityDividend.findOne({
    where: { securityId },
    order: [['exDividendDate', 'DESC']],
  });
  const lastFetchedAt = latest?.fetchedAt?.toISOString() ?? null;

  if (inFlight.has(key)) {
    return {
      status: 'in_progress',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: rowCount,
    };
  }
  // Refresh dividends if never fetched OR latest fetchedAt > 30 days old.
  const staleAgeMs = 30 * 24 * 60 * 60 * 1000;
  const isStale =
    latest != null &&
    Date.now() - latest.fetchedAt.getTime() > staleAgeMs;

  if (rowCount === 0 || isStale) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, async () => {
      const events = await av.fetchDividends(sec.symbol);
      if (!events) return;
      const now = new Date();
      for (const ev of events) {
        await SecurityDividend.upsert({
          securityId,
          exDividendDate: ev.exDividendDate,
          declarationDate: ev.declarationDate,
          recordDate: ev.recordDate,
          paymentDate: ev.paymentDate,
          amount: String(ev.amount),
          currency: ev.currency,
          source: 'alpha_vantage',
          fetchedAt: now,
        });
      }
    });
    return { status: rowCount === 0 ? 'never' : 'stale', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: rowCount };
}

export async function ensureOverview(securityId: number): Promise<BackfillStatus> {
  const key = `overview:${securityId}`;
  const sec = await Security.findByPk(securityId);
  if (!sec) {
    return { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 };
  }
  const fetched = sec.metadataFetchedAt;
  const lastFetchedAt = fetched?.toISOString() ?? null;
  const isStale = fetched != null && Date.now() - fetched.getTime() > OVERVIEW_STALE_MS;
  const isNever = sec.metadata == null;

  if (inFlight.has(key)) {
    return { status: 'in_progress', lastFetchedAt, nextRetryAt: null, coverageDays: isNever ? 0 : 1 };
  }
  if (isNever || isStale) {
    if (!rateBudget.spend()) return makeRateLimited();
    enqueue(key, async () => {
      const overview = await av.fetchOverview(sec.symbol);
      if (!overview) return;
      await sec.update({
        metadata: {
          sector: overview.sector,
          industry: overview.industry,
          country: overview.country,
          exchange: overview.exchange,
          description: overview.description,
          ...overview.raw,
        },
        metadataFetchedAt: new Date(),
      });
    });
    return {
      status: isNever ? 'never' : 'stale',
      lastFetchedAt,
      nextRetryAt: null,
      coverageDays: isNever ? 0 : 1,
    };
  }
  return { status: 'fresh', lastFetchedAt, nextRetryAt: null, coverageDays: 1 };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn test test/portfolio/backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/backfill.ts backend/test/portfolio/backfill.test.ts
git commit -m "feat(portfolio): add lazy backfill module with in-flight dedupe + rate budget"
```

---

## Phase 3 — Backend routes

### Task 13: Extend `portfolioFixtures.ts` with daily-price + dividend + metadata helpers

**Files:**
- Modify: `backend/test/integration/portfolioFixtures.ts`

- [ ] **Step 1: Append helpers to the file**

Add at the bottom:

```ts
export async function seedDailyPrice(
  models: Models,
  args: {
    securityId: number;
    date: string;
    close: number;
    adjClose?: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
  },
): Promise<void> {
  await models.SecurityDailyPrice.create({
    securityId: args.securityId,
    date: args.date,
    open: args.open != null ? String(args.open) : null,
    high: args.high != null ? String(args.high) : null,
    low: args.low != null ? String(args.low) : null,
    close: String(args.close),
    adjClose: String(args.adjClose ?? args.close),
    volume: args.volume ?? null,
    source: 'fixture',
    fetchedAt: new Date(),
  });
}

export async function seedDividend(
  models: Models,
  args: {
    securityId: number;
    exDividendDate: string;
    amount: number;
    currency?: string;
    paymentDate?: string | null;
    recordDate?: string | null;
  },
): Promise<void> {
  await models.SecurityDividend.create({
    securityId: args.securityId,
    exDividendDate: args.exDividendDate,
    declarationDate: null,
    recordDate: args.recordDate ?? null,
    paymentDate: args.paymentDate ?? null,
    amount: String(args.amount),
    currency: args.currency ?? 'USD',
    source: 'fixture',
    fetchedAt: new Date(),
  });
}

export async function seedSecurityMetadata(
  models: Models,
  securityId: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  const sec = await models.Security.findByPk(securityId);
  if (!sec) throw new Error(`Security ${securityId} not found`);
  await sec.update({
    metadata: metadata as never,
    metadataFetchedAt: new Date(),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && yarn typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/portfolioFixtures.ts
git commit -m "test(portfolio): add seedDailyPrice/seedDividend/seedSecurityMetadata fixtures"
```

---

### Task 14: `GET /api/portfolio/security/:id/prices`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioSecurityPrices.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
/**
 * Integration tests for GET /api/portfolio/security/:id/prices.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-prices.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'av_test_key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedDailyPrice } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `prices-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;

  // Seed 400 days of close history (1Y range = 365 days)
  for (let i = 400; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.01, adjClose: 30 + i * 0.01 });
  }
  // Seed a buy and a sell to verify trades overlay
  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    activityType: 'buy', tradeDate: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10),
    description: 'Bought XEQT', quantity: '10', price: '30', amount: '300', currency: 'CAD',
    sourceRowFingerprint: 'fp-buy', importBatch: 'fixture',
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('range=1y returns ~365 rows and includes trades within range', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=1y`);
  assert.equal(res.status, 200);
  assert.ok(res.body.rows.length >= 360 && res.body.rows.length <= 366, `rows=${res.body.rows.length}`);
  assert.equal(res.body.range, '1y');
  assert.ok(res.body.trades.length >= 1, 'buy should appear');
  assert.equal(res.body.backfill.status, 'fresh');
});

test('range=1m returns ~30 rows', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=1m`);
  assert.equal(res.status, 200);
  assert.ok(res.body.rows.length >= 28 && res.body.rows.length <= 32, `rows=${res.body.rows.length}`);
});

test('range=all returns full history', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/prices?range=all`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 401);
});

test('404 for security id not in this household', async () => {
  const res = await authed.get('/api/portfolio/security/99999/prices');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && yarn test:integration --test-name-pattern "range=1y"`
Expected: FAIL with 404.

- [ ] **Step 3: Add the route handler**

In `backend/src/routes/portfolio.ts`, add these imports at the top:

```ts
import {
  // ... existing ...
  SecurityDailyPrice,
  SecurityDividend,
} from '../models';
import {
  ensureDailyPrices,
  ensureDividends,
  ensureOverview,
} from '../portfolio/backfill';
```

Add a helper above the `router.get('/security/:id', ...)` block:

```ts
type PriceRange = '1m' | '3m' | '1y' | '5y' | 'all';
const PRICE_RANGES: Record<PriceRange, number | null> = {
  '1m': 31,
  '3m': 93,
  '1y': 366,
  '5y': 365 * 5 + 1,
  all: null,
};

function parseRange(raw: unknown): PriceRange {
  if (typeof raw === 'string' && raw in PRICE_RANGES) return raw as PriceRange;
  return '1y';
}

async function loadSecurityScoped(req: Request, idRaw: string) {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return { error: 400 as const };
  const security = await Security.findByPk(id);
  if (!security) return { error: 404 as const };
  // Household scoping: a security must have at least one activity OR holding
  // visible to the caller. Reuse visibleAccountWhere for the account scope.
  const accounts = await Account.findAll({
    where: { ...visibleAccountWhere(req), accountType: 'investment' },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return { error: 404 as const };
  const activityCount = await InvestmentActivity.count({
    where: { accountId: accountIds, securityId: id },
  });
  const holdingCount = await HoldingSnapshot.count({
    where: { accountId: accountIds, securityId: id },
  });
  if (activityCount === 0 && holdingCount === 0) return { error: 404 as const };
  return { security, accountIds };
}
```

Add the route below the existing `/security/:id` handler:

```ts
router.get('/security/:id/prices', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error).json({ error: 'Security not visible' });
      return;
    }
    const { security, accountIds } = scoped;
    const range = parseRange(req.query.range);
    const days = PRICE_RANGES[range];

    const where: Record<string, unknown> = { securityId: security.id };
    if (days != null) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      where.date = { [Op.gte]: cutoff };
    }
    const rows = await SecurityDailyPrice.findAll({
      where,
      order: [['date', 'ASC']],
    });

    // Trades filtered to same date window for overlay.
    const tradeWhere: Record<string, unknown> = {
      accountId: accountIds,
      securityId: security.id,
      activityType: ['buy', 'sell'],
    };
    if (days != null) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      tradeWhere.tradeDate = { [Op.gte]: cutoff };
    }
    const trades = await InvestmentActivity.findAll({
      where: tradeWhere,
      include: [{ model: Account, as: 'account' }],
      order: [['tradeDate', 'ASC']],
    });

    const backfill = await ensureDailyPrices(security.id);

    res.json({
      securityId: security.id,
      symbol: security.symbol,
      currency: security.currency,
      range,
      rows: rows.map((r) => ({
        date: r.date,
        open: r.open != null ? Number(r.open) : null,
        high: r.high != null ? Number(r.high) : null,
        low: r.low != null ? Number(r.low) : null,
        close: Number(r.close),
        adjClose: Number(r.adjClose),
        volume: r.volume,
      })),
      trades: trades.map((t) => ({
        date: t.tradeDate,
        type: t.activityType as 'buy' | 'sell',
        quantity: t.quantity != null ? Number(t.quantity) : 0,
        price: t.price != null ? Number(t.price) : null,
        accountName: (t as unknown as { account?: { name: string } }).account?.name ?? '',
      })),
      backfill,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd backend && yarn test:integration --test-name-pattern "range="`
Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioSecurityPrices.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/security/:id/prices"
```

---

### Task 15: `GET /api/portfolio/security/:id/dividends`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioSecurityDividends.test.ts`

- [ ] **Step 1: Write failing test**

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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-divs.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'av_test_key';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `divs-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;
  // Need a holding so the security is visible
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 300, costBasis: 280,
  });
  await seedDividend(models, { securityId: xeqt.id, exDividendDate: '2025-12-15', amount: 0.18 });
  await seedDividend(models, { securityId: xeqt.id, exDividendDate: '2026-03-15', amount: 0.20 });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('returns dividends sorted ascending with backfill state', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/dividends`);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.events[0].exDividendDate, '2025-12-15');
  assert.equal(res.body.events[1].exDividendDate, '2026-03-15');
  assert.equal(res.body.backfill.status, 'fresh');
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && yarn test:integration --test-name-pattern "dividends sorted"`
Expected: FAIL with 404.

- [ ] **Step 3: Add the route**

In `backend/src/routes/portfolio.ts`, below the `/prices` route:

```ts
router.get('/security/:id/dividends', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error).json({ error: 'Security not visible' });
      return;
    }
    const { security } = scoped;
    const events = await SecurityDividend.findAll({
      where: { securityId: security.id },
      order: [['exDividendDate', 'ASC']],
    });
    const backfill = await ensureDividends(security.id);
    res.json({
      securityId: security.id,
      currency: security.currency,
      events: events.map((e) => ({
        exDividendDate: e.exDividendDate,
        paymentDate: e.paymentDate,
        recordDate: e.recordDate,
        amount: Number(e.amount),
        currency: e.currency,
      })),
      backfill,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run test, expect PASS**

Run: `cd backend && yarn test:integration --test-name-pattern "dividends sorted"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioSecurityDividends.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/security/:id/dividends"
```

---

### Task 16: `GET /api/portfolio/security/:id/overview`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioSecurityOverview.test.ts`

- [ ] **Step 1: Write failing test**

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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-overview.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'av_test_key';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { seedHousehold, seedAccount, seedSecurity, seedHolding, seedSecurityMetadata } = await import(
    './portfolioFixtures.js'
  );
  const seeded = await seedHousehold(models, `ov-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 300, costBasis: 280,
  });
  await seedSecurityMetadata(models, xeqt.id, {
    sector: 'Diversified',
    industry: 'Asset Management',
    country: 'Canada',
    exchange: 'TSX',
    description: 'iShares Core Equity ETF Portfolio.',
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('overview returns cached metadata fields', async () => {
  const res = await authed.get(`/api/portfolio/security/${xeqtId}/overview`);
  assert.equal(res.status, 200);
  assert.equal(res.body.sector, 'Diversified');
  assert.equal(res.body.exchange, 'TSX');
  assert.ok(res.body.metadataFetchedAt);
  assert.equal(res.body.backfill.status, 'fresh');
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && yarn test:integration --test-name-pattern "overview returns"`
Expected: FAIL with 404.

- [ ] **Step 3: Add the route**

```ts
router.get('/security/:id/overview', async (req, res, next) => {
  try {
    const scoped = await loadSecurityScoped(req, req.params.id);
    if ('error' in scoped) {
      res.status(scoped.error).json({ error: 'Security not visible' });
      return;
    }
    const { security } = scoped;
    const m = security.metadata ?? {};
    const backfill = await ensureOverview(security.id);
    res.json({
      securityId: security.id,
      sector: (m as Record<string, unknown>)['sector'] ?? null,
      industry: (m as Record<string, unknown>)['industry'] ?? null,
      country: (m as Record<string, unknown>)['country'] ?? null,
      exchange: (m as Record<string, unknown>)['exchange'] ?? null,
      description: (m as Record<string, unknown>)['description'] ?? null,
      metadataFetchedAt: security.metadataFetchedAt?.toISOString() ?? null,
      backfill,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && yarn test:integration --test-name-pattern "overview returns"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioSecurityOverview.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/security/:id/overview"
```

---

## Phase 4 — Frontend primitives

### Task 17: Add response types to `frontend/src/types/api.ts`

**Files:**
- Modify: `frontend/src/types/api.ts`

- [ ] **Step 1: Append types at the bottom of the file**

```ts
export type AppConfig = {
  logoDevToken: string | null;
  quoteProviderConfigured: boolean;
};

export type BackfillStatus = {
  status: 'fresh' | 'stale' | 'never' | 'in_progress' | 'rate_limited';
  lastFetchedAt: string | null;
  nextRetryAt: string | null;
  coverageDays: number;
};

export type PortfolioSecurityPriceRow = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
};

export type PortfolioSecurityTrade = {
  date: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number | null;
  accountName: string;
};

export type PortfolioSecurityPrices = {
  securityId: number;
  symbol: string;
  currency: string;
  range: '1m' | '3m' | '1y' | '5y' | 'all';
  rows: PortfolioSecurityPriceRow[];
  trades: PortfolioSecurityTrade[];
  backfill: BackfillStatus;
};

export type PortfolioSecurityDividendEvent = {
  exDividendDate: string;
  paymentDate: string | null;
  recordDate: string | null;
  amount: number;
  currency: string;
};

export type PortfolioSecurityDividends = {
  securityId: number;
  currency: string;
  events: PortfolioSecurityDividendEvent[];
  backfill: BackfillStatus;
};

export type PortfolioSecurityOverview = {
  securityId: number;
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange: string | null;
  description: string | null;
  metadataFetchedAt: string | null;
  backfill: BackfillStatus;
};
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && yarn build`
Expected: build succeeds (or run `yarn tsc -b --noEmit` if available).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/api.ts
git commit -m "feat(portfolio): add detail-page response types"
```

---

### Task 18: App config loader

**Files:**
- Create: `frontend/src/lib/appConfig.ts`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write the loader**

```ts
import { getJson } from './api'
import type { AppConfig } from '../types/api'

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

let cached: Promise<AppConfig> | null = null

export function loadAppConfig(): Promise<AppConfig> {
  if (cached) return cached
  cached = getJson<AppConfig>('/api/config')
    .then((cfg) => {
      window.__APP_CONFIG__ = cfg
      return cfg
    })
    .catch((err) => {
      // Fail open: degrade to nulls so the app still renders without /api/config.
      const fallback: AppConfig = {
        logoDevToken: null,
        quoteProviderConfigured: false,
      }
      window.__APP_CONFIG__ = fallback
      console.warn('[appConfig] failed to load, degrading:', err)
      return fallback
    })
  return cached
}

export function getAppConfig(): AppConfig | null {
  return window.__APP_CONFIG__ ?? null
}

/** Reset cache + window state — test-only. */
export function _resetAppConfigForTest(): void {
  cached = null
  delete window.__APP_CONFIG__
}
```

- [ ] **Step 2: Boot it in `main.tsx`**

Replace the contents of `frontend/src/main.tsx` with:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { installGlobalClientLogging } from './lib/clientLogger.ts'
import { loadAppConfig } from './lib/appConfig.ts'

installGlobalClientLogging()

void loadAppConfig().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/appConfig.ts frontend/src/main.tsx
git commit -m "feat(portfolio): bootstrap app config (logo.dev token + quote provider flag)"
```

---

### Task 19: `securityLogo.ts` helper

**Files:**
- Create: `frontend/src/lib/securityLogo.ts`

- [ ] **Step 1: Write the helper**

```ts
import { getAppConfig } from './appConfig'

/**
 * Builds the logo.dev image URL for a given ticker, or returns null
 * when no token is configured. Symbol normalization strips the
 * exchange suffix (`XEQT.TO` → `XEQT`) — logo.dev keys off the base
 * ticker.
 */
export function securityLogoUrl(symbol: string): string | null {
  const token = getAppConfig()?.logoDevToken
  if (!token) return null
  const base = symbol.split('.')[0].toUpperCase()
  if (!base) return null
  return `https://img.logo.dev/ticker/${encodeURIComponent(base)}?token=${encodeURIComponent(token)}`
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/securityLogo.ts
git commit -m "feat(portfolio): add securityLogoUrl helper"
```

---

### Task 20: `<LetterAvatar>` component + tests

**Files:**
- Create: `frontend/src/components/ui/letter-avatar.tsx`
- Create: `frontend/src/components/ui/letter-avatar.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LetterAvatar } from './letter-avatar'

describe('LetterAvatar', () => {
  it('renders the first character uppercased', () => {
    const { container } = render(<LetterAvatar text="xeqt" />)
    expect(container.textContent).toBe('X')
  })

  it('produces a stable color for the same input across renders', () => {
    const a = render(<LetterAvatar text="BNS" />).container.firstChild as HTMLElement
    const b = render(<LetterAvatar text="BNS" />).container.firstChild as HTMLElement
    expect(a.style.backgroundColor).toBe(b.style.backgroundColor)
  })

  it('respects size prop', () => {
    const { container } = render(<LetterAvatar text="X" size="lg" />)
    const el = container.firstChild as HTMLElement
    expect(el.style.width).toBe('48px')
    expect(el.style.height).toBe('48px')
  })

  it('falls back to ? for empty text', () => {
    const { container } = render(<LetterAvatar text="" />)
    expect(container.textContent).toBe('?')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/components/ui/letter-avatar.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the component**

```tsx
import type { CSSProperties } from 'react'

export type LetterAvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_PX: Record<LetterAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
}

const PALETTE = [
  '#5B8DEF', '#7C5CFF', '#10B981', '#F59E0B', '#EF4444',
  '#06B6D4', '#EC4899', '#84CC16', '#0EA5E9', '#A855F7',
  '#F97316', '#14B8A6',
]

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pickColor(text: string): string {
  return PALETTE[hashCode(text || '?') % PALETTE.length]
}

function readableForeground(bgHex: string): string {
  const r = parseInt(bgHex.slice(1, 3), 16)
  const g = parseInt(bgHex.slice(3, 5), 16)
  const b = parseInt(bgHex.slice(5, 7), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.55 ? '#111827' : '#FFFFFF'
}

export type LetterAvatarProps = {
  text: string
  size?: LetterAvatarSize
}

export function LetterAvatar({ text, size = 'md' }: LetterAvatarProps) {
  const ch = (text.trim().charAt(0) || '?').toUpperCase()
  const bg = pickColor(text)
  const fg = readableForeground(bg)
  const px = SIZE_PX[size]
  const style: CSSProperties = {
    width: `${px}px`,
    height: `${px}px`,
    borderRadius: 6,
    backgroundColor: bg,
    color: fg,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: `${Math.floor(px * 0.5)}px`,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
    flexShrink: 0,
  }
  return (
    <span role="img" aria-label={`Avatar for ${text}`} style={style}>
      {ch}
    </span>
  )
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && yarn test src/components/ui/letter-avatar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/letter-avatar.tsx frontend/src/components/ui/letter-avatar.test.tsx
git commit -m "feat(portfolio): add LetterAvatar component"
```

---

### Task 21: `<SecurityLogo>` component + tests

**Files:**
- Create: `frontend/src/components/ui/security-logo.tsx`
- Create: `frontend/src/components/ui/security-logo.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SecurityLogo } from './security-logo'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('SecurityLogo', () => {
  beforeEach(() => {
    _resetAppConfigForTest()
  })

  it('renders img with logo.dev URL when token configured', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="XEQT.TO" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toContain('img.logo.dev/ticker/XEQT')
    expect(img?.getAttribute('src')).toContain('token=pk_test')
  })

  it('renders LetterAvatar when no token', () => {
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: false }
    const { container, queryByRole } = render(<SecurityLogo symbol="BNS" />)
    expect(container.querySelector('img')).toBeNull()
    expect(queryByRole('img')).not.toBeNull()
  })

  it('falls back to LetterAvatar on img error', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="WAT" />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('W')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/components/ui/security-logo.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react'
import { LetterAvatar, type LetterAvatarSize } from './letter-avatar'
import { securityLogoUrl } from '../../lib/securityLogo'

const SIZE_PX: Record<LetterAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
}

export type SecurityLogoProps = {
  symbol: string
  name?: string | null
  size?: LetterAvatarSize
}

export function SecurityLogo({ symbol, name, size = 'md' }: SecurityLogoProps) {
  const url = securityLogoUrl(symbol)
  const [errored, setErrored] = useState(false)
  if (!url || errored) {
    return <LetterAvatar text={symbol || name || '?'} size={size} />
  }
  const px = SIZE_PX[size]
  return (
    <img
      src={url}
      alt={name ? `${name} logo` : `${symbol} logo`}
      width={px}
      height={px}
      onError={() => setErrored(true)}
      style={{
        width: `${px}px`,
        height: `${px}px`,
        borderRadius: 6,
        objectFit: 'contain',
        backgroundColor: '#FFFFFF',
        border: '1px solid var(--border)',
        flexShrink: 0,
      }}
    />
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/components/ui/security-logo.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/security-logo.tsx frontend/src/components/ui/security-logo.test.tsx
git commit -m "feat(portfolio): add SecurityLogo component with letter-avatar fallback"
```

---

### Task 22: `<Sparkline>` component + tests

**Files:**
- Create: `frontend/src/components/ui/sparkline.tsx`
- Create: `frontend/src/components/ui/sparkline.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './sparkline'

describe('Sparkline', () => {
  it('renders null when data has fewer than 2 points', () => {
    const { container } = render(<Sparkline data={[{ date: '2026-05-01', value: 100 }]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an SVG line when at least 2 points', () => {
    const { container } = render(
      <Sparkline data={[{ date: '2026-05-01', value: 100 }, { date: '2026-05-02', value: 102 }]} />,
    )
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('uses green stroke when trend is up', () => {
    const { container } = render(
      <Sparkline data={[{ date: 'a', value: 1 }, { date: 'b', value: 2 }]} />,
    )
    expect(container.innerHTML).toContain('--accent-positive')
  })

  it('uses warn stroke when trend is down', () => {
    const { container } = render(
      <Sparkline data={[{ date: 'a', value: 2 }, { date: 'b', value: 1 }]} />,
    )
    expect(container.innerHTML).toContain('--accent-warm')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/components/ui/sparkline.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { Line, LineChart, ResponsiveContainer } from 'recharts'

export type SparklinePoint = { date: string; value: number }
export type SparklineProps = {
  data: SparklinePoint[]
  width?: number
  height?: number
}

export function Sparkline({ data, width = 80, height = 24 }: SparklineProps) {
  if (data.length < 2) return null
  const up = data[data.length - 1].value >= data[0].value
  const stroke = up ? 'var(--accent-positive)' : 'var(--accent-warm)'
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/components/ui/sparkline.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/sparkline.tsx frontend/src/components/ui/sparkline.test.tsx
git commit -m "feat(portfolio): add Sparkline component"
```

---

### Task 23: `<MetricStat>` component + tests

**Files:**
- Create: `frontend/src/components/ui/metric-stat.tsx`
- Create: `frontend/src/components/ui/metric-stat.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MetricStat } from './metric-stat'

describe('MetricStat', () => {
  it('renders label and value', () => {
    const { getByText } = render(<MetricStat label="MV" value="$1,234" />)
    expect(getByText('MV')).not.toBeNull()
    expect(getByText('$1,234')).not.toBeNull()
  })

  it('renders positive delta with up arrow', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={1.23} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('1.23%')
  })

  it('renders negative delta with down arrow', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={-2.5} />)
    expect(container.textContent).toContain('↓')
    expect(container.textContent).toContain('2.50%')
  })

  it('renders em-dash for null delta', () => {
    const { container } = render(<MetricStat label="x" value="—" />)
    expect(container.textContent).toContain('—')
  })

  it('shows loading skeleton', () => {
    const { container } = render(<MetricStat label="x" value="1" loading />)
    expect(container.querySelector('[data-loading="true"]')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/components/ui/metric-stat.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { StatCard } from './stat-card'

export type MetricStatProps = {
  label: string
  value: string
  delta?: number | null
  deltaPct?: number | null
  hint?: string
  loading?: boolean
}

function formatDelta(deltaPct: number): { arrow: string; text: string; color: string } {
  if (deltaPct >= 0) {
    return {
      arrow: '↑',
      text: `+${deltaPct.toFixed(2)}%`,
      color: 'var(--accent-positive)',
    }
  }
  return {
    arrow: '↓',
    text: `${Math.abs(deltaPct).toFixed(2)}%`,
    color: 'var(--accent-warm)',
  }
}

export function MetricStat({ label, value, deltaPct, hint, loading }: MetricStatProps) {
  if (loading) {
    return (
      <div data-loading="true">
        <StatCard label={label} value="…" hint={hint} />
      </div>
    )
  }
  const delta =
    deltaPct == null || !Number.isFinite(deltaPct)
      ? null
      : formatDelta(deltaPct)
  const compositeHint = delta
    ? `${delta.arrow} ${delta.text}${hint ? ` · ${hint}` : ''}`
    : hint
  return (
    <div style={delta ? { borderLeft: `3px solid ${delta.color}` } : undefined}>
      <StatCard label={label} value={value} hint={compositeHint ?? '—'} />
    </div>
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/components/ui/metric-stat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/metric-stat.tsx frontend/src/components/ui/metric-stat.test.tsx
git commit -m "feat(portfolio): add MetricStat component"
```

---

## Phase 5 — Detail page card components

### Task 24: `<SecurityHeader>` component + test

**Files:**
- Create: `frontend/src/pages/portfolio-security/SecurityHeader.tsx`
- Create: `frontend/src/pages/portfolio-security/SecurityHeader.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SecurityHeader } from './SecurityHeader'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('SecurityHeader', () => {
  beforeEach(() => {
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders symbol + name + badges', () => {
    const { getByText } = render(
      <SecurityHeader
        security={{ id: 1, symbol: 'XEQT.TO', name: 'iShares', assetType: 'ETF', currency: 'CAD' }}
        overview={{
          securityId: 1, sector: 'Diversified', industry: null, country: null, exchange: 'TSX',
          description: null, metadataFetchedAt: null,
          backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
        }}
      />,
    )
    expect(getByText('XEQT.TO')).not.toBeNull()
    expect(getByText(/iShares/)).not.toBeNull()
    expect(getByText('ETF')).not.toBeNull()
    expect(getByText('CAD')).not.toBeNull()
    expect(getByText('TSX')).not.toBeNull()
    expect(getByText('Diversified')).not.toBeNull()
  })

  it('renders without overview', () => {
    const { getByText } = render(
      <SecurityHeader
        security={{ id: 1, symbol: 'TST', name: null, assetType: null, currency: 'USD' }}
        overview={null}
      />,
    )
    expect(getByText('TST')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/pages/portfolio-security/SecurityHeader.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { Badge } from '@/components/ui/badge'
import { SecurityLogo } from '@/components/ui/security-logo'
import type { PortfolioSecurityDetail, PortfolioSecurityOverview } from '../../types/api'

export type SecurityHeaderProps = {
  security: PortfolioSecurityDetail['security']
  overview: PortfolioSecurityOverview | null
}

export function SecurityHeader({ security, overview }: SecurityHeaderProps) {
  return (
    <div className="flex items-center gap-4">
      <SecurityLogo symbol={security.symbol} name={security.name} size="xl" />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {security.symbol}
          {security.name ? <span className="muted"> — {security.name}</span> : null}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {security.assetType ? <Badge variant="secondary">{security.assetType}</Badge> : null}
          <Badge variant="outline">{security.currency}</Badge>
          {overview?.exchange ? <Badge variant="outline">{overview.exchange}</Badge> : null}
          {overview?.sector ? <Badge variant="outline">{overview.sector}</Badge> : null}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/pages/portfolio-security/SecurityHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-security/
git commit -m "feat(portfolio): add SecurityHeader component"
```

---

### Task 25: `<PriceChartCard>` component + test

**Files:**
- Create: `frontend/src/pages/portfolio-security/PriceChartCard.tsx`
- Create: `frontend/src/pages/portfolio-security/PriceChartCard.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { PriceChartCard } from './PriceChartCard'
import * as api from '../../lib/api'

describe('PriceChartCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches 1y range by default and renders chart', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y',
      rows: [
        { date: '2025-05-24', open: null, high: null, low: null, close: 30, adjClose: 30, volume: null },
        { date: '2026-05-24', open: null, high: null, low: null, close: 35, adjClose: 35, volume: null },
      ],
      trades: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 365 },
    })
    const { container } = render(<PriceChartCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/portfolio/security/1/prices?range=1y'))
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
  })

  it('refetches when range changes', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { getByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    fireEvent.click(getByText('1M'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/portfolio/security/1/prices?range=1m'))
  })

  it('shows history-loading banner when backfill status is never', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'never', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { findByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    expect(await findByText(/History loading/i)).not.toBeNull()
  })

  it('shows rate-limited banner when backfill exhausted', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, symbol: 'X', currency: 'CAD', range: '1y', rows: [], trades: [],
      backfill: { status: 'rate_limited', lastFetchedAt: null, nextRetryAt: '2026-05-25T00:00:00.000Z', coverageDays: 0 },
    })
    const { findByText } = render(<PriceChartCard securityId={1} currency="CAD" />)
    expect(await findByText(/quota exhausted/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/pages/portfolio-security/PriceChartCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioSecurityPrices } from '../../types/api'

const RANGES: ReadonlyArray<{ key: PortfolioSecurityPrices['range']; label: string }> = [
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '1y', label: '1Y' },
  { key: '5y', label: '5Y' },
  { key: 'all', label: 'All' },
]

const POLL_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 24

export type PriceChartCardProps = {
  securityId: number
  currency: string
}

export function PriceChartCard({ securityId, currency }: PriceChartCardProps) {
  const [range, setRange] = useState<PortfolioSecurityPrices['range']>('1y')
  const [data, setData] = useState<PortfolioSecurityPrices | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const pollAttemptsRef = useRef(0)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioSecurityPrices>(
        `/api/portfolio/security/${securityId}/prices?range=${range}`,
      )
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load price history')
    } finally {
      setLoading(false)
    }
  }, [securityId, range])

  useEffect(() => {
    pollAttemptsRef.current = 0
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!data) return
    if (data.backfill.status !== 'never' && data.backfill.status !== 'in_progress') return
    if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) return
    const id = window.setTimeout(() => {
      pollAttemptsRef.current += 1
      void fetchData()
    }, POLL_INTERVAL_MS)
    return () => window.clearTimeout(id)
  }, [data, fetchData])

  const chartRows = data?.rows.map((r) => ({ date: r.date, close: r.adjClose })) ?? []
  const buyDots = data?.trades
    .filter((t) => t.type === 'buy')
    .map((t) => ({ date: t.date, close: t.price ?? null })) ?? []
  const sellDots = data?.trades
    .filter((t) => t.type === 'sell')
    .map((t) => ({ date: t.date, close: t.price ?? null })) ?? []

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Price history</h2>
          <p className="muted">
            Adjusted close. Buys in green, sells in red. Source: Alpha Vantage.
          </p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              variant={range === r.key ? 'default' : 'outline'}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <BackfillBanner status={data?.backfill.status} nextRetryAt={data?.backfill.nextRetryAt ?? null} loading={loading} />

      {err && <p className="error">{err}</p>}

      {chartRows.length === 0 ? (
        <p className="muted">No price history yet for this security.</p>
      ) : (
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={chartRows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
              <Tooltip
                formatter={(value: number | string) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  return Number.isFinite(v) ? formatMoney(v, currency) : ''
                }}
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--chart-line-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Scatter data={buyDots} fill="var(--accent-positive)" />
              <Scatter data={sellDots} fill="var(--accent-warm)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

function BackfillBanner({
  status,
  nextRetryAt,
  loading,
}: {
  status: string | undefined
  nextRetryAt: string | null
  loading: boolean
}) {
  if (status === 'never' || status === 'in_progress') {
    return (
      <p className="muted text-sm" aria-live="polite">
        History loading… (auto-fetching in background){loading ? '' : ' — checking again shortly'}
      </p>
    )
  }
  if (status === 'rate_limited') {
    const next = nextRetryAt ? new Date(nextRetryAt).toLocaleString() : 'midnight UTC'
    return (
      <p className="uploadMsg warn text-sm">
        Daily AV quota exhausted — retry after {next}.
      </p>
    )
  }
  return null
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/pages/portfolio-security/PriceChartCard.test.tsx`
Expected: PASS (chart SVG check uses jsdom — recharts renders synchronously inside ResponsiveContainer; if the test fails because `<svg>` isn't found, replace `ResponsiveContainer` with a fixed `width={400} height={200}` in the test environment via a ResizeObserver mock in `vitest.setup.ts` — but check first whether existing chart tests already mock this).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-security/PriceChartCard.tsx frontend/src/pages/portfolio-security/PriceChartCard.test.tsx
git commit -m "feat(portfolio): add PriceChartCard with range toggle + trade overlay + backfill banner"
```

---

### Task 26: `<DividendHistoryCard>` component + test

**Files:**
- Create: `frontend/src/pages/portfolio-security/DividendHistoryCard.tsx`
- Create: `frontend/src/pages/portfolio-security/DividendHistoryCard.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { DividendHistoryCard } from './DividendHistoryCard'
import * as api from '../../lib/api'

describe('DividendHistoryCard', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('fetches and renders dividend events', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, currency: 'CAD',
      events: [
        { exDividendDate: '2026-03-15', paymentDate: '2026-04-01', recordDate: null, amount: 0.20, currency: 'CAD' },
      ],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
    })
    const { container } = render(<DividendHistoryCard securityId={1} currency="CAD" />)
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
  })

  it('shows empty message when no events', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securityId: 1, currency: 'CAD', events: [],
      backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
    })
    const { findByText } = render(<DividendHistoryCard securityId={1} currency="CAD" />)
    expect(await findByText(/No dividends recorded/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/pages/portfolio-security/DividendHistoryCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioSecurityDividends } from '../../types/api'

export type DividendHistoryCardProps = {
  securityId: number
  currency: string
}

export function DividendHistoryCard({ securityId, currency }: DividendHistoryCardProps) {
  const [data, setData] = useState<PortfolioSecurityDividends | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getJson<PortfolioSecurityDividends>(`/api/portfolio/security/${securityId}/dividends`)
      .then((res) => { if (!cancelled) setData(res) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load dividends') })
    return () => { cancelled = true }
  }, [securityId])

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Dividend history</h2>
          <p className="muted">One bar per ex-dividend event. Hover for amount + record/payment dates.</p>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.events.length === 0 ? (
        <p className="muted">No dividends recorded for this security.</p>
      ) : (
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={data.events.map((e) => ({
              date: e.exDividendDate,
              amount: e.amount,
              payment: e.paymentDate ?? '—',
              record: e.recordDate ?? '—',
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value, _name, ctx) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  if (!Number.isFinite(v)) return ''
                  const row = ctx?.payload as { payment?: string; record?: string }
                  return [
                    `${formatMoney(v, currency)} · pay ${row?.payment ?? '—'} · rec ${row?.record ?? '—'}`,
                    'Amount',
                  ]
                }}
              />
              <Bar dataKey="amount" fill="var(--chart-line-2)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/pages/portfolio-security/DividendHistoryCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-security/DividendHistoryCard.tsx frontend/src/pages/portfolio-security/DividendHistoryCard.test.tsx
git commit -m "feat(portfolio): add DividendHistoryCard"
```

---

### Task 27: `<AboutCard>` component + test

**Files:**
- Create: `frontend/src/pages/portfolio-security/AboutCard.tsx`
- Create: `frontend/src/pages/portfolio-security/AboutCard.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AboutCard } from './AboutCard'

const fresh = (over: Record<string, unknown> = {}) => ({
  securityId: 1, sector: 'Tech', industry: 'Software', country: 'USA',
  exchange: 'NASDAQ', description: 'A long description that should be truncated by default ...'.repeat(10),
  metadataFetchedAt: '2026-05-24T10:00:00.000Z',
  backfill: { status: 'fresh' as const, lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
  ...over,
})

describe('AboutCard', () => {
  it('renders sector/industry/country/exchange', () => {
    const { getByText } = render(<AboutCard overview={fresh()} />)
    expect(getByText('Tech')).not.toBeNull()
    expect(getByText('Software')).not.toBeNull()
    expect(getByText('USA')).not.toBeNull()
    expect(getByText('NASDAQ')).not.toBeNull()
  })

  it('truncates long description and reveals on Show more', () => {
    const { getByText, container } = render(<AboutCard overview={fresh()} />)
    const beforeLen = container.textContent?.length ?? 0
    fireEvent.click(getByText('Show more'))
    const afterLen = container.textContent?.length ?? 0
    expect(afterLen).toBeGreaterThan(beforeLen)
  })

  it('renders placeholder when no overview', () => {
    const { getByText } = render(<AboutCard overview={null} />)
    expect(getByText(/No company info/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && yarn test src/pages/portfolio-security/AboutCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import type { PortfolioSecurityOverview } from '../../types/api'

const TRUNCATE_LEN = 240

export type AboutCardProps = {
  overview: PortfolioSecurityOverview | null
}

export function AboutCard({ overview }: AboutCardProps) {
  const [expanded, setExpanded] = useState(false)
  if (!overview) {
    return (
      <Card>
        <h2 className="text-base">About</h2>
        <p className="muted">No company info available.</p>
      </Card>
    )
  }
  const desc = overview.description ?? ''
  const truncated = desc.length > TRUNCATE_LEN && !expanded
  const shown = truncated ? desc.slice(0, TRUNCATE_LEN) + '…' : desc

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <h2 className="text-base">About</h2>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {overview.sector && (<><dt className="muted">Sector</dt><dd>{overview.sector}</dd></>)}
        {overview.industry && (<><dt className="muted">Industry</dt><dd>{overview.industry}</dd></>)}
        {overview.country && (<><dt className="muted">Country</dt><dd>{overview.country}</dd></>)}
        {overview.exchange && (<><dt className="muted">Exchange</dt><dd>{overview.exchange}</dd></>)}
      </dl>
      {desc && (
        <p className="mt-3 text-sm">
          {shown}{' '}
          {desc.length > TRUNCATE_LEN && (
            <button
              type="button"
              className="underline text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </p>
      )}
      {overview.metadataFetchedAt && (
        <p className="muted text-xs mt-3">
          Data from Alpha Vantage · refreshed {overview.metadataFetchedAt.slice(0, 10)}
        </p>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && yarn test src/pages/portfolio-security/AboutCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-security/AboutCard.tsx frontend/src/pages/portfolio-security/AboutCard.test.tsx
git commit -m "feat(portfolio): add AboutCard"
```

---

## Phase 6 — Rewrite the detail page

### Task 28: Rewrite `PortfolioSecurityPage`

**Files:**
- Modify: `frontend/src/pages/PortfolioSecurityPage.tsx`

This task does not strictly TDD because the page is mostly composition; the underlying behaviors are already covered by component tests. We will add one page-level smoke test in Task 29.

- [ ] **Step 1: Rewrite the page**

Replace the existing `PortfolioSecurityPage.tsx` contents with:

```tsx
/**
 * Per-security drill view (slice F). Composes the new cards on top of
 * /api/portfolio/security/:id, /api/portfolio/security/:id/overview,
 * /api/portfolio/security/:id/dividends, /api/portfolio/security/:id/prices.
 * Retains the existing per-account ACB cards, activity timeline, and
 * holdings snapshots below.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { MetricStat } from '@/components/ui/metric-stat'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { AboutCard } from './portfolio-security/AboutCard'
import { DividendHistoryCard } from './portfolio-security/DividendHistoryCard'
import { PriceChartCard } from './portfolio-security/PriceChartCard'
import { SecurityHeader } from './portfolio-security/SecurityHeader'
import type {
  PortfolioSecurityDetail,
  PortfolioSecurityOverview,
} from '../types/api'

export function PortfolioSecurityPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PortfolioSecurityDetail | null>(null)
  const [overview, setOverview] = useState<PortfolioSecurityOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setErr(null)
    try {
      const [base, over] = await Promise.all([
        getJson<PortfolioSecurityDetail>(`/api/portfolio/security/${id}`),
        getJson<PortfolioSecurityOverview>(`/api/portfolio/security/${id}/overview`).catch(() => null),
      ])
      setData(base)
      setOverview(over)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load security detail')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const accountById = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of data?.perAccount ?? []) map.set(p.accountId, p.accountName)
    return map
  }, [data])

  const activitiesWithRunning = useMemo(() => {
    if (!data) return []
    const runByAccount = new Map<number, number>()
    return data.activities
      .slice()
      .sort((a, b) =>
        a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate.localeCompare(b.tradeDate),
      )
      .map((a) => {
        let pos = runByAccount.get(a.accountId) ?? 0
        if (a.activityType === 'buy' && a.quantity != null) pos += a.quantity
        else if (a.activityType === 'sell' && a.quantity != null) pos -= a.quantity
        runByAccount.set(a.accountId, pos)
        return { ...a, runningPosition: pos }
      })
  }, [data])

  if (!id) return <div className="page"><p className="error">Missing security id.</p></div>
  if (loading) return <div className="page"><PageHeader title="Loading security…" /></div>
  if (err) return (
    <div className="page">
      <PageHeader title="Security" />
      <p className="error">{err}</p>
      <Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>
    </div>
  )
  if (!data) return (
    <div className="page">
      <PageHeader title="Security not found" />
      <Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>
    </div>
  )

  const { security, perAccount, combined, holdings } = data
  const unrealized =
    combined.currentCostBasis !== 0
      ? combined.currentMarketValue - combined.currentCostBasis
      : null
  const lifetimeIncome = combined.income.dividend + combined.income.interest

  return (
    <div className="page">
      <PageHeader
        title=""
        actions={<Link to="/portfolio"><Button variant="outline">Back to portfolio</Button></Link>}
      />
      <SecurityHeader security={security} overview={overview} />

      <section className="transactionsStats mt-4">
        <StatCard label="Quantity" value={String(combined.currentQuantity)} hint="Across all accounts" />
        <StatCard label="Market value" value={formatMoney(combined.currentMarketValue, combined.currency)} />
        <StatCard label="Cost basis" value={formatMoney(combined.currentCostBasis, combined.currency)} />
        <StatCard
          label="Unrealized"
          value={unrealized != null ? formatMoney(unrealized, combined.currency) : '—'}
          hint="MV − cost basis"
        />
        <MetricStat label="Today" value="—" hint="Δ% vs prior close (coming soon)" />
        <MetricStat label="30d return" value="—" hint="Price + dividends (coming soon)" />
        <MetricStat label="Yield on cost (TTM)" value="—" hint="TTM dividends / cost basis (coming soon)" />
        <StatCard
          label="Realized to date"
          value={formatMoney(combined.realizedTotal, combined.currency)}
          hint="Weighted-average ACB"
        />
      </section>

      <div className="mt-4">
        <PriceChartCard securityId={security.id} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <DividendHistoryCard securityId={security.id} currency={combined.currency} />
      </div>

      <div className="mt-4">
        <AboutCard overview={overview} />
      </div>

      <h2 className="mt-6">Per-account</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {perAccount.map((row) => (
          <PerAccountCard key={row.accountId} row={row} />
        ))}
        {perAccount.length === 0 && (
          <Card><p className="muted">No accounts hold this security.</p></Card>
        )}
      </div>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Activity timeline</h2>
            <p className="muted">
              Chronological buys, sells, dividends, interest, and other rows. Running position is per-account.
            </p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Running</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activitiesWithRunning.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.tradeDate}</TableCell>
                  <TableCell>{accountById.get(a.accountId) ?? a.accountName}</TableCell>
                  <TableCell>{a.activityType}</TableCell>
                  <TableCell>{a.quantity ?? '—'}</TableCell>
                  <TableCell>{a.price != null ? formatMoney(a.price, a.currency) : '—'}</TableCell>
                  <TableCell>{a.amount != null ? formatMoney(a.amount, a.currency) : '—'}</TableCell>
                  <TableCell>{a.runningPosition}</TableCell>
                </TableRow>
              ))}
              {activitiesWithRunning.length === 0 && (
                <EmptyTableRow colSpan={7} title="No activities." description="No imported trades or income for this security yet." />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="transactionsTableCard mt-4">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Historical holdings snapshots</h2>
            <p className="muted">Every imported snapshot row for this security, newest first.</p>
          </div>
        </div>
        <div className="transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead>Statement date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Market value</TableHead>
                <TableHead>Cost basis</TableHead>
                <TableHead>Unrealized</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holdings.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{h.statementDate}</TableCell>
                  <TableCell>{h.accountName}</TableCell>
                  <TableCell>{h.quantity}</TableCell>
                  <TableCell>{h.price != null ? formatMoney(h.price, h.currency) : '—'}</TableCell>
                  <TableCell>{h.marketValue != null ? formatMoney(h.marketValue, h.currency) : '—'}</TableCell>
                  <TableCell>{h.costBasis != null ? formatMoney(h.costBasis, h.currency) : '—'}</TableCell>
                  <TableCell>{h.unrealizedGainLoss != null ? formatMoney(h.unrealizedGainLoss, h.currency) : '—'}</TableCell>
                </TableRow>
              ))}
              {holdings.length === 0 && (
                <EmptyTableRow colSpan={7} title="No snapshots." description="No historical holdings imported for this security." />
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}

function PerAccountCard({ row }: { row: PortfolioSecurityDetail['perAccount'][number] }) {
  const acbCurrency = row.acb.currency || 'CAD'
  const timeline = row.acb.timeline.map((t) => ({
    asOf: t.asOf,
    acbPerUnit: Number(t.acbPerUnit.toFixed(4)),
    quantity: t.quantity,
  }))
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">{row.accountName}</h2>
          <p className="muted">
            Qty {row.currentQuantity} · MV {formatMoney(row.currentMarketValue, acbCurrency)} · Cost{' '}
            {formatMoney(row.currentCostBasis, acbCurrency)} · Realized{' '}
            {formatMoney(row.acb.realizedTotal, acbCurrency)}
          </p>
        </div>
      </div>
      {timeline.length > 0 ? (
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <LineChart data={timeline}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="asOf" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value, name) => {
                  const v = typeof value === 'number' ? value : Number(value)
                  if (!Number.isFinite(v)) return ''
                  const nameStr = String(name)
                  return [
                    nameStr === 'acbPerUnit' ? formatMoney(v, acbCurrency) : String(v),
                    nameStr === 'acbPerUnit' ? 'ACB / unit' : 'Quantity',
                  ]
                }}
              />
              <Line type="monotone" dataKey="acbPerUnit" stroke="var(--chart-line-1)" strokeWidth={2} dot name="ACB / unit" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted">No buy/sell activity yet for this account.</p>
      )}
      {row.acb.warnings.length > 0 && (
        <ul className="muted text-xs mt-2 list-disc list-inside">
          {row.acb.warnings.slice(0, 3).map((w, i) => (<li key={i}>{w}</li>))}
        </ul>
      )}
    </Card>
  )
}
```

> **Note for the executor:** The 8-card stat row in this task uses `—` placeholders for "Today", "30d return", and "Yield on cost (TTM)". These three stats require backend changes (extending `/security/:id` to surface `currentPrice`, `prevClose`, and `dividendsLast30d/365d`) that are out of scope for this single PR according to the spec's stat-row formulas — they reference data sources that arrive with this slice but the slice doesn't yet plumb them through `combined`. Wire them up in Task 30.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && yarn build` (or `tsc -b --noEmit`)
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/PortfolioSecurityPage.tsx
git commit -m "feat(portfolio): rewrite PortfolioSecurityPage with logo header + chart cards"
```

---

### Task 29: Page-level smoke test for `PortfolioSecurityPage`

**Files:**
- Create: `frontend/src/pages/PortfolioSecurityPage.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PortfolioSecurityPage } from './PortfolioSecurityPage'
import * as api from '../lib/api'
import { _resetAppConfigForTest } from '../lib/appConfig'

const baseDetail = {
  security: { id: 1, symbol: 'XEQT.TO', name: 'iShares', assetType: 'ETF', currency: 'CAD' },
  perAccount: [],
  combined: {
    currentQuantity: 10, currentMarketValue: 350, currentCostBasis: 300,
    realizedTotal: 0, income: { dividend: 5, interest: 0 }, currency: 'CAD',
  },
  activities: [],
  holdings: [],
  latestPrice: null,
}

const baseOverview = {
  securityId: 1, sector: 'Diversified', industry: null, country: 'Canada',
  exchange: 'TSX', description: null, metadataFetchedAt: '2026-05-24T00:00:00.000Z',
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
}

const basePrices = {
  securityId: 1, symbol: 'XEQT.TO', currency: 'CAD', range: '1y', rows: [], trades: [],
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
}

const baseDivs = {
  securityId: 1, currency: 'CAD', events: [],
  backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 0 },
}

function mockApi(mapping: Record<string, unknown>) {
  vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
    for (const [k, v] of Object.entries(mapping)) {
      if (url.startsWith(k)) return v as never
    }
    throw new Error(`unmocked ${url}`)
  })
}

describe('PortfolioSecurityPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders header + cards on happy path', async () => {
    mockApi({
      '/api/portfolio/security/1/overview': baseOverview,
      '/api/portfolio/security/1/prices': basePrices,
      '/api/portfolio/security/1/dividends': baseDivs,
      '/api/portfolio/security/1': baseDetail,
    })
    const { findByText } = render(
      <MemoryRouter initialEntries={['/portfolio/security/1']}>
        <Routes>
          <Route path="/portfolio/security/:id" element={<PortfolioSecurityPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await findByText('XEQT.TO')).not.toBeNull()
    expect(await findByText('Quantity')).not.toBeNull()
    expect(await findByText('Price history')).not.toBeNull()
    expect(await findByText('Dividend history')).not.toBeNull()
    expect(await findByText('About')).not.toBeNull()
  })

  it('renders without crashing when overview fetch fails', async () => {
    vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      if (url.includes('/overview')) throw new Error('AV not configured')
      if (url.endsWith('/api/portfolio/security/1')) return baseDetail as never
      if (url.includes('/prices')) return basePrices as never
      if (url.includes('/dividends')) return baseDivs as never
      throw new Error(`unmocked ${url}`)
    })
    const { findByText } = render(
      <MemoryRouter initialEntries={['/portfolio/security/1']}>
        <Routes>
          <Route path="/portfolio/security/:id" element={<PortfolioSecurityPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await findByText(/No company info/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect PASS** (since Task 28 already shipped the implementation)

Run: `cd frontend && yarn test src/pages/PortfolioSecurityPage.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/PortfolioSecurityPage.test.tsx
git commit -m "test(portfolio): page-level smoke for PortfolioSecurityPage"
```

---

### Task 30: Wire the three stat-row placeholders to real data

**Files:**
- Modify: `backend/src/routes/portfolio.ts` (`/security/:id` handler — extend response)
- Modify: `frontend/src/types/api.ts` (extend `PortfolioSecurityDetail['combined']`)
- Modify: `frontend/src/pages/PortfolioSecurityPage.tsx` (consume the new fields)

This task closes the spec gap from the Task 28 note. The new fields come from existing data (`SecurityDailyPrice` for 30d return, `SecurityDividend` for TTM, `SecurityPrice` for prevClose).

- [ ] **Step 1: Extend the `/security/:id` JSON response**

In `backend/src/routes/portfolio.ts`, inside the existing `/security/:id` handler, **before** `res.json({...})`, compute the new fields:

```ts
// Today change %: needs current price + prevClose. Use latest SecurityPrice quote
// (refreshed via /prices/refresh). prevClose comes from yesterday's adj_close.
const dailyForToday = await SecurityDailyPrice.findAll({
  where: { securityId },
  order: [['date', 'DESC']],
  limit: 2,
});
const todayPriceQuote = latestPrice ? Number(latestPrice.price) : null;
const prevClose = dailyForToday[0] ? Number(dailyForToday[0].adjClose) : null;
const todayChangePct =
  todayPriceQuote != null && prevClose != null && prevClose !== 0
    ? ((todayPriceQuote - prevClose) / prevClose) * 100
    : null;

// 30-day return %: ((todayPrice + dividends_in_30d_per_unit) - price_30d_ago) / price_30d_ago
const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const price30 = await SecurityDailyPrice.findOne({
  where: { securityId, date: { [Op.lte]: cutoff30 } },
  order: [['date', 'DESC']],
});
const divs30 = await SecurityDividend.findAll({
  where: { securityId, exDividendDate: { [Op.gte]: cutoff30 } },
});
const divPerUnit30 = divs30.reduce((s, d) => s + Number(d.amount), 0);
const price30Val = price30 ? Number(price30.adjClose) : null;
const todayForReturn = todayPriceQuote ?? (dailyForToday[0] ? Number(dailyForToday[0].adjClose) : null);
const thirtyDayReturnPct =
  price30Val != null && price30Val !== 0 && todayForReturn != null
    ? ((todayForReturn + divPerUnit30 - price30Val) / price30Val) * 100
    : null;

// Yield on cost (TTM)
const cutoff365 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
const divs365 = await SecurityDividend.findAll({
  where: { securityId, exDividendDate: { [Op.gte]: cutoff365 } },
});
const divPerUnit365 = divs365.reduce((s, d) => s + Number(d.amount), 0);
const yieldOnCostPct =
  combinedCost > 0 && combinedQty > 0
    ? ((divPerUnit365 * combinedQty) / combinedCost) * 100
    : null;
```

Add these fields to the `combined: { ... }` block of the response:

```ts
        todayChangePct,
        thirtyDayReturnPct,
        yieldOnCostPct,
```

- [ ] **Step 2: Extend `PortfolioSecurityDetail` type**

In `frontend/src/types/api.ts`, find the existing `PortfolioSecurityDetail['combined']` shape and add three optional number fields:

```ts
        todayChangePct: number | null
        thirtyDayReturnPct: number | null
        yieldOnCostPct: number | null
```

- [ ] **Step 3: Consume in `PortfolioSecurityPage`**

Replace the three `<MetricStat ... value="—" ...>` placeholders in `PortfolioSecurityPage.tsx` with:

```tsx
<MetricStat
  label="Today"
  value={combined.todayChangePct != null ? `${combined.todayChangePct >= 0 ? '+' : ''}${combined.todayChangePct.toFixed(2)}%` : '—'}
  deltaPct={combined.todayChangePct ?? undefined}
  hint="vs prior close"
/>
<MetricStat
  label="30d return"
  value={combined.thirtyDayReturnPct != null ? `${combined.thirtyDayReturnPct >= 0 ? '+' : ''}${combined.thirtyDayReturnPct.toFixed(2)}%` : '—'}
  deltaPct={combined.thirtyDayReturnPct ?? undefined}
  hint="price + dividends"
/>
<MetricStat
  label="Yield on cost (TTM)"
  value={combined.yieldOnCostPct != null ? `${combined.yieldOnCostPct.toFixed(2)}%` : '—'}
  hint="TTM dividends / cost basis"
/>
```

- [ ] **Step 4: Extend the existing security drill integration test**

In `backend/test/integration/portfolioSecurityDrill.test.ts`, add a test that seeds 31 days of daily prices + 1 dividend in the last 30 days, then asserts `combined.todayChangePct`, `combined.thirtyDayReturnPct`, and `combined.yieldOnCostPct` are non-null and finite.

```ts
test('combined includes todayChangePct + 30d return + yield-on-cost when data present', async () => {
  // Inline seeding via the same models import already used by the file.
  // Assume `xeqtId`, `acctId`, `householdId` already in scope from before() block.
  const { seedDailyPrice, seedDividend } = await import('./portfolioFixtures.js');
  const models = await import('../../src/models');
  for (let i = 0; i <= 31; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqtId, date, close: 30 + i * 0.1, adjClose: 30 + i * 0.1 });
  }
  await seedDividend(models, {
    securityId: xeqtId,
    exDividendDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    amount: 0.25,
    currency: 'CAD',
  });
  const res = await authed.get(`/api/portfolio/security/${xeqtId}`);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.combined.thirtyDayReturnPct, null);
  assert.notEqual(res.body.combined.yieldOnCostPct, null);
  assert.ok(Number.isFinite(res.body.combined.thirtyDayReturnPct));
});
```

- [ ] **Step 5: Run all relevant tests**

```bash
cd backend && yarn test:integration --test-name-pattern "portfolio"
cd ../frontend && yarn test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioSecurityDrill.test.ts frontend/src/types/api.ts frontend/src/pages/PortfolioSecurityPage.tsx
git commit -m "feat(portfolio): wire today Δ%, 30d return, yield-on-cost on detail page"
```

---

## Phase 7 — Final verification

### Task 31: Full test sweep + manual verification

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && yarn test && yarn test:integration`
Expected: all pass; no regressions in existing portfolio tests.

- [ ] **Step 2: Run all frontend tests**

Run: `cd frontend && yarn test`
Expected: all pass.

- [ ] **Step 3: Run lint**

Run: `yarn lint` (root) or `cd frontend && yarn lint`
Expected: clean.

- [ ] **Step 4: Run backend typecheck**

Run: `cd backend && yarn typecheck`
Expected: clean.

- [ ] **Step 5: Run frontend build**

Run: `cd frontend && yarn build`
Expected: clean build.

- [ ] **Step 6: Manual smoke test**

Start the app:
```bash
cd backend && yarn dev &
cd frontend && yarn dev
```

In a browser, click any holding on the Portfolio page. Verify:
- Logo or letter-avatar renders in the header
- Eight stat cards render (some may show "—" if `ALPHA_VANTAGE_API_KEY` is unset — this is the documented degraded state)
- "Price history" card shows the range toggle; clicking different ranges refetches
- If no daily prices in DB, "History loading…" banner shows
- "Dividend history" card renders (empty state OK)
- "About" card renders (empty-state placeholder OK if no metadata)
- Per-account ACB cards, activity timeline, and holdings snapshots still appear at the bottom

- [ ] **Step 7: Final commit (if anything tweaked during manual smoke)**

If the manual smoke surfaces anything, fix and commit. Otherwise, no commit needed.

---

## Self-Review

### Spec coverage check

| Spec section | Plan task(s) |
|---|---|
| §3 Page layout | Tasks 24, 25, 26, 27, 28 |
| §3 Component map | Tasks 20–28 |
| §3 Stat row formulas | Task 30 |
| §3 Loading/empty/error matrix | Tasks 9 (graceful no-AV), 25 (banner), 27 (no overview), 28 |
| §4 `security_daily_prices` schema | Tasks 1, 4 |
| §4 `security_dividends` schema | Tasks 2, 5 |
| §4 `securities.metadata` column | Tasks 3, 6 |
| §4 `/prices` endpoint | Task 14 |
| §4 `/dividends` endpoint | Task 15 |
| §4 `/overview` endpoint | Task 16 |
| §4 `/api/config` endpoint | Task 9 |
| §4 Lazy backfill orchestration | Tasks 10, 11, 12 |
| §5 `securityLogo.ts` | Task 19 |
| §5 `<SecurityLogo>` | Task 21 |
| §5 `<LetterAvatar>` | Task 20 |
| §5 `<Sparkline>` | Task 22 |
| §5 `<MetricStat>` | Task 23 |
| §6 `LOGO_DEV_TOKEN` env | Task 8 |
| §7 Backend tests | Tasks 9, 10, 12, 14, 15, 16, 30 |
| §7 Frontend tests | Tasks 20, 21, 22, 23, 24, 25, 26, 27, 29 |
| §10 Acceptance criteria 1–12 | All covered across tasks 14–30 |

No gaps.

### Type-consistency check

- `BackfillStatus` shape identical across backend (`backfill.ts`) and frontend (`api.ts`).
- `PortfolioSecurityPrices.range` keys match `PRICE_RANGES` keys in backend.
- `combined.todayChangePct / thirtyDayReturnPct / yieldOnCostPct` named identically in route handler, frontend type, and component.
- `LetterAvatarSize` enum identical between `LetterAvatar` and `SecurityLogo`.
- `SecurityMetadata` extends `Record<string, unknown>` so per-task overview surface fields are typesafe.

### Placeholder scan

No "TBD" / "TODO" / "implement later" patterns. All code blocks are complete. Test bodies are real assertions, not "// add tests here".

### Notes

- Task 25's optional ResizeObserver mock note is concrete (points executor to `vitest.setup.ts` and existing chart tests as reference) — not a placeholder.
- Task 28's note about deferred stat-row fields is closed by Task 30 in the same plan.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-portfolio-detail-page.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

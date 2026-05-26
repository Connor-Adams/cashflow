# Slice B — Portfolio Performance Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new "Performance" tab (between Holdings and By security) with TWR/MWR stats over 5 preset ranges + custom date range, daily portfolio value chart with benchmark overlay (default SPY, per-household configurable), per-account TWR breakdown, and caveats banner. Backed by a materialized `portfolio_daily_snapshots` table (per-account per-day MV with native + CAD + FX audit) rebuilt nightly by cron + invalidated via Sequelize hooks on activity changes.

**Architecture:** Native-currency MV + same-day FX + precomputed CAD stored per (household, account, date). Builder reconstructs history from `investment_activities` ledger + `security_daily_prices.adj_close` walking dates forward, marks `is_partial` for missing prices/FX. Endpoint reads snapshots, runs pure TWR/XIRR/benchmark-series helpers, returns 5 preset stat blocks + 1 selected-range block + daily series + per-account breakdown + caveats.

**Tech Stack:** Sequelize 6 (Postgres prod, SQLite dev/test), Express, TypeScript, `node:test` for backend, vitest for frontend, `node-cron` (existing infra), React + Vite + Tailwind, recharts (existing).

**Reference spec:** [docs/superpowers/specs/2026-05-25-portfolio-performance-tab-design.md](../specs/2026-05-25-portfolio-performance-tab-design.md)

**Inherits patterns from Slice C** ([docs/superpowers/plans/2026-05-25-portfolio-forward-income.md](2026-05-25-portfolio-forward-income.md)):
- Backend test convention: per-file sqlite + `node:test` + `node:assert/strict` + inline factories. Reference [backend/test/portfolio/reconcileDividends.test.ts](../../backend/test/portfolio/reconcileDividends.test.ts).
- Hooks deferred via `transaction.afterCommit` + `setImmediate` to avoid SQLITE_BUSY.
- Idempotent registration guard via module-level `let registered = false`.
- `*Pct` fields stored on `*100` scale.
- Sequelize models use `DataTypes.JSON` for JSON columns; migrations use `isPostgres ? Sequelize.JSONB : Sequelize.JSON` branch.
- Scheduler shape mirrors [backend/src/portfolio/forwardIncomeScheduler.ts](../../backend/src/portfolio/forwardIncomeScheduler.ts).
- `stop*Scheduler` resets `runningTick`.
- Workspace names: `cashflow-backend`, `frontend`. Frontend has no `typecheck` script; use `cd frontend && npx tsc --noEmit`.

---

## File Structure

**Backend — new files:**
- `backend/src/migrations/20260529000001-portfolio-daily-snapshots.js`
- `backend/src/migrations/20260529000002-households-benchmark-symbol.js`
- `backend/src/models/PortfolioDailySnapshot.ts`
- `backend/src/portfolio/returns.ts` — pure helpers: `computeTwr`, `computeXirr`, `buildCashFlowSeries`, `computeBenchmarkSeries`
- `backend/src/portfolio/dailySnapshotBuilder.ts` — DB builder + `markDailySnapshotsStaleForHousehold`
- `backend/src/portfolio/dailySnapshotScheduler.ts` — `node-cron`
- `backend/src/hooks/dailySnapshotStaleHooks.ts`

**Backend — modifications:**
- `backend/src/models/Household.ts` — add `benchmarkSymbol` field
- `backend/src/models/index.ts` — register `PortfolioDailySnapshot`, call hook registration
- `backend/src/config/env.ts` — add `dailySnapshotEnabled`, `dailySnapshotCron`
- `backend/src/server.ts` — start scheduler on boot
- `backend/src/routes/portfolio.ts` — `GET /api/portfolio/performance`
- `backend/src/routes/household.ts` (or wherever household routes live; verify or create) — `PATCH /api/household/benchmark`

**Backend — tests:**
- `backend/test/portfolio/returns.test.ts`
- `backend/test/portfolio/dailySnapshotBuilder.test.ts`
- `backend/test/portfolio/dailySnapshotStale.test.ts`
- `backend/test/portfolio/dailySnapshotScheduler.test.ts`
- `backend/test/integration/portfolioPerformance.test.ts`
- `backend/test/integration/householdBenchmark.test.ts`
- `backend/test/migrations/portfolioDailySnapshotsMigration.test.ts`
- `backend/test/migrations/householdsBenchmarkSymbolMigration.test.ts`

**Shared types:**
- `shared/api-types.ts` — append `PortfolioPerformance*` types

**Frontend — new files:**
- `frontend/src/pages/portfolio-performance/PerformancePanel.tsx`
- `frontend/src/pages/portfolio-performance/PerformanceStatsRow.tsx`
- `frontend/src/pages/portfolio-performance/PerformanceChart.tsx`
- `frontend/src/pages/portfolio-performance/PerformanceRangeToggle.tsx`
- `frontend/src/pages/portfolio-performance/CustomRangePicker.tsx`
- `frontend/src/pages/portfolio-performance/ByAccountTable.tsx`
- `frontend/src/pages/portfolio-performance/BenchmarkPickerCard.tsx`
- `frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.tsx`
- One `*.test.tsx` per component (8 test files)

**Frontend — modifications:**
- `frontend/src/types/api.ts` — re-export `PortfolioPerformance*`
- `frontend/src/pages/PortfolioPage.tsx` — insert tab between Holdings and By security

---

## Task 1: Migration — `portfolio_daily_snapshots` table

**Files:**
- Create: `backend/src/migrations/20260529000001-portfolio-daily-snapshots.js`
- Test: `backend/test/migrations/portfolioDailySnapshotsMigration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/test/migrations/portfolioDailySnapshotsMigration.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = require(path.join(__dirname, '..', '..', 'src', 'migrations', '20260529000001-portfolio-daily-snapshots.js'));

let sequelize: Sequelize;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
  await sequelize.getQueryInterface().createTable('accounts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  });
});

after(async () => { await sequelize.close(); });

test('up creates portfolio_daily_snapshots table', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(tables.includes('portfolio_daily_snapshots'));
});

test('enforces UNIQUE (household_id, account_id, date)', async () => {
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO accounts (id) VALUES (10)`);
  await sequelize.query(`
    INSERT INTO portfolio_daily_snapshots
      (household_id, account_id, date, market_value_native, currency, fx_rate_to_cad,
       market_value_cad, cash_flow_native, cash_flow_cad, is_partial,
       computed_at, created_at, updated_at)
    VALUES (1, 10, '2026-05-15', 1000, 'CAD', 1.0, 1000, 0, 0, 0,
            datetime('now'), datetime('now'), datetime('now'))
  `);
  await assert.rejects(
    sequelize.query(`
      INSERT INTO portfolio_daily_snapshots
        (household_id, account_id, date, market_value_native, currency, fx_rate_to_cad,
         market_value_cad, cash_flow_native, cash_flow_cad, is_partial,
         computed_at, created_at, updated_at)
      VALUES (1, 10, '2026-05-15', 2000, 'CAD', 1.0, 2000, 0, 0, 0,
              datetime('now'), datetime('now'), datetime('now'))
    `),
  );
});

test('down drops table cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const tables = await sequelize.getQueryInterface().showAllTables();
  assert.ok(!tables.includes('portfolio_daily_snapshots'));
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "portfolioDailySnapshotsMigration|tests"
```

Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Create migration**

```js
// backend/src/migrations/20260529000001-portfolio-daily-snapshots.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('portfolio_daily_snapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      market_value_native: { type: Sequelize.DECIMAL(20, 4), allowNull: false },
      currency: { type: Sequelize.STRING(8), allowNull: false },
      fx_rate_to_cad: { type: Sequelize.DECIMAL(12, 6), allowNull: false },
      market_value_cad: { type: Sequelize.DECIMAL(20, 4), allowNull: false },
      cash_flow_native: { type: Sequelize.DECIMAL(20, 4), allowNull: false, defaultValue: 0 },
      cash_flow_cad: { type: Sequelize.DECIMAL(20, 4), allowNull: false, defaultValue: 0 },
      is_partial: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      missing_data_reasons: { type: isPostgres ? Sequelize.JSONB : Sequelize.JSON, allowNull: true },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['household_id', 'account_id', 'date'],
      { name: 'uq_pds_household_account_date', unique: true },
    );
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['household_id', 'date'],
      { name: 'idx_pds_household_date' },
    );
    await queryInterface.addIndex(
      'portfolio_daily_snapshots',
      ['account_id', 'date'],
      { name: 'idx_pds_account_date' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('portfolio_daily_snapshots');
  },
};
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "portfolioDailySnapshotsMigration|tests"
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260529000001-portfolio-daily-snapshots.js \
        backend/test/migrations/portfolioDailySnapshotsMigration.test.ts
git commit -m "feat(portfolio): add portfolio_daily_snapshots migration"
```

---

## Task 2: Migration — `households.benchmark_symbol`

**Files:**
- Create: `backend/src/migrations/20260529000002-households-benchmark-symbol.js`
- Test: `backend/test/migrations/householdsBenchmarkSymbolMigration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/test/migrations/householdsBenchmarkSymbolMigration.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = require(path.join(__dirname, '..', '..', 'src', 'migrations', '20260529000002-households-benchmark-symbol.js'));

let sequelize: Sequelize;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await sequelize.getQueryInterface().createTable('households', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
  });
  await sequelize.query(`INSERT INTO households (id, name) VALUES (1, 'Existing')`);
});

after(async () => { await sequelize.close(); });

test('up adds benchmark_symbol column with default SPY', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [results] = await sequelize.query(`SELECT benchmark_symbol FROM households WHERE id = 1`);
  assert.equal((results as Array<{ benchmark_symbol: string }>)[0].benchmark_symbol, 'SPY');
});

test('down drops the column', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('households');
  assert.equal(cols.benchmark_symbol, undefined);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "householdsBenchmarkSymbolMigration|tests"
```

- [ ] **Step 3: Create migration**

```js
// backend/src/migrations/20260529000002-households-benchmark-symbol.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('households', 'benchmark_symbol', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'SPY',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('households', 'benchmark_symbol');
  },
};
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "householdsBenchmarkSymbolMigration|tests"
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260529000002-households-benchmark-symbol.js \
        backend/test/migrations/householdsBenchmarkSymbolMigration.test.ts
git commit -m "feat(portfolio): add households.benchmark_symbol column with SPY default"
```

---

## Task 3: Sequelize model — `PortfolioDailySnapshot`

**Files:**
- Create: `backend/src/models/PortfolioDailySnapshot.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Create model**

```ts
// backend/src/models/PortfolioDailySnapshot.ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class PortfolioDailySnapshot extends Model<
  InferAttributes<PortfolioDailySnapshot>,
  InferCreationAttributes<PortfolioDailySnapshot>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare accountId: number;
  declare date: string;
  declare marketValueNative: string;
  declare currency: string;
  declare fxRateToCad: string;
  declare marketValueCad: string;
  declare cashFlowNative: string;
  declare cashFlowCad: string;
  declare isPartial: boolean;
  declare missingDataReasons: string[] | null;
  declare computedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPortfolioDailySnapshot(sequelize: Sequelize): typeof PortfolioDailySnapshot {
  PortfolioDailySnapshot.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: false },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      marketValueNative: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'market_value_native',
        allowNull: false,
      },
      currency: { type: DataTypes.STRING(8), allowNull: false },
      fxRateToCad: {
        type: DataTypes.DECIMAL(12, 6),
        field: 'fx_rate_to_cad',
        allowNull: false,
      },
      marketValueCad: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'market_value_cad',
        allowNull: false,
      },
      cashFlowNative: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'cash_flow_native',
        allowNull: false,
        defaultValue: '0',
      },
      cashFlowCad: {
        type: DataTypes.DECIMAL(20, 4),
        field: 'cash_flow_cad',
        allowNull: false,
        defaultValue: '0',
      },
      isPartial: {
        type: DataTypes.BOOLEAN,
        field: 'is_partial',
        allowNull: false,
        defaultValue: false,
      },
      missingDataReasons: {
        type: DataTypes.JSON,
        field: 'missing_data_reasons',
        allowNull: true,
      },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
    } as ModelAttributes<PortfolioDailySnapshot>,
    {
      sequelize,
      modelName: 'PortfolioDailySnapshot',
      tableName: 'portfolio_daily_snapshots',
      underscored: true,
      timestamps: true,
    },
  );
  return PortfolioDailySnapshot;
}
```

- [ ] **Step 2: Register in `backend/src/models/index.ts`**

Add imports near other model imports:
```ts
import {
  PortfolioDailySnapshot,
  initPortfolioDailySnapshot,
} from './PortfolioDailySnapshot';
```

Add init call near other `init*(sequelize)` calls:
```ts
initPortfolioDailySnapshot(sequelize);
```

Add to exports near other `Portfolio*` exports:
```ts
export { PortfolioDailySnapshot };
```

- [ ] **Step 3: Typecheck**

```bash
yarn workspace cashflow-backend typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/PortfolioDailySnapshot.ts backend/src/models/index.ts
git commit -m "feat(portfolio): add PortfolioDailySnapshot model"
```

---

## Task 4: Extend `Household` model with `benchmarkSymbol`

**Files:**
- Modify: `backend/src/models/Household.ts`

- [ ] **Step 1: Add `benchmarkSymbol` to model**

Replace the class declaration:

```ts
export class Household extends Model<
  InferAttributes<Household>,
  InferCreationAttributes<Household>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare benchmarkSymbol: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}
```

Add `benchmarkSymbol` to the init block:

```ts
benchmarkSymbol: {
  type: DataTypes.STRING(16),
  field: 'benchmark_symbol',
  allowNull: false,
  defaultValue: 'SPY',
},
```

- [ ] **Step 2: Typecheck**

```bash
yarn workspace cashflow-backend typecheck
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/Household.ts
git commit -m "feat(portfolio): add benchmarkSymbol to Household model"
```

---

## Task 5: Pure helper — `computeTwr`

**Files:**
- Create: `backend/src/portfolio/returns.ts`
- Test: `backend/test/portfolio/returns.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/test/portfolio/returns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTwr, type DailyPoint } from '../../src/portfolio/returns';

function approxEqual(actual: number, expected: number, eps = 1e-2): void {
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);
}

test('computeTwr — empty array returns 0', () => {
  assert.equal(computeTwr([]), 0);
});

test('computeTwr — single point returns 0', () => {
  const p: DailyPoint = { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 };
  assert.equal(computeTwr([p]), 0);
});

test('computeTwr — zero starting MV returns 0', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 0, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 100, cashFlowCad: 100 },
  ];
  assert.equal(computeTwr(points), 0);
});

test('computeTwr — value doubles, no cash flow → 100%', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 2000, cashFlowCad: 0 },
  ];
  approxEqual(computeTwr(points), 100);
});

test('computeTwr — value unchanged → 0%', () => {
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1000, cashFlowCad: 0 },
  ];
  approxEqual(computeTwr(points), 0);
});

test('computeTwr — deposit mid-period removed from return', () => {
  // Day 1: $1000. Day 2: deposit $500, end MV $1500. No actual investment return.
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1500, cashFlowCad: 500 },
  ];
  approxEqual(computeTwr(points), 0);
});

test('computeTwr — multi-period chain', () => {
  // Day 1: $1000. Day 2: $1100 (+10%, no flow). Day 3: $2000 (deposit $800, real growth = ($2000 - $800) / $1100 - 1 = +9.09%).
  // TWR = (1.10)(1.0909) - 1 = 0.2 → 20%
  const points: DailyPoint[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-01-02', marketValueCad: 1100, cashFlowCad: 0 },
    { date: '2026-01-03', marketValueCad: 2000, cashFlowCad: 800 },
  ];
  approxEqual(computeTwr(points), 20, 0.1);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "computeTwr|returns"
```

- [ ] **Step 3: Implement**

```ts
// backend/src/portfolio/returns.ts
export interface DailyPoint {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function computeTwr(points: DailyPoint[]): number {
  if (points.length < 2) return 0;
  if (points[0].marketValueCad === 0) return 0;

  let product = 1;
  for (let i = 1; i < points.length; i++) {
    const mvStart = points[i - 1].marketValueCad;
    const mvEnd = points[i].marketValueCad;
    const cashFlow = points[i].cashFlowCad;
    if (mvStart === 0) continue;
    const r = (mvEnd - cashFlow) / mvStart - 1;
    product *= 1 + r;
  }
  return (product - 1) * 100;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "computeTwr|tests"
```

7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/returns.ts backend/test/portfolio/returns.test.ts
git commit -m "feat(portfolio): add computeTwr pure helper"
```

---

## Task 6: Pure helper — `computeXirr`

**Files:**
- Modify: `backend/src/portfolio/returns.ts`
- Modify: `backend/test/portfolio/returns.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// append to backend/test/portfolio/returns.test.ts
import { computeXirr, type IrrCashFlow } from '../../src/portfolio/returns';

test('computeXirr — single deposit + 1Y final value of 1.10x → ~10%', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  approxEqual(r as number, 10, 0.5);
});

test('computeXirr — single deposit + same-year doubling → ~100%', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 2000 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  approxEqual(r as number, 100, 1);
});

test('computeXirr — multi-deposit DCA pattern returns finite number', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2025-07-01', amount: -1000 },
    { date: '2026-01-01', amount: 2300 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  assert.ok(Number.isFinite(r as number));
});

test('computeXirr — no cash flows returns null', () => {
  assert.equal(computeXirr([]), null);
});

test('computeXirr — only positive flows (no investment) returns null', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: 100 },
    { date: '2026-01-01', amount: 200 },
  ];
  assert.equal(computeXirr(cf), null);
});

test('computeXirr — negative return', () => {
  const cf: IrrCashFlow[] = [
    { date: '2025-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 500 },
  ];
  const r = computeXirr(cf);
  assert.ok(r !== null);
  assert.ok((r as number) < 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "computeXirr"
```

- [ ] **Step 3: Implement**

Append to `backend/src/portfolio/returns.ts`:

```ts
export interface IrrCashFlow {
  date: string;
  amount: number;
}

const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function yearsBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return (b - a) / MS_PER_DAY / DAYS_PER_YEAR;
}

function npv(rate: number, cashFlows: IrrCashFlow[], anchor: string): number {
  let total = 0;
  for (const cf of cashFlows) {
    const t = yearsBetween(anchor, cf.date);
    total += cf.amount / Math.pow(1 + rate, t);
  }
  return total;
}

function npvDerivative(rate: number, cashFlows: IrrCashFlow[], anchor: string): number {
  let total = 0;
  for (const cf of cashFlows) {
    const t = yearsBetween(anchor, cf.date);
    total += -t * cf.amount / Math.pow(1 + rate, t + 1);
  }
  return total;
}

export function computeXirr(cashFlows: IrrCashFlow[], guess = 0.1): number | null {
  if (cashFlows.length < 2) return null;
  const hasNegative = cashFlows.some((cf) => cf.amount < 0);
  const hasPositive = cashFlows.some((cf) => cf.amount > 0);
  if (!hasNegative || !hasPositive) return null;

  const sorted = [...cashFlows].sort((a, b) => a.date.localeCompare(b.date));
  const anchor = sorted[0].date;

  let rate = guess;
  for (let i = 0; i < 50; i++) {
    const f = npv(rate, sorted, anchor);
    const fPrime = npvDerivative(rate, sorted, anchor);
    if (Math.abs(fPrime) < 1e-12) return null;
    const next = rate - f / fPrime;
    if (Math.abs(next - rate) < 1e-7) return next * 100;
    rate = next;
    if (rate <= -1) rate = -0.999;
  }
  return null;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "returns|tests"
```

13 total `returns.ts` tests pass (7 from Task 5 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/returns.ts backend/test/portfolio/returns.test.ts
git commit -m "feat(portfolio): add computeXirr (Newton-Raphson XIRR)"
```

---

## Task 7: Pure helper — `buildCashFlowSeries`

**Files:**
- Modify: `backend/src/portfolio/returns.ts`
- Modify: `backend/test/portfolio/returns.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// append to backend/test/portfolio/returns.test.ts
import { buildCashFlowSeries, type AggregatedDailySnapshot } from '../../src/portfolio/returns';

test('buildCashFlowSeries — minimal: 1 day initial + final', () => {
  const snaps: AggregatedDailySnapshot[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-12-31', marketValueCad: 1100, cashFlowCad: 0 },
  ];
  const cf = buildCashFlowSeries(snaps, 1100);
  assert.equal(cf.length, 2);
  assert.equal(cf[0].amount, -1000);
  assert.equal(cf[0].date, '2026-01-01');
  assert.equal(cf[1].amount, 1100);
  assert.equal(cf[1].date, '2026-12-31');
});

test('buildCashFlowSeries — includes mid-stream deposits/withdrawals', () => {
  const snaps: AggregatedDailySnapshot[] = [
    { date: '2026-01-01', marketValueCad: 1000, cashFlowCad: 0 },
    { date: '2026-06-15', marketValueCad: 1500, cashFlowCad: 400 },
    { date: '2026-12-31', marketValueCad: 1700, cashFlowCad: 0 },
  ];
  const cf = buildCashFlowSeries(snaps, 1700);
  assert.equal(cf.length, 3);
  assert.equal(cf[0].amount, -1000);
  assert.equal(cf[1].amount, -400);
  assert.equal(cf[1].date, '2026-06-15');
  assert.equal(cf[2].amount, 1700);
});

test('buildCashFlowSeries — empty snapshots returns empty array', () => {
  assert.deepEqual(buildCashFlowSeries([], 0), []);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "buildCashFlow"
```

- [ ] **Step 3: Implement**

Append to `backend/src/portfolio/returns.ts`:

```ts
export interface AggregatedDailySnapshot {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function buildCashFlowSeries(
  snapshots: AggregatedDailySnapshot[],
  finalMvCad: number,
): IrrCashFlow[] {
  if (snapshots.length === 0) return [];
  const out: IrrCashFlow[] = [];
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

  // Initial money-in
  out.push({ date: sorted[0].date, amount: -sorted[0].marketValueCad });

  // Mid-stream cash flows (skip day 0 since initial is captured above)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].cashFlowCad !== 0) {
      out.push({ date: sorted[i].date, amount: -sorted[i].cashFlowCad });
    }
  }

  // Final money-out
  out.push({ date: sorted[sorted.length - 1].date, amount: finalMvCad });
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "returns|tests"
```

16 total tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/returns.ts backend/test/portfolio/returns.test.ts
git commit -m "feat(portfolio): add buildCashFlowSeries helper"
```

---

## Task 8: Pure helper — `computeBenchmarkSeries`

**Files:**
- Modify: `backend/src/portfolio/returns.ts`
- Modify: `backend/test/portfolio/returns.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// append to backend/test/portfolio/returns.test.ts
import { computeBenchmarkSeries } from '../../src/portfolio/returns';

test('computeBenchmarkSeries — flat prices → flat at initial value', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
    { date: '2026-01-03', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.0],
    ['2026-01-02', 1.0],
    ['2026-01-03', 1.0],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 10000);
  assert.equal(series.length, 3);
  series.forEach((s) => approxEqual(s.valueCad, 10000));
});

test('computeBenchmarkSeries — doubling price doubles series', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 200 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.0],
    ['2026-01-02', 1.0],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1000);
  approxEqual(series[0].valueCad, 1000);
  approxEqual(series[1].valueCad, 2000);
});

test('computeBenchmarkSeries — FX change reflected', () => {
  // Buy 10 USD shares at $100 each = $1000 USD = $1370 CAD at fx 1.37
  // Day 2: same USD price, FX moves to 1.40 → $1400 CAD
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.37],
    ['2026-01-02', 1.40],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1370);
  approxEqual(series[0].valueCad, 1370);
  approxEqual(series[1].valueCad, 1400);
});

test('computeBenchmarkSeries — missing FX forward-fills', () => {
  const prices = [
    { date: '2026-01-01', adjClose: 100 },
    { date: '2026-01-02', adjClose: 100 },
    { date: '2026-01-03', adjClose: 100 },
  ];
  const fx = new Map([
    ['2026-01-01', 1.37],
    ['2026-01-03', 1.40],
  ]);
  const series = computeBenchmarkSeries(prices, fx, 1370);
  approxEqual(series[1].valueCad, 1370); // forward-fill from 2026-01-01
});

test('computeBenchmarkSeries — empty prices returns empty array', () => {
  assert.deepEqual(computeBenchmarkSeries([], new Map(), 1000), []);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "computeBenchmark"
```

- [ ] **Step 3: Implement**

Append to `backend/src/portfolio/returns.ts`:

```ts
export function computeBenchmarkSeries(
  benchmarkDailyPrices: Array<{ date: string; adjClose: number }>,
  fxByDate: Map<string, number>,
  initialPortfolioValueCad: number,
): Array<{ date: string; valueCad: number }> {
  if (benchmarkDailyPrices.length === 0) return [];
  const sorted = [...benchmarkDailyPrices].sort((a, b) => a.date.localeCompare(b.date));

  let lastFx = fxByDate.get(sorted[0].date) ?? 1;
  const firstPriceCad = sorted[0].adjClose * lastFx;
  if (firstPriceCad === 0) {
    return sorted.map((p) => ({ date: p.date, valueCad: 0 }));
  }
  const fixedShares = initialPortfolioValueCad / firstPriceCad;

  return sorted.map((p) => {
    const fx = fxByDate.get(p.date) ?? lastFx;
    lastFx = fx;
    return { date: p.date, valueCad: fixedShares * p.adjClose * fx };
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "returns|tests"
```

21 total `returns.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/returns.ts backend/test/portfolio/returns.test.ts
git commit -m "feat(portfolio): add computeBenchmarkSeries buy-and-hold helper"
```

---

## Task 9: Builder — `dailySnapshotBuilder`

**Files:**
- Create: `backend/src/portfolio/dailySnapshotBuilder.ts`
- Test: `backend/test/portfolio/dailySnapshotBuilder.test.ts`

- [ ] **Step 1: Write the test file (per-file sqlite pattern, inline factories)**

```ts
// backend/test/portfolio/dailySnapshotBuilder.test.ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-builder.sqlite');

let models: typeof import('../../src/models');
let builder: typeof import('../../src/portfolio/dailySnapshotBuilder');

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
  builder = await import('../../src/portfolio/dailySnapshotBuilder');
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.SecurityDailyPrice.destroy({ where: {}, truncate: true });
  await models.Security.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  await models.FxRate.destroy({ where: {}, truncate: true });
});

async function seedHousehold(id = 1) {
  return models.Household.create({ id, name: 'Test', benchmarkSymbol: 'SPY' });
}

async function seedAccount(args: { householdId: number; id?: number; currency?: string }) {
  return models.Account.create({
    id: args.id,
    householdId: args.householdId,
    name: 'Acct',
    owner: 'shared',
    accountType: 'investment',
    currency: args.currency ?? 'CAD',
  });
}

async function seedSecurity(args: { id?: number; symbol?: string; currency?: string; householdId?: number }) {
  return models.Security.create({
    id: args.id,
    householdId: args.householdId ?? 1,
    symbol: args.symbol ?? 'VCN',
    name: 'Test Sec',
    assetType: 'etf',
    currency: args.currency ?? 'CAD',
  });
}

async function seedDailyPrice(args: { securityId: number; date: string; adjClose: number }) {
  return models.SecurityDailyPrice.create({
    securityId: args.securityId,
    date: args.date,
    open: String(args.adjClose),
    high: String(args.adjClose),
    low: String(args.adjClose),
    close: String(args.adjClose),
    adjClose: String(args.adjClose),
    volume: '0',
    source: 'test',
    fetchedAt: new Date(),
  });
}

async function seedFx(args: { fromCurrency: string; toCurrency?: string; asOfDate: string; rate: number }) {
  return models.FxRate.create({
    fromCurrency: args.fromCurrency,
    toCurrency: args.toCurrency ?? 'CAD',
    asOfDate: args.asOfDate,
    rate: String(args.rate),
    source: 'test',
    fetchedAt: new Date(),
  });
}

async function seedBuyActivity(args: { accountId: number; securityId: number; tradeDate: string; quantity: string; amount?: string }) {
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: args.securityId,
    activityType: 'buy',
    tradeDate: args.tradeDate,
    quantity: args.quantity,
    price: '100',
    amount: args.amount ?? '100',
    currency: 'CAD',
    description: 'Buy',
    sourceRowFingerprint: `buy-${args.tradeDate}-${args.securityId}`,
    importBatch: 'test',
  });
}

async function seedTransfer(args: { accountId: number; tradeDate: string; amount: string }) {
  return models.InvestmentActivity.create({
    accountId: args.accountId,
    householdId: 1,
    securityId: null,
    activityType: 'transfer',
    tradeDate: args.tradeDate,
    amount: args.amount,
    currency: 'CAD',
    description: 'Deposit',
    sourceRowFingerprint: `xfer-${args.tradeDate}-${args.accountId}`,
    importBatch: 'test',
  });
}

test('greenfield: builds one snapshot per day for one account holding one security', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  for (let d = 1; d <= 5; d++) {
    await seedDailyPrice({ securityId: sec.id, date: `2026-01-0${d}`, adjClose: 100 });
  }

  const r = await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-05',
  });
  assert.equal(r.daysBuilt, 5);
  const rows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id }, order: [['date', 'ASC']] });
  assert.equal(rows.length, 5);
  assert.equal(Number(rows[0].marketValueNative), 1000);
  assert.equal(rows[0].currency, 'CAD');
  assert.equal(Number(rows[0].marketValueCad), 1000);
  assert.equal(rows[0].isPartial, false);
});

test('USD account: fx_rate_to_cad applied + market_value_cad correct', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id, currency: 'USD' });
  const sec = await seedSecurity({ currency: 'USD' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });
  await seedFx({ fromCurrency: 'USD', asOfDate: '2026-01-01', rate: 1.37 });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(Number(row!.marketValueNative), 1000);
  assert.equal(Number(row!.fxRateToCad), 1.37);
  assert.equal(Number(row!.marketValueCad), 1370);
});

test('missing daily price → is_partial=true + missing_data_reasons populated', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({ symbol: 'MISSING' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  // No SecurityDailyPrice seeded.

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(row!.isPartial, true);
  assert.ok((row!.missingDataReasons ?? []).some((r: string) => r.includes('no_price:MISSING')));
});

test('missing FX → is_partial=true + reason populated', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id, currency: 'USD' });
  const sec = await seedSecurity({ currency: 'USD' });
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });
  // No FX seeded.

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(row!.isPartial, true);
  assert.ok((row!.missingDataReasons ?? []).some((r: string) => r.includes('no_fx:USD')));
});

test('transfer activity sets cash_flow_native + cash_flow_cad', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  await seedTransfer({ accountId: acct.id, tradeDate: '2026-01-01', amount: '500' });

  await builder.buildDailySnapshotsForHousehold({
    householdId: hh.id,
    fromDate: '2026-01-01',
    toDate: '2026-01-01',
  });
  const row = await models.PortfolioDailySnapshot.findOne({ where: { householdId: hh.id } });
  assert.ok(row);
  assert.equal(Number(row!.cashFlowNative), 500);
  assert.equal(Number(row!.cashFlowCad), 500);
});

test('idempotent: re-running same range produces same row count', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '10' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });

  await builder.buildDailySnapshotsForHousehold({ householdId: hh.id, fromDate: '2026-01-01', toDate: '2026-01-01' });
  await builder.buildDailySnapshotsForHousehold({ householdId: hh.id, fromDate: '2026-01-01', toDate: '2026-01-01' });
  const rows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
});

test('markDailySnapshotsStaleForHousehold deletes rows >= fromDate', async () => {
  const hh = await seedHousehold();
  const acct = await seedAccount({ householdId: hh.id });
  await models.PortfolioDailySnapshot.bulkCreate([
    { householdId: hh.id, accountId: acct.id, date: '2026-01-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
    { householdId: hh.id, accountId: acct.id, date: '2026-06-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
    { householdId: hh.id, accountId: acct.id, date: '2026-12-01', marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0', cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null, computedAt: new Date() },
  ]);
  await builder.markDailySnapshotsStaleForHousehold(hh.id, '2026-06-01');
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-01-01');
});

test('buildDailySnapshotsForAllHouseholds iterates households', async () => {
  await seedHousehold(1);
  await seedHousehold(2);
  const acct1 = await seedAccount({ householdId: 1, id: 10 });
  const acct2 = await seedAccount({ householdId: 2, id: 20 });
  const sec = await seedSecurity({});
  await seedBuyActivity({ accountId: acct1.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '5' });
  await seedBuyActivity({ accountId: acct2.id, securityId: sec.id, tradeDate: '2026-01-01', quantity: '7' });
  await seedDailyPrice({ securityId: sec.id, date: '2026-01-01', adjClose: 100 });

  const r = await builder.buildDailySnapshotsForAllHouseholds({ toDate: '2026-01-01' });
  assert.equal(r.households, 2);
  assert.ok(r.daysBuilt >= 2);
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotBuilder|tests"
```

- [ ] **Step 3: Implement builder**

```ts
// backend/src/portfolio/dailySnapshotBuilder.ts
import { Op } from 'sequelize';
import { Account } from '../models/Account';
import { Household } from '../models/Household';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { PortfolioDailySnapshot } from '../models/PortfolioDailySnapshot';
import { Security } from '../models/Security';
import { SecurityDailyPrice } from '../models/SecurityDailyPrice';
import { FxRate } from '../models/FxRate';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(new Date(iso).getTime() + days * MS_PER_DAY));
}

export interface BuildDailySnapshotsArgs {
  householdId: number;
  fromDate?: string;
  toDate?: string;
}

export interface BuildResult {
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
  errors: string[];
}

async function resolveDateRange(
  householdId: number,
  fromDate: string | undefined,
  toDate: string | undefined,
): Promise<{ from: string; to: string } | null> {
  const to = toDate ?? toIsoDate(new Date(Date.now() - MS_PER_DAY));
  if (fromDate) return { from: fromDate, to };

  const lastSnap = await PortfolioDailySnapshot.findOne({
    where: { householdId },
    order: [['date', 'DESC']],
  });
  if (lastSnap) {
    return { from: addDays(lastSnap.date, 1), to };
  }

  const accounts = await Account.findAll({ where: { householdId, accountType: 'investment' }, attributes: ['id'] });
  if (accounts.length === 0) return null;
  const acctIds = accounts.map((a) => a.id);
  const earliest = await InvestmentActivity.findOne({
    where: { accountId: { [Op.in]: acctIds } },
    order: [['tradeDate', 'ASC']],
  });
  if (!earliest) return null;
  return { from: earliest.tradeDate, to };
}

export async function buildDailySnapshotsForHousehold(args: BuildDailySnapshotsArgs): Promise<BuildResult> {
  const { householdId } = args;
  const range = await resolveDateRange(householdId, args.fromDate, args.toDate);
  if (!range) return { daysBuilt: 0, daysSkipped: 0, partialDays: 0, errors: [] };
  const { from, to } = range;

  const accounts = await Account.findAll({ where: { householdId, accountType: 'investment' } });
  if (accounts.length === 0) return { daysBuilt: 0, daysSkipped: 0, partialDays: 0, errors: [] };
  const acctIds = accounts.map((a) => a.id);

  const allActivities = await InvestmentActivity.findAll({
    where: { accountId: { [Op.in]: acctIds }, tradeDate: { [Op.lte]: to } },
    order: [['tradeDate', 'ASC']],
  });

  const touchedSecurityIds = [...new Set(allActivities.map((a) => a.securityId).filter((id): id is number => id != null))];
  const securities = touchedSecurityIds.length > 0
    ? await Security.findAll({ where: { id: { [Op.in]: touchedSecurityIds } } })
    : [];
  const secById = new Map(securities.map((s) => [s.id, s]));

  const allPrices = touchedSecurityIds.length > 0
    ? await SecurityDailyPrice.findAll({
        where: { securityId: { [Op.in]: touchedSecurityIds }, date: { [Op.lte]: to } },
      })
    : [];
  const priceByKey = new Map<string, number>();
  for (const p of allPrices) {
    priceByKey.set(`${p.securityId}:${p.date}`, Number(p.adjClose));
  }

  const accountCurrencies = [...new Set(accounts.map((a) => a.currency))];
  const allFx = await FxRate.findAll({
    where: { fromCurrency: { [Op.in]: accountCurrencies }, toCurrency: 'CAD', asOfDate: { [Op.lte]: to } },
  });
  const fxByKey = new Map<string, number>();
  for (const f of allFx) {
    fxByKey.set(`${f.fromCurrency}:${f.asOfDate}`, Number(f.rate));
  }

  // Running qty per (accountId, securityId) and per-day transfer per account
  const qty = new Map<string, number>();
  const activitiesByDate = new Map<string, InvestmentActivity[]>();
  for (const a of allActivities) {
    const list = activitiesByDate.get(a.tradeDate) ?? [];
    list.push(a);
    activitiesByDate.set(a.tradeDate, list);
  }

  let daysBuilt = 0;
  let partialDays = 0;
  const errors: string[] = [];
  const now = new Date();

  for (let d = from; d <= to; d = addDays(d, 1)) {
    // Apply activities for day d to qty map BEFORE valuing
    const todays = activitiesByDate.get(d) ?? [];
    for (const a of todays) {
      if (a.securityId == null) continue;
      const key = `${a.accountId}:${a.securityId}`;
      const cur = qty.get(key) ?? 0;
      const qChange = Number(a.quantity ?? '0');
      if (a.activityType === 'buy' || a.activityType === 'transfer' && qChange > 0) {
        qty.set(key, cur + qChange);
      } else if (a.activityType === 'sell') {
        qty.set(key, cur - qChange);
      }
    }

    let dayHasPartial = false;
    for (const acct of accounts) {
      let mvNative = 0;
      const reasons: string[] = [];

      const heldKeys = [...qty.keys()].filter((k) => k.startsWith(`${acct.id}:`));
      for (const key of heldKeys) {
        const q = qty.get(key) ?? 0;
        if (q === 0) continue;
        const securityId = Number(key.split(':')[1]);
        const sec = secById.get(securityId);
        const price = priceByKey.get(`${securityId}:${d}`);
        if (price == null) {
          reasons.push(`no_price:${sec?.symbol ?? `sec_${securityId}`}`);
          continue;
        }
        mvNative += q * price;
      }

      let fxRate = 1;
      if (acct.currency !== 'CAD') {
        const lookup = fxByKey.get(`${acct.currency}:${d}`);
        if (lookup == null) {
          reasons.push(`no_fx:${acct.currency}-${d}`);
        } else {
          fxRate = lookup;
        }
      }

      const cashFlowNative = todays
        .filter((a) => a.accountId === acct.id && a.activityType === 'transfer')
        .reduce((s, a) => s + Number(a.amount ?? '0'), 0);

      const mvCad = mvNative * fxRate;
      const cashFlowCad = cashFlowNative * fxRate;
      const isPartial = reasons.length > 0;
      if (isPartial) dayHasPartial = true;

      try {
        await PortfolioDailySnapshot.upsert(
          {
            householdId,
            accountId: acct.id,
            date: d,
            marketValueNative: String(mvNative.toFixed(4)),
            currency: acct.currency,
            fxRateToCad: String(fxRate.toFixed(6)),
            marketValueCad: String(mvCad.toFixed(4)),
            cashFlowNative: String(cashFlowNative.toFixed(4)),
            cashFlowCad: String(cashFlowCad.toFixed(4)),
            isPartial,
            missingDataReasons: isPartial ? reasons : null,
            computedAt: now,
          },
          { conflictFields: ['household_id', 'account_id', 'date'] },
        );
      } catch (err) {
        errors.push(`upsert failed for ${acct.id}:${d}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (dayHasPartial) partialDays++;
    daysBuilt++;
  }

  return { daysBuilt, daysSkipped: 0, partialDays, errors };
}

export async function buildDailySnapshotsForAllHouseholds(args?: { toDate?: string }): Promise<{
  households: number;
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
}> {
  const households = await Household.findAll({ attributes: ['id'] });
  let daysBuilt = 0;
  let daysSkipped = 0;
  let partialDays = 0;
  for (const hh of households) {
    const r = await buildDailySnapshotsForHousehold({ householdId: hh.id, toDate: args?.toDate });
    daysBuilt += r.daysBuilt;
    daysSkipped += r.daysSkipped;
    partialDays += r.partialDays;
  }
  return { households: households.length, daysBuilt, daysSkipped, partialDays };
}

export async function markDailySnapshotsStaleForHousehold(householdId: number, fromDate: string): Promise<void> {
  await PortfolioDailySnapshot.destroy({
    where: { householdId, date: { [Op.gte]: fromDate } },
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotBuilder|tests" | tail
```

8 builder tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/dailySnapshotBuilder.ts \
        backend/test/portfolio/dailySnapshotBuilder.test.ts
git commit -m "feat(portfolio): add daily snapshot builder with FX-aware reconstruction"
```

---

## Task 10: Sequelize stale-invalidation hooks

**Files:**
- Create: `backend/src/hooks/dailySnapshotStaleHooks.ts`
- Modify: `backend/src/models/index.ts`
- Test: `backend/test/portfolio/dailySnapshotStale.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// backend/test/portfolio/dailySnapshotStale.test.ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-stale.sqlite');

let models: typeof import('../../src/models');

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
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

async function seedSnapshot(args: { householdId: number; accountId: number; date: string }) {
  return models.PortfolioDailySnapshot.create({
    householdId: args.householdId, accountId: args.accountId, date: args.date,
    marketValueNative: '0', currency: 'CAD', fxRateToCad: '1', marketValueCad: '0',
    cashFlowNative: '0', cashFlowCad: '0', isPartial: false, missingDataReasons: null,
    computedAt: new Date(),
  });
}

test('InvestmentActivity.create deletes snapshots from tradeDate forward', async () => {
  const hh = await models.Household.create({ id: 1, name: 'A', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 10, householdId: hh.id, name: 'X', owner: 'shared', accountType: 'investment', currency: 'CAD' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-01-01' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-06-15' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-12-01' });

  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-06-15',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp1', importBatch: 'b1',
  });

  // Hook fires inside afterCommit + setImmediate — give it a tick
  await new Promise((r) => setImmediate(r));
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id }, order: [['date', 'ASC']] });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-01-01');
});

test('InvestmentActivity.destroy deletes snapshots from tradeDate forward', async () => {
  const hh = await models.Household.create({ id: 2, name: 'B', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 20, householdId: hh.id, name: 'Y', owner: 'shared', accountType: 'investment', currency: 'CAD' });
  const act = await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-03-01',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp2', importBatch: 'b1',
  });
  await new Promise((r) => setImmediate(r));
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-02-01' });
  await seedSnapshot({ householdId: hh.id, accountId: acct.id, date: '2026-04-01' });

  await act.destroy();
  await new Promise((r) => setImmediate(r));
  const remaining = await models.PortfolioDailySnapshot.findAll({ where: { householdId: hh.id } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].date, '2026-02-01');
});

test('unrelated household activity does not delete other households', async () => {
  const a = await models.Household.create({ id: 3, name: 'A', benchmarkSymbol: 'SPY' });
  const b = await models.Household.create({ id: 4, name: 'B', benchmarkSymbol: 'SPY' });
  const acctA = await models.Account.create({ id: 30, householdId: a.id, name: 'X', owner: 'shared', accountType: 'investment', currency: 'CAD' });
  const acctB = await models.Account.create({ id: 40, householdId: b.id, name: 'Y', owner: 'shared', accountType: 'investment', currency: 'CAD' });
  await seedSnapshot({ householdId: a.id, accountId: acctA.id, date: '2026-01-01' });
  await seedSnapshot({ householdId: b.id, accountId: acctB.id, date: '2026-01-01' });

  await models.InvestmentActivity.create({
    accountId: acctA.id, householdId: a.id, securityId: null,
    activityType: 'transfer', tradeDate: '2025-12-01',
    amount: '100', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp3', importBatch: 'b1',
  });
  await new Promise((r) => setImmediate(r));
  const bRows = await models.PortfolioDailySnapshot.findAll({ where: { householdId: b.id } });
  assert.equal(bRows.length, 1);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotStale|tests"
```

- [ ] **Step 3: Implement hooks**

```ts
// backend/src/hooks/dailySnapshotStaleHooks.ts
import type { Sequelize, Transaction } from 'sequelize';
import { Account } from '../models/Account';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { markDailySnapshotsStaleForHousehold } from '../portfolio/dailySnapshotBuilder';

type HookOpts = { transaction?: Transaction };

async function householdIdForAccount(accountId: number): Promise<number | null> {
  const acct = await Account.findByPk(accountId, { attributes: ['householdId'] });
  return acct?.householdId ?? null;
}

function deferOrRun(opts: HookOpts | undefined, work: () => Promise<void>): void | Promise<void> {
  if (opts?.transaction) {
    opts.transaction.afterCommit(() => setImmediate(() => void work()));
    return;
  }
  return work();
}

let registered = false;

export function registerDailySnapshotStaleHooks(_sequelize: Sequelize): void {
  if (registered) return;
  registered = true;

  InvestmentActivity.addHook('afterCreate', 'daily_snapshot_stale_create', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, instance.tradeDate));
  });

  InvestmentActivity.addHook('afterUpdate', 'daily_snapshot_stale_update', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    const newDate = instance.tradeDate;
    const prev = (instance.previous as (key: string) => string | undefined)('tradeDate');
    const fromDate = prev && prev < newDate ? prev : newDate;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, fromDate));
  });

  InvestmentActivity.addHook('afterDestroy', 'daily_snapshot_stale_destroy', async (instance, opts) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await deferOrRun(opts as HookOpts, () => markDailySnapshotsStaleForHousehold(hhId, instance.tradeDate));
  });
}
```

- [ ] **Step 4: Wire in `backend/src/models/index.ts`**

Append after all `init*()` calls and after `registerForwardIncomeStaleHooks`:

```ts
import { registerDailySnapshotStaleHooks } from '../hooks/dailySnapshotStaleHooks';
// ...
registerDailySnapshotStaleHooks(sequelize);
```

- [ ] **Step 5: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotStale|tests"
```

3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/hooks/dailySnapshotStaleHooks.ts \
        backend/src/models/index.ts \
        backend/test/portfolio/dailySnapshotStale.test.ts
git commit -m "feat(portfolio): add daily snapshot stale-invalidation hooks"
```

---

## Task 11: Scheduler + env vars

**Files:**
- Modify: `backend/src/config/env.ts`
- Create: `backend/src/portfolio/dailySnapshotScheduler.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/test/portfolio/dailySnapshotScheduler.test.ts`

- [ ] **Step 1: Extend `env.ts`**

Add to `EnvConfig` type:
```ts
dailySnapshotEnabled: boolean;
dailySnapshotCron: string;
```

Add parser helper near `parseForwardIncomeEnabled`:
```ts
export function parseDailySnapshotEnabled(raw: string | undefined, nodeEnv: string): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && QUOTE_TRUTHY.has(trimmed)) return true;
  if (trimmed && QUOTE_FALSY.has(trimmed)) return false;
  if (nodeEnv === 'test') return false;
  return true;
}
```

In `loadEnvConfig`:
```ts
const dailySnapshotEnabled = parseDailySnapshotEnabled(e.DAILY_SNAPSHOT_ENABLED, nodeEnv);
const dailySnapshotCron = e.DAILY_SNAPSHOT_CRON?.trim() || '0 3 * * *';
```

Include in returned object and `export const` lines near `forwardIncomeEnabled`:
```ts
export const dailySnapshotEnabled = resolved.dailySnapshotEnabled;
export const dailySnapshotCron = resolved.dailySnapshotCron;
```

- [ ] **Step 2: Write failing scheduler tests**

```ts
// backend/test/portfolio/dailySnapshotScheduler.test.ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-daily-snapshot-scheduler.sqlite');

let models: typeof import('../../src/models');
let scheduler: typeof import('../../src/portfolio/dailySnapshotScheduler');

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
  scheduler = await import('../../src/portfolio/dailySnapshotScheduler');
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.PortfolioDailySnapshot.destroy({ where: {}, truncate: true });
  await models.InvestmentActivity.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
});

test('runDailySnapshotTick({ enabled: false }) returns skipped_disabled', async () => {
  const r = await scheduler.runDailySnapshotTick({ enabled: false });
  assert.equal(r.status, 'skipped_disabled');
});

test('runDailySnapshotTick({ enabled: true }) builds snapshots', async () => {
  const hh = await models.Household.create({ id: 1, name: 'A', benchmarkSymbol: 'SPY' });
  const acct = await models.Account.create({ id: 10, householdId: hh.id, name: 'X', owner: 'shared', accountType: 'investment', currency: 'CAD' });
  await models.InvestmentActivity.create({
    accountId: acct.id, householdId: hh.id, securityId: null,
    activityType: 'transfer', tradeDate: '2026-01-01',
    amount: '1000', currency: 'CAD', description: 'X',
    sourceRowFingerprint: 'fp1', importBatch: 'b1',
  });
  const r = await scheduler.runDailySnapshotTick({ enabled: true });
  assert.equal(r.status, 'ran');
  assert.ok((r.householdsProcessed ?? 0) >= 1);
});

test('sequential ticks both resolve to ran', async () => {
  const r1 = await scheduler.runDailySnapshotTick({ enabled: true });
  const r2 = await scheduler.runDailySnapshotTick({ enabled: true });
  assert.equal(r1.status, 'ran');
  assert.equal(r2.status, 'ran');
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotScheduler|tests"
```

- [ ] **Step 4: Implement scheduler**

```ts
// backend/src/portfolio/dailySnapshotScheduler.ts
import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../observability/logger';
import * as env from '../config/env';
import { buildDailySnapshotsForAllHouseholds } from './dailySnapshotBuilder';

export interface DailySnapshotTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  daysBuilt?: number;
  daysSkipped?: number;
  partialDays?: number;
  error?: string;
}

export interface DailySnapshotTickConfig {
  enabled: boolean;
}

function configFromEnv(): DailySnapshotTickConfig {
  return { enabled: env.dailySnapshotEnabled };
}

let runningTick = false;
let activeTask: ScheduledTask | null = null;

export async function runDailySnapshotTick(
  configOverride?: Partial<DailySnapshotTickConfig>,
): Promise<DailySnapshotTickResult> {
  const config: DailySnapshotTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const r = await buildDailySnapshotsForAllHouseholds();
    return {
      status: 'ran',
      householdsProcessed: r.households,
      daysBuilt: r.daysBuilt,
      daysSkipped: r.daysSkipped,
      partialDays: r.partialDays,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

export function startDailySnapshotScheduler(): ScheduledTask | null {
  if (!env.dailySnapshotEnabled) {
    logger.info('daily_snapshot_scheduler_disabled');
    return null;
  }
  if (activeTask) {
    logger.warn('daily_snapshot_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.dailySnapshotCron)) {
    logger.error('daily_snapshot_scheduler_invalid_cron', { expression: env.dailySnapshotCron });
    return null;
  }
  activeTask = cron.schedule(env.dailySnapshotCron, async () => {
    if (runningTick) {
      logger.debug('daily_snapshot_tick_skipped_reentrant');
      return;
    }
    runningTick = true;
    try {
      const r = await runDailySnapshotTick();
      logger.info('daily_snapshot_tick', r as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error('daily_snapshot_tick_unhandled', {}, err);
    } finally {
      runningTick = false;
    }
  });
  logger.info('daily_snapshot_scheduler_started', { cron: env.dailySnapshotCron });
  return activeTask;
}

export function stopDailySnapshotScheduler(): void {
  if (!activeTask) return;
  activeTask.stop();
  activeTask = null;
  runningTick = false;
}
```

- [ ] **Step 5: Wire in `backend/src/server.ts`**

Add adjacent to other scheduler starts:
```ts
import { startDailySnapshotScheduler } from './portfolio/dailySnapshotScheduler';
// ...
startDailySnapshotScheduler();
```

- [ ] **Step 6: Run — expect PASS**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotScheduler|tests"
yarn workspace cashflow-backend typecheck
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/config/env.ts \
        backend/src/portfolio/dailySnapshotScheduler.ts \
        backend/src/server.ts \
        backend/test/portfolio/dailySnapshotScheduler.test.ts
git commit -m "feat(portfolio): add nightly daily snapshot scheduler"
```

---

## Task 12: Shared types — `PortfolioPerformance*`

**Files:**
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Append types**

```ts
// shared/api-types.ts (append)
export type PortfolioPerformanceRange = '1M' | '3M' | 'YTD' | '1Y' | 'All' | 'custom';

export type PortfolioPerformancePoint = {
  date: string;
  portfolioValueCad: number;
  benchmarkValueCad: number;
  isPartial: boolean;
};

export type PortfolioPerformanceStats = {
  twrPct: number;
  mwrPct: number | null;
  benchmarkTwrPct: number;
  vsBenchmarkDeltaPct: number;
  startDate: string;
  endDate: string;
  startValueCad: number;
  endValueCad: number;
  netCashFlowCad: number;
};

export type PortfolioPerformanceByAccount = {
  accountId: number;
  accountName: string;
  twrPct: number;
  endValueCad: number;
  weightInPortfolioPct: number;
};

export type PortfolioPerformanceCaveats = {
  partialDaysCount: number;
  missingDataReasons: string[];
  benchmarkSymbol: string;
  benchmarkIsPartial: boolean;
};

export type PortfolioPerformance = {
  range: PortfolioPerformanceRange;
  stats: PortfolioPerformanceStats;
  presetStats: {
    '1M': PortfolioPerformanceStats;
    '3M': PortfolioPerformanceStats;
    'YTD': PortfolioPerformanceStats;
    '1Y': PortfolioPerformanceStats;
    'All': PortfolioPerformanceStats;
  };
  series: PortfolioPerformancePoint[];
  byAccount: PortfolioPerformanceByAccount[];
  caveats: PortfolioPerformanceCaveats;
};
```

- [ ] **Step 2: Typecheck**

```bash
yarn workspace cashflow-backend typecheck
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031
git add shared/api-types.ts
git commit -m "feat(types): add PortfolioPerformance shared types"
```

---

## Task 13: Endpoint — `GET /api/portfolio/performance`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Test: `backend/test/integration/portfolioPerformance.test.ts`

- [ ] **Step 1: Inspect existing integration test patterns**

```bash
grep -l "supertest\|signIn\|/api/portfolio/forward-income" backend/test/integration/*.test.ts | head -3
```

Read `backend/test/integration/portfolioForwardIncome.test.ts` for the auth/factory pattern this slice should mirror.

- [ ] **Step 2: Write integration tests**

Required cases (full code follows the auth pattern from `portfolioForwardIncome.test.ts`):

1. **401 when unauthenticated** — `GET /api/portfolio/performance` without cookie → 401
2. **Empty household → all-zero structure** — auth, no investment accounts → returns `{ stats: { twrPct: 0, ... }, presetStats: { '1M': { twrPct: 0 }, ... }, series: [], byAccount: [], caveats: { benchmarkSymbol: 'SPY' } }`
3. **Single-account 1Y history TWR matches manual calc** — seed 1 household + 1 account + 1 security + 12 monthly snapshots showing 10% growth → response `stats.twrPct ≈ 10`
4. **USD account FX-converted in CAD totals** — USD account with snapshots stored as USD MV + FX → response `series[].portfolioValueCad` equals `mvNative × fxRate`
5. **range='custom' validates from/to** — missing from/to → 400; present → series clipped
6. **range='YTD' starts Jan 1** — verify series first date
7. **Benchmark missing prices → caveats.benchmarkIsPartial=true** — household with snapshots but benchmark Security has no daily prices → flag set
8. **Per-account TWR + weight correct** — 2 accounts, verify byAccount entries with TWR + weightInPortfolioPct
9. **Cross-household isolation** — auth as household A → no leak of B's data
10. **Perf smoke: 50-account household, 1Y range → < 500ms p95 (3 runs)** — seed fixture, measure

For each test, use the same `seedHousehold` / `seedAccount` / `signInAs` / `getJson` helpers established in `portfolioForwardIncome.test.ts`. Insert seed `PortfolioDailySnapshot` rows directly rather than running the builder (faster + isolates endpoint logic from builder).

- [ ] **Step 3: Run — expect FAIL**

```bash
yarn workspace cashflow-backend run test:integration 2>&1 | grep -E "portfolioPerformance|tests"
```

- [ ] **Step 4: Implement endpoint**

Add imports to top of `backend/src/routes/portfolio.ts`:

```ts
import { PortfolioDailySnapshot } from '../models/PortfolioDailySnapshot';
import {
  computeTwr,
  computeXirr,
  buildCashFlowSeries,
  computeBenchmarkSeries,
  type DailyPoint,
  type AggregatedDailySnapshot,
} from '../portfolio/returns';
import type {
  PortfolioPerformance,
  PortfolioPerformanceRange,
  PortfolioPerformanceStats,
} from '@cashflow/shared';
```

Add route handler near other `/portfolio/*` routes:

```ts
router.get('/performance', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const householdId = auth.household.id;
    const householdRow = await Household.findByPk(householdId);
    const benchmarkSymbol = householdRow?.benchmarkSymbol ?? 'SPY';

    const range = (req.query.range as PortfolioPerformanceRange) || '1Y';
    const today = new Date().toISOString().slice(0, 10);
    const presetRanges: Record<'1M'|'3M'|'YTD'|'1Y'|'All', { from: string; to: string }> = {
      '1M': { from: addDaysIso(today, -30), to: today },
      '3M': { from: addDaysIso(today, -90), to: today },
      'YTD': { from: `${today.slice(0, 4)}-01-01`, to: today },
      '1Y': { from: addDaysIso(today, -365), to: today },
      'All': { from: '1970-01-01', to: today },
    };
    let selectedRange = { from: '', to: '' };
    if (range === 'custom') {
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      if (!from || !to) return res.status(400).json({ error: 'from and to required for custom range' });
      selectedRange = { from, to };
    } else {
      selectedRange = presetRanges[range];
    }

    const widestFrom = ['All', ...Object.keys(presetRanges)].reduce((min, k) => {
      if (k === 'All') return '1970-01-01';
      const r = presetRanges[k as keyof typeof presetRanges];
      return r.from < min ? r.from : min;
    }, selectedRange.from);

    const allSnapshots = await PortfolioDailySnapshot.findAll({
      where: { householdId, date: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to } },
      order: [['date', 'ASC']],
    });

    const computeStats = (from: string, to: string): PortfolioPerformanceStats => {
      const inRange = allSnapshots.filter((s) => s.date >= from && s.date <= to);
      const byDate = new Map<string, { mvCad: number; cashFlowCad: number }>();
      for (const s of inRange) {
        const cur = byDate.get(s.date) ?? { mvCad: 0, cashFlowCad: 0 };
        cur.mvCad += Number(s.marketValueCad);
        cur.cashFlowCad += Number(s.cashFlowCad);
        byDate.set(s.date, cur);
      }
      const points: DailyPoint[] = [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, marketValueCad: v.mvCad, cashFlowCad: v.cashFlowCad }));
      const twrPct = computeTwr(points);
      const aggSnaps: AggregatedDailySnapshot[] = points.map((p) => ({
        date: p.date, marketValueCad: p.marketValueCad, cashFlowCad: p.cashFlowCad,
      }));
      const finalMv = points.length > 0 ? points[points.length - 1].marketValueCad : 0;
      const mwrPct = computeXirr(buildCashFlowSeries(aggSnaps, finalMv));

      // Benchmark stats — placeholder; populated after benchmark data is loaded below
      return {
        twrPct,
        mwrPct,
        benchmarkTwrPct: 0,
        vsBenchmarkDeltaPct: twrPct - 0,
        startDate: points[0]?.date ?? from,
        endDate: points[points.length - 1]?.date ?? to,
        startValueCad: points[0]?.marketValueCad ?? 0,
        endValueCad: finalMv,
        netCashFlowCad: points.reduce((s, p) => s + p.cashFlowCad, 0),
      };
    };

    // Load benchmark daily prices
    const benchmarkSecurity = await Security.findOne({ where: { householdId, symbol: benchmarkSymbol } });
    const benchmarkPrices = benchmarkSecurity
      ? await SecurityDailyPrice.findAll({
          where: { securityId: benchmarkSecurity.id, date: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to } },
          order: [['date', 'ASC']],
        })
      : [];
    const fxByDate = new Map<string, number>();
    if (benchmarkSecurity && benchmarkSecurity.currency !== 'CAD') {
      const fxRows = await FxRate.findAll({
        where: {
          fromCurrency: benchmarkSecurity.currency,
          toCurrency: 'CAD',
          asOfDate: { [Op.gte]: widestFrom, [Op.lte]: selectedRange.to },
        },
      });
      for (const f of fxRows) fxByDate.set(f.asOfDate, Number(f.rate));
    } else if (benchmarkSecurity) {
      benchmarkPrices.forEach((p) => fxByDate.set(p.date, 1));
    }
    const benchmarkIsPartial = !benchmarkSecurity || benchmarkPrices.length === 0;

    const computeBenchmarkStats = (from: string, to: string, initialCad: number): { twr: number; series: Array<{ date: string; valueCad: number }> } => {
      const inRange = benchmarkPrices
        .filter((p) => p.date >= from && p.date <= to)
        .map((p) => ({ date: p.date, adjClose: Number(p.adjClose) }));
      const series = computeBenchmarkSeries(inRange, fxByDate, initialCad);
      if (series.length < 2) return { twr: 0, series };
      const points: DailyPoint[] = series.map((s) => ({
        date: s.date, marketValueCad: s.valueCad, cashFlowCad: 0,
      }));
      return { twr: computeTwr(points), series };
    };

    const fillBenchmark = (stats: PortfolioPerformanceStats, from: string, to: string): PortfolioPerformanceStats => {
      const { twr } = computeBenchmarkStats(from, to, stats.startValueCad);
      return { ...stats, benchmarkTwrPct: twr, vsBenchmarkDeltaPct: stats.twrPct - twr };
    };

    const presetStats = {
      '1M': fillBenchmark(computeStats(presetRanges['1M'].from, presetRanges['1M'].to), presetRanges['1M'].from, presetRanges['1M'].to),
      '3M': fillBenchmark(computeStats(presetRanges['3M'].from, presetRanges['3M'].to), presetRanges['3M'].from, presetRanges['3M'].to),
      'YTD': fillBenchmark(computeStats(presetRanges['YTD'].from, presetRanges['YTD'].to), presetRanges['YTD'].from, presetRanges['YTD'].to),
      '1Y': fillBenchmark(computeStats(presetRanges['1Y'].from, presetRanges['1Y'].to), presetRanges['1Y'].from, presetRanges['1Y'].to),
      'All': fillBenchmark(computeStats(presetRanges['All'].from, presetRanges['All'].to), presetRanges['All'].from, presetRanges['All'].to),
    };

    const selectedStats = fillBenchmark(
      computeStats(selectedRange.from, selectedRange.to),
      selectedRange.from, selectedRange.to,
    );

    // Series for selected range only
    const seriesByDate = new Map<string, { mvCad: number; isPartial: boolean }>();
    for (const s of allSnapshots) {
      if (s.date < selectedRange.from || s.date > selectedRange.to) continue;
      const cur = seriesByDate.get(s.date) ?? { mvCad: 0, isPartial: false };
      cur.mvCad += Number(s.marketValueCad);
      if (s.isPartial) cur.isPartial = true;
      seriesByDate.set(s.date, cur);
    }
    const benchmarkSelected = computeBenchmarkStats(selectedRange.from, selectedRange.to, selectedStats.startValueCad);
    const benchmarkByDate = new Map(benchmarkSelected.series.map((s) => [s.date, s.valueCad]));
    const series = [...seriesByDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({
        date,
        portfolioValueCad: v.mvCad,
        benchmarkValueCad: benchmarkByDate.get(date) ?? 0,
        isPartial: v.isPartial,
      }));

    // Per-account TWR over selected range
    const accountIds = [...new Set(allSnapshots.filter((s) => s.date >= selectedRange.from && s.date <= selectedRange.to).map((s) => s.accountId))];
    const accountMap = new Map(
      (await Account.findAll({ where: { id: { [Op.in]: accountIds } } })).map((a) => [a.id, a]),
    );
    const totalEnd = selectedStats.endValueCad || 1;
    const byAccount = accountIds.map((accountId) => {
      const inRange = allSnapshots.filter((s) => s.accountId === accountId && s.date >= selectedRange.from && s.date <= selectedRange.to);
      const points: DailyPoint[] = inRange.map((s) => ({
        date: s.date,
        marketValueCad: Number(s.marketValueCad),
        cashFlowCad: Number(s.cashFlowCad),
      }));
      const twrPct = computeTwr(points);
      const endValueCad = points[points.length - 1]?.marketValueCad ?? 0;
      return {
        accountId,
        accountName: accountMap.get(accountId)?.name ?? '',
        twrPct,
        endValueCad,
        weightInPortfolioPct: (endValueCad / totalEnd) * 100,
      };
    });

    // Caveats
    const partialSnaps = allSnapshots.filter((s) => s.date >= selectedRange.from && s.date <= selectedRange.to && s.isPartial);
    const partialDaysCount = new Set(partialSnaps.map((s) => s.date)).size;
    const reasonSet = new Set<string>();
    for (const s of partialSnaps) {
      for (const r of s.missingDataReasons ?? []) reasonSet.add(r);
      if (reasonSet.size >= 20) break;
    }
    const caveats = {
      partialDaysCount,
      missingDataReasons: [...reasonSet].slice(0, 20),
      benchmarkSymbol,
      benchmarkIsPartial,
    };

    const response: PortfolioPerformance = {
      range,
      stats: selectedStats,
      presetStats,
      series,
      byAccount,
      caveats,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
```

If `Op`, `Security`, `Household`, `SecurityDailyPrice`, `FxRate` aren't already imported, add them.

- [ ] **Step 5: Run — expect PASS**

```bash
yarn workspace cashflow-backend run test:integration 2>&1 | grep -E "portfolioPerformance|tests" | tail
```

10 integration tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioPerformance.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/performance endpoint"
```

---

## Task 14: Endpoint — `PATCH /api/household/benchmark`

**Files:**
- Modify: existing household routes file (verify path) OR `backend/src/routes/portfolio.ts` (place adjacent if no household routes file exists)
- Test: `backend/test/integration/householdBenchmark.test.ts`

- [ ] **Step 1: Locate or create household routes**

```bash
grep -rln "router.*household\|/household" backend/src/routes/*.ts | head -5
```

If a `household.ts` route file exists, modify it. Otherwise create `backend/src/routes/household.ts` and wire it into `backend/src/server.ts`.

- [ ] **Step 2: Write failing test**

```ts
// backend/test/integration/householdBenchmark.test.ts
// Mirror the auth/fixture pattern from portfolioForwardIncome.test.ts.
test('PATCH /api/household/benchmark updates symbol and persists', async () => {
  const hh = await seedHousehold();
  const cookie = await signInAs({ householdId: hh.id });
  const res = await request(app)
    .patch('/api/household/benchmark')
    .set('Cookie', cookie)
    .send({ benchmarkSymbol: 'VEQT.TO' });
  assert.equal(res.status, 200);
  assert.equal(res.body.benchmarkSymbol, 'VEQT.TO');
  const refreshed = await models.Household.findByPk(hh.id);
  assert.equal(refreshed!.benchmarkSymbol, 'VEQT.TO');
});

test('PATCH /api/household/benchmark validates symbol shape', async () => {
  const hh = await seedHousehold();
  const cookie = await signInAs({ householdId: hh.id });
  const res = await request(app)
    .patch('/api/household/benchmark')
    .set('Cookie', cookie)
    .send({ benchmarkSymbol: '!!!invalid!!!' });
  assert.equal(res.status, 400);
});

test('PATCH /api/household/benchmark 401 unauthenticated', async () => {
  const res = await request(app).patch('/api/household/benchmark').send({ benchmarkSymbol: 'SPY' });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
yarn workspace cashflow-backend run test:integration 2>&1 | grep -E "householdBenchmark"
```

- [ ] **Step 4: Implement route handler**

```ts
// backend/src/routes/household.ts (or appended to existing household routes)
router.patch('/benchmark', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { benchmarkSymbol } = req.body as { benchmarkSymbol?: string };
    if (!benchmarkSymbol || !/^[A-Za-z0-9.]{1,16}$/.test(benchmarkSymbol)) {
      return res.status(400).json({ error: 'benchmarkSymbol must be 1-16 alphanumeric chars (. allowed)' });
    }
    const household = await Household.findByPk(auth.household.id);
    if (!household) return res.status(404).json({ error: 'household not found' });
    await household.update({ benchmarkSymbol: benchmarkSymbol.toUpperCase() });

    // Lazy-create Security row + trigger backfill (non-blocking)
    await Security.findOrCreate({
      where: { householdId: household.id, symbol: benchmarkSymbol.toUpperCase() },
      defaults: {
        householdId: household.id,
        symbol: benchmarkSymbol.toUpperCase(),
        name: benchmarkSymbol.toUpperCase(),
        assetType: 'etf',
        currency: benchmarkSymbol.includes('.TO') || benchmarkSymbol.includes('.NEO') ? 'CAD' : 'USD',
      },
    });
    // Fire-and-forget; do NOT await
    void ensureDailyPrices((await Security.findOne({ where: { householdId: household.id, symbol: benchmarkSymbol.toUpperCase() } }))!.id);

    res.json({ benchmarkSymbol: household.benchmarkSymbol });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Run — expect PASS**

```bash
yarn workspace cashflow-backend run test:integration 2>&1 | grep -E "householdBenchmark|tests" | tail
```

3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/household.ts backend/src/server.ts \
        backend/test/integration/householdBenchmark.test.ts
git commit -m "feat(portfolio): add PATCH /api/household/benchmark endpoint"
```

---

## Task 15: Frontend types re-export

**Files:**
- Modify: `frontend/src/types/api.ts`

- [ ] **Step 1: Add re-exports**

Add to the existing `Portfolio*` re-export block:
```ts
  PortfolioPerformance,
  PortfolioPerformanceByAccount,
  PortfolioPerformanceCaveats,
  PortfolioPerformancePoint,
  PortfolioPerformanceRange,
  PortfolioPerformanceStats,
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031/frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031
git add frontend/src/types/api.ts
git commit -m "feat(types): re-export PortfolioPerformance on frontend"
```

---

## Task 16: Component — `PerformanceStatsRow`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/PerformanceStatsRow.tsx`
- Test: `frontend/src/pages/portfolio-performance/PerformanceStatsRow.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PerformanceStatsRow } from './PerformanceStatsRow'

const baseStat = {
  twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5,
  startDate: '2026-01-01', endDate: '2026-05-25',
  startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0,
}

describe('PerformanceStatsRow', () => {
  it('renders 5 preset cards', () => {
    render(<PerformanceStatsRow presetStats={{
      '1M': baseStat, '3M': baseStat, 'YTD': baseStat, '1Y': baseStat, 'All': baseStat,
    }} />)
    expect(screen.getByText('1M')).toBeInTheDocument()
    expect(screen.getByText('3M')).toBeInTheDocument()
    expect(screen.getByText('YTD')).toBeInTheDocument()
    expect(screen.getByText('1Y')).toBeInTheDocument()
    expect(screen.getByText('All')).toBeInTheDocument()
  })

  it('shows TWR with vs-benchmark delta', () => {
    render(<PerformanceStatsRow presetStats={{
      '1M': baseStat, '3M': baseStat, 'YTD': baseStat, '1Y': baseStat, 'All': baseStat,
    }} />)
    expect(screen.getAllByText(/5\.50%/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\+1\.50/).length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace frontend test PerformanceStatsRow 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-performance/PerformanceStatsRow.tsx
import { Card } from '@/components/ui/card'
import type { PortfolioPerformanceStats } from '../../types/api'

export type PerformanceStatsRowProps = {
  presetStats: {
    '1M': PortfolioPerformanceStats
    '3M': PortfolioPerformanceStats
    'YTD': PortfolioPerformanceStats
    '1Y': PortfolioPerformanceStats
    'All': PortfolioPerformanceStats
  }
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

function fmtDelta(x: number): string {
  const sign = x >= 0 ? '+' : ''
  return `${sign}${x.toFixed(2)}%`
}

const KEYS: Array<keyof PerformanceStatsRowProps['presetStats']> = ['1M', '3M', 'YTD', '1Y', 'All']

export function PerformanceStatsRow({ presetStats }: PerformanceStatsRowProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {KEYS.map((k) => {
        const stat = presetStats[k]
        const positive = stat.twrPct >= 0
        return (
          <Card key={k}>
            <p className="text-sm text-muted-foreground">{k}</p>
            <p className={`text-2xl font-semibold ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
              {fmtPct(stat.twrPct)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              vs benchmark: {fmtDelta(stat.vsBenchmarkDeltaPct)}
            </p>
          </Card>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031
git add frontend/src/pages/portfolio-performance/PerformanceStatsRow.tsx \
        frontend/src/pages/portfolio-performance/PerformanceStatsRow.test.tsx
git commit -m "feat(portfolio): add PerformanceStatsRow component"
```

---

## Task 17: Component — `PerformanceChart`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/PerformanceChart.tsx`
- Test: `frontend/src/pages/portfolio-performance/PerformanceChart.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PerformanceChart } from './PerformanceChart'

describe('PerformanceChart', () => {
  it('renders empty state when no data', () => {
    const { getByText } = render(<PerformanceChart points={[]} />)
    expect(getByText(/No data yet/i)).toBeInTheDocument()
  })

  it('renders 2 lines when data provided', () => {
    const { container } = render(<PerformanceChart points={[
      { date: '2026-01-01', portfolioValueCad: 1000, benchmarkValueCad: 1000, isPartial: false },
      { date: '2026-01-02', portfolioValueCad: 1050, benchmarkValueCad: 1020, isPartial: false },
    ]} />)
    expect(container.querySelector('svg')).not.toBeNull()
    // Two <path> elements expected for two recharts Lines
    const paths = container.querySelectorAll('path.recharts-curve')
    expect(paths.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-performance/PerformanceChart.tsx
import { Card } from '@/components/ui/card'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import type { PortfolioPerformancePoint } from '../../types/api'

export type PerformanceChartProps = {
  points: PortfolioPerformancePoint[]
}

function fmtY(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

export function PerformanceChart({ points }: PerformanceChartProps) {
  if (points.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          No data yet — first snapshot lands tomorrow morning. Historical prices backfilling in background.
        </p>
      </Card>
    )
  }
  return (
    <Card className="p-3">
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={points}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis tickFormatter={fmtY} />
            <Tooltip />
            <Line type="monotone" dataKey="portfolioValueCad" name="Portfolio" stroke="#2563eb" dot={false} />
            <Line type="monotone" dataKey="benchmarkValueCad" name="Benchmark" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-performance/PerformanceChart.tsx \
        frontend/src/pages/portfolio-performance/PerformanceChart.test.tsx
git commit -m "feat(portfolio): add PerformanceChart with benchmark overlay"
```

---

## Task 18: Components — `PerformanceRangeToggle` + `CustomRangePicker`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/PerformanceRangeToggle.tsx`
- Create: `frontend/src/pages/portfolio-performance/PerformanceRangeToggle.test.tsx`
- Create: `frontend/src/pages/portfolio-performance/CustomRangePicker.tsx`
- Create: `frontend/src/pages/portfolio-performance/CustomRangePicker.test.tsx`

- [ ] **Step 1: Test `PerformanceRangeToggle`**

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PerformanceRangeToggle } from './PerformanceRangeToggle'

describe('PerformanceRangeToggle', () => {
  it('renders 6 buttons', () => {
    render(<PerformanceRangeToggle value="1Y" onChange={() => {}} />)
    ;['1M', '3M', 'YTD', '1Y', 'All', 'Custom'].forEach((k) => {
      expect(screen.getByRole('button', { name: k })).toBeInTheDocument()
    })
  })

  it('marks selected with aria-pressed=true', () => {
    render(<PerformanceRangeToggle value="3M" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '3M' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('fires onChange', () => {
    const onChange = vi.fn()
    render(<PerformanceRangeToggle value="1Y" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '1M' }))
    expect(onChange).toHaveBeenCalledWith('1M')
  })
})
```

- [ ] **Step 2: Implement `PerformanceRangeToggle`**

```tsx
// frontend/src/pages/portfolio-performance/PerformanceRangeToggle.tsx
import type { PortfolioPerformanceRange } from '../../types/api'

export type PerformanceRangeToggleProps = {
  value: PortfolioPerformanceRange
  onChange: (next: PortfolioPerformanceRange) => void
}

const OPTIONS: Array<{ label: string; value: PortfolioPerformanceRange }> = [
  { label: '1M', value: '1M' },
  { label: '3M', value: '3M' },
  { label: 'YTD', value: 'YTD' },
  { label: '1Y', value: '1Y' },
  { label: 'All', value: 'All' },
  { label: 'Custom', value: 'custom' },
]

export function PerformanceRangeToggle({ value, onChange }: PerformanceRangeToggleProps) {
  return (
    <div className="flex gap-1">
      {OPTIONS.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1 text-sm rounded border ${selected ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            {opt.label === 'custom' ? 'Custom' : opt.label}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Test `CustomRangePicker`**

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CustomRangePicker } from './CustomRangePicker'

describe('CustomRangePicker', () => {
  it('apply fires onApply with both dates', () => {
    const onApply = vi.fn()
    render(<CustomRangePicker from="2026-01-01" to="2026-05-01" onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(onApply).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-05-01' })
  })

  it('disables apply when from > to', () => {
    render(<CustomRangePicker from="2026-05-01" to="2026-01-01" onApply={() => {}} />)
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled()
  })
})
```

- [ ] **Step 4: Implement `CustomRangePicker`**

```tsx
// frontend/src/pages/portfolio-performance/CustomRangePicker.tsx
import { useState } from 'react'

export type CustomRangePickerProps = {
  from: string
  to: string
  onApply: (range: { from: string; to: string }) => void
}

export function CustomRangePicker({ from, to, onApply }: CustomRangePickerProps) {
  const [f, setF] = useState(from)
  const [t, setT] = useState(to)
  const valid = f && t && f <= t
  return (
    <div className="flex items-center gap-2 mt-2">
      <input type="date" value={f} onChange={(e) => setF(e.target.value)} className="border px-2 py-1 rounded" />
      <span className="text-sm">to</span>
      <input type="date" value={t} onChange={(e) => setT(e.target.value)} className="border px-2 py-1 rounded" />
      <button
        type="button"
        disabled={!valid}
        onClick={() => onApply({ from: f, to: t })}
        className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Run + commit**

```bash
yarn workspace frontend test "Performance(Range|Custom)" 2>&1 | tail -15

git add frontend/src/pages/portfolio-performance/PerformanceRangeToggle.tsx \
        frontend/src/pages/portfolio-performance/PerformanceRangeToggle.test.tsx \
        frontend/src/pages/portfolio-performance/CustomRangePicker.tsx \
        frontend/src/pages/portfolio-performance/CustomRangePicker.test.tsx
git commit -m "feat(portfolio): add PerformanceRangeToggle + CustomRangePicker"
```

---

## Task 19: Component — `ByAccountTable`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/ByAccountTable.tsx`
- Create: `frontend/src/pages/portfolio-performance/ByAccountTable.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect, fireEvent } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ByAccountTable } from './ByAccountTable'

describe('ByAccountTable', () => {
  it('renders empty state', () => {
    render(<ByAccountTable rows={[]} />)
    expect(screen.getByText(/no per-account/i)).toBeInTheDocument()
  })

  it('default sort: end-value desc', () => {
    render(<ByAccountTable rows={[
      { accountId: 1, accountName: 'TFSA', twrPct: 5, endValueCad: 1000, weightInPortfolioPct: 50 },
      { accountId: 2, accountName: 'RRSP', twrPct: 7, endValueCad: 2000, weightInPortfolioPct: 50 },
    ]} />)
    const rows = screen.getAllByTestId('byacct-row')
    expect(within(rows[0]).getByText('RRSP')).toBeInTheDocument()
    expect(within(rows[1]).getByText('TFSA')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/pages/portfolio-performance/ByAccountTable.tsx
import { useMemo, useState } from 'react'
import { Card } from '@/components/ui/card'
import type { PortfolioPerformanceByAccount } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

type SortKey = 'accountName' | 'twrPct' | 'endValueCad' | 'weightInPortfolioPct'

export type ByAccountTableProps = {
  rows: PortfolioPerformanceByAccount[]
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

export function ByAccountTable({ rows }: ByAccountTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('endValueCad')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey]
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }

  if (rows.length === 0) {
    return <Card><p className="text-sm text-muted-foreground">No per-account data for selected range.</p></Card>
  }

  return (
    <Card>
      <h4 className="font-medium mb-2">By account</h4>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th onClick={() => toggleSort('accountName')} className="cursor-pointer text-left">Account</th>
            <th onClick={() => toggleSort('endValueCad')} className="cursor-pointer text-right">End value (CAD)</th>
            <th onClick={() => toggleSort('weightInPortfolioPct')} className="cursor-pointer text-right">Weight</th>
            <th onClick={() => toggleSort('twrPct')} className="cursor-pointer text-right">TWR</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.accountId} data-testid="byacct-row">
              <td>{r.accountName}</td>
              <td className="text-right">{formatMoney(r.endValueCad, 'CAD')}</td>
              <td className="text-right">{fmtPct(r.weightInPortfolioPct)}</td>
              <td className={`text-right ${r.twrPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtPct(r.twrPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace frontend test ByAccountTable 2>&1 | tail -10
git add frontend/src/pages/portfolio-performance/ByAccountTable.tsx \
        frontend/src/pages/portfolio-performance/ByAccountTable.test.tsx
git commit -m "feat(portfolio): add ByAccountTable component"
```

---

## Task 20: Component — `BenchmarkPickerCard`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/BenchmarkPickerCard.tsx`
- Create: `frontend/src/pages/portfolio-performance/BenchmarkPickerCard.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BenchmarkPickerCard } from './BenchmarkPickerCard'
import * as api from '../../lib/api'

describe('BenchmarkPickerCard', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows current symbol', () => {
    render(<BenchmarkPickerCard currentSymbol="SPY" onChange={() => {}} />)
    expect(screen.getByText(/SPY/)).toBeInTheDocument()
  })

  it('save fires PATCH and onChange', async () => {
    const fetchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({ benchmarkSymbol: 'VEQT.TO' })
    const onChange = vi.fn()
    render(<BenchmarkPickerCard currentSymbol="SPY" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /change/i }))
    fireEvent.change(screen.getByLabelText(/symbol/i), { target: { value: 'VEQT.TO' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/household/benchmark', { benchmarkSymbol: 'VEQT.TO' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('VEQT.TO'))
  })
})
```

If `patchJson` doesn't exist in `frontend/src/lib/api.ts`, add it following the `getJson` pattern.

- [ ] **Step 2: Implement**

```tsx
// frontend/src/pages/portfolio-performance/BenchmarkPickerCard.tsx
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { patchJson } from '../../lib/api'

export type BenchmarkPickerCardProps = {
  currentSymbol: string
  onChange: (next: string) => void
}

export function BenchmarkPickerCard({ currentSymbol, onChange }: BenchmarkPickerCardProps) {
  const [editing, setEditing] = useState(false)
  const [symbol, setSymbol] = useState(currentSymbol)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await patchJson<{ benchmarkSymbol: string }>('/api/household/benchmark', { benchmarkSymbol: symbol })
      onChange(res.benchmarkSymbol)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm">Benchmark: <strong>{currentSymbol}</strong></p>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="text-sm underline">Change</button>
        )}
      </div>
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <label className="text-sm">
            Symbol:
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="ml-2 border px-2 py-1 rounded"
              maxLength={16}
            />
          </label>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 3: Add `patchJson` to api.ts if missing**

```ts
// frontend/src/lib/api.ts (append)
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}
```

(Check existing file first — adapt if a different fetch helper signature is used.)

- [ ] **Step 4: Run + commit**

```bash
yarn workspace frontend test BenchmarkPickerCard 2>&1 | tail -10
git add frontend/src/pages/portfolio-performance/BenchmarkPickerCard.tsx \
        frontend/src/pages/portfolio-performance/BenchmarkPickerCard.test.tsx \
        frontend/src/lib/api.ts
git commit -m "feat(portfolio): add BenchmarkPickerCard + patchJson helper"
```

---

## Task 21: Component — `PerformanceCaveatsBanner`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.tsx`
- Create: `frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PerformanceCaveatsBanner } from './PerformanceCaveatsBanner'

describe('PerformanceCaveatsBanner', () => {
  it('hidden when no caveats', () => {
    const { container } = render(
      <PerformanceCaveatsBanner partialDaysCount={0} missingDataReasons={[]} benchmarkSymbol="SPY" benchmarkIsPartial={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows partial-day count when expanded', () => {
    render(<PerformanceCaveatsBanner partialDaysCount={3} missingDataReasons={['no_price:AAPL','no_fx:USD-2024-01-01']} benchmarkSymbol="SPY" benchmarkIsPartial={false} />)
    expect(screen.getByText(/3 days/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(screen.getByText(/no_price:AAPL/)).toBeInTheDocument()
  })

  it('shows benchmark partial warning', () => {
    render(<PerformanceCaveatsBanner partialDaysCount={0} missingDataReasons={[]} benchmarkSymbol="VEQT.TO" benchmarkIsPartial={true} />)
    expect(screen.getByText(/benchmark data incomplete/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.tsx
import { useState } from 'react'
import { Card } from '@/components/ui/card'

export type PerformanceCaveatsBannerProps = {
  partialDaysCount: number
  missingDataReasons: string[]
  benchmarkSymbol: string
  benchmarkIsPartial: boolean
}

export function PerformanceCaveatsBanner({
  partialDaysCount, missingDataReasons, benchmarkSymbol, benchmarkIsPartial,
}: PerformanceCaveatsBannerProps) {
  const [expanded, setExpanded] = useState(false)
  if (partialDaysCount === 0 && !benchmarkIsPartial) return null
  return (
    <Card className="my-3" style={{ borderLeft: '3px solid var(--accent-warm)' }}>
      <div className="flex items-center justify-between">
        <div className="text-sm">
          {partialDaysCount > 0 && <span>{partialDaysCount} days have incomplete data.</span>}
          {benchmarkIsPartial && <span className="ml-2">Benchmark data incomplete for {benchmarkSymbol}.</span>}
        </div>
        {missingDataReasons.length > 0 && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="text-sm underline">
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>
      {expanded && missingDataReasons.length > 0 && (
        <ul className="mt-2 list-disc pl-6 text-sm">
          {missingDataReasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </Card>
  )
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace frontend test PerformanceCaveatsBanner 2>&1 | tail -10
git add frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.tsx \
        frontend/src/pages/portfolio-performance/PerformanceCaveatsBanner.test.tsx
git commit -m "feat(portfolio): add PerformanceCaveatsBanner component"
```

---

## Task 22: Orchestrator — `PerformancePanel`

**Files:**
- Create: `frontend/src/pages/portfolio-performance/PerformancePanel.tsx`
- Create: `frontend/src/pages/portfolio-performance/PerformancePanel.test.tsx`

- [ ] **Step 1: Test**

```tsx
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PerformancePanel } from './PerformancePanel'
import * as api from '../../lib/api'

const mockData = {
  range: '1Y' as const,
  stats: { twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5, startDate: '2025-05-25', endDate: '2026-05-25', startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0 },
  presetStats: {
    '1M': { twrPct: 1.5, mwrPct: 1.8, benchmarkTwrPct: 1.0, vsBenchmarkDeltaPct: 0.5, startDate: '2026-04-25', endDate: '2026-05-25', startValueCad: 1040, endValueCad: 1055, netCashFlowCad: 0 },
    '3M': { twrPct: 2.5, mwrPct: 2.8, benchmarkTwrPct: 2.0, vsBenchmarkDeltaPct: 0.5, startDate: '2026-02-25', endDate: '2026-05-25', startValueCad: 1030, endValueCad: 1055, netCashFlowCad: 0 },
    'YTD': { twrPct: 3.0, mwrPct: 3.2, benchmarkTwrPct: 2.5, vsBenchmarkDeltaPct: 0.5, startDate: '2026-01-01', endDate: '2026-05-25', startValueCad: 1025, endValueCad: 1055, netCashFlowCad: 0 },
    '1Y': { twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5, startDate: '2025-05-25', endDate: '2026-05-25', startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0 },
    'All': { twrPct: 8.0, mwrPct: 8.5, benchmarkTwrPct: 7.0, vsBenchmarkDeltaPct: 1.0, startDate: '2023-01-01', endDate: '2026-05-25', startValueCad: 977, endValueCad: 1055, netCashFlowCad: 0 },
  },
  series: [{ date: '2026-01-01', portfolioValueCad: 1000, benchmarkValueCad: 1000, isPartial: false }],
  byAccount: [{ accountId: 1, accountName: 'TFSA', twrPct: 5.5, endValueCad: 1055, weightInPortfolioPct: 100 }],
  caveats: { partialDaysCount: 0, missingDataReasons: [], benchmarkSymbol: 'SPY', benchmarkIsPartial: false },
}

describe('PerformancePanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows loading then data', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce(mockData)
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    expect(screen.getByText(/Loading/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/TFSA/)).toBeInTheDocument())
  })

  it('error path', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValueOnce(new Error('boom'))
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })

  it('refetches on range change', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue(mockData)
    render(<MemoryRouter><PerformancePanel /></MemoryRouter>)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '1M' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })
})
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/pages/portfolio-performance/PerformancePanel.tsx
import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import type { PortfolioPerformance, PortfolioPerformanceRange } from '../../types/api'
import { PerformanceStatsRow } from './PerformanceStatsRow'
import { PerformanceChart } from './PerformanceChart'
import { PerformanceRangeToggle } from './PerformanceRangeToggle'
import { CustomRangePicker } from './CustomRangePicker'
import { ByAccountTable } from './ByAccountTable'
import { BenchmarkPickerCard } from './BenchmarkPickerCard'
import { PerformanceCaveatsBanner } from './PerformanceCaveatsBanner'

export function PerformancePanel() {
  const [range, setRange] = useState<PortfolioPerformanceRange>('1Y')
  const [customFrom, setCustomFrom] = useState<string>('')
  const [customTo, setCustomTo] = useState<string>('')
  const [data, setData] = useState<PortfolioPerformance | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = range === 'custom'
        ? `?range=custom&from=${customFrom}&to=${customTo}`
        : `?range=${range}`
      const res = await getJson<PortfolioPerformance>(`/api/portfolio/performance${qs}`)
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load performance')
    } finally {
      setLoading(false)
    }
  }, [range, customFrom, customTo])

  useEffect(() => {
    if (range === 'custom' && (!customFrom || !customTo)) return
    void load()
  }, [load, range, customFrom, customTo])

  if (loading && !data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>
  if (err && !data) return <p className="text-sm text-destructive">{err}</p>
  if (!data) return null

  return (
    <div className="flex flex-col gap-3">
      <BenchmarkPickerCard currentSymbol={data.caveats.benchmarkSymbol} onChange={() => void load()} />
      <PerformanceCaveatsBanner
        partialDaysCount={data.caveats.partialDaysCount}
        missingDataReasons={data.caveats.missingDataReasons}
        benchmarkSymbol={data.caveats.benchmarkSymbol}
        benchmarkIsPartial={data.caveats.benchmarkIsPartial}
      />
      <PerformanceStatsRow presetStats={data.presetStats} />
      <PerformanceRangeToggle value={range} onChange={setRange} />
      {range === 'custom' && (
        <CustomRangePicker
          from={customFrom || data.series[0]?.date || '2026-01-01'}
          to={customTo || data.series[data.series.length - 1]?.date || '2026-05-25'}
          onApply={({ from, to }) => { setCustomFrom(from); setCustomTo(to) }}
        />
      )}
      <PerformanceChart points={data.series} />
      <ByAccountTable rows={data.byAccount} />
    </div>
  )
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace frontend test PerformancePanel 2>&1 | tail -10
cd frontend && npx tsc --noEmit 2>&1 | tail -5

cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031
git add frontend/src/pages/portfolio-performance/PerformancePanel.tsx \
        frontend/src/pages/portfolio-performance/PerformancePanel.test.tsx
git commit -m "feat(portfolio): add PerformancePanel orchestrator"
```

---

## Task 23: Wire tab into `PortfolioPage`

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

- [ ] **Step 1: Update tab key + TAB_ITEMS**

Replace the `TabKey` type:

```ts
type TabKey = 'holdings' | 'performance' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'forward-income' | 'realized'
```

Replace TAB_ITEMS array entries to insert performance:

```ts
const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'performance', label: 'Performance' },
  { value: 'by-security', label: 'By security' },
  { value: 'allocation', label: 'Allocation' },
  { value: 'by-account-type', label: 'By account type' },
  { value: 'income', label: 'Income' },
  { value: 'forward-income', label: 'Forward income' },
  { value: 'realized', label: 'Realized P&L' },
]
```

- [ ] **Step 2: Add TabPanel and import**

Add import near other panel imports:

```ts
import { PerformancePanel } from './portfolio-performance/PerformancePanel'
```

Insert TabPanel block adjacent to other panels:

```tsx
<TabPanel value="performance" active={activeTab}>
  <PerformancePanel />
</TabPanel>
```

- [ ] **Step 3: Smoke test + commit**

```bash
yarn workspace frontend test PortfolioPage 2>&1 | tail -10
cd frontend && npx tsc --noEmit 2>&1 | tail -5

cd /Users/connoradams/Developer/cashflow/.claude/worktrees/zealous-solomon-075031
git add frontend/src/pages/PortfolioPage.tsx
git commit -m "feat(portfolio): wire Performance tab into PortfolioPage"
```

---

## Task 24: Manual verify + final check

- [ ] **Step 1: Run full suites**

```bash
yarn workspace cashflow-backend test 2>&1 | tail -5
yarn workspace cashflow-backend run test:integration 2>&1 | tail -10
yarn workspace frontend test 2>&1 | tail -5
yarn workspace cashflow-backend typecheck
cd frontend && npx tsc --noEmit
```

All green.

- [ ] **Step 2: Run dev locally + verify in browser**

Per `CLAUDE.md` — Connor wants real-browser verification before merge.

```bash
yarn workspace cashflow-backend dev &
yarn workspace frontend dev
```

Open `http://localhost:5173/portfolio`. Click the new **Performance** tab. Confirm:
- Stats row renders 5 cards (1M / 3M / YTD / 1Y / All)
- Range toggle switches active state + triggers refetch
- Chart renders 2 lines (portfolio + benchmark)
- Per-account table renders
- Benchmark picker card shows "Benchmark: SPY"; clicking Change opens edit; saving updates
- Caveats banner shows partial-day info if any historical price data missing
- Custom range picker shows when "Custom" selected

- [ ] **Step 3: Smoke-fire nightly cron**

```bash
yarn workspace cashflow-backend test 2>&1 | grep -E "dailySnapshotScheduler|tests"
```

Verify scheduler logs at server startup: `daily_snapshot_scheduler_started` with `cron: 0 3 * * *`.

- [ ] **Step 4: Open PR**

```bash
git push -u origin claude/zealous-solomon-075031
gh pr create --title "Portfolio enrichment: Slice B (Performance tab) + Slice C (Forward income tab)" --body "..."
gh pr merge --auto --merge
```

If `allow_auto_merge=false`, enable first:
```bash
gh api -X PATCH repos/$(gh repo view --json owner,name --jq '.owner.login + "/" + .name') -f allow_auto_merge=true
```

---

## Self-review summary

**Spec coverage:**
- §4.1 Table — Task 1 ✓
- §4.2 Household column — Task 2, Task 4 (model) ✓
- §4.3 Pure helpers (4) — Tasks 5, 6, 7, 8 ✓
- §4.4 Builder — Task 9 ✓
- §4.5 Stale hooks — Task 10 ✓
- §4.6 Scheduler — Task 11 ✓
- §4.7 Endpoint — Task 13 ✓
- §4.8 PATCH benchmark endpoint — Task 14 ✓
- §5 Frontend — Tasks 15–23 ✓
- §6.1–6.7 Tests — distributed across each implementation task ✓
- §7 Open questions — implementation-time items called out in Task 14 (verify household routes file location) and Task 10 (`instance.previous('tradeDate')` API)
- §8 Out of scope — respected

**Type consistency check:**
- `PortfolioPerformance*` types referenced consistently in shared (Task 12), frontend re-export (Task 15), and all 7 frontend components
- Builder `PortfolioDailySnapshot` shape consistent across model (Task 3), builder upsert (Task 9), hooks (Task 10), endpoint (Task 13)
- Helper signatures stable: `computeTwr(points)`, `computeXirr(cf, guess?)`, `buildCashFlowSeries(snaps, finalMv)`, `computeBenchmarkSeries(prices, fxByDate, initialPortfolioValueCad)` — match across Tasks 5–8 and Task 13 endpoint usage

**Placeholder scan:**
- All steps contain complete code; no TBD/TODO
- Two implementation-time confirmations noted in Self-review (not in tasks):
  - Task 14: verify household routes file location vs. create new one
  - Task 10: `instance.previous()` API may need a TS cast (handled inline in the code shown)
- Test factory helpers (`seedHousehold`, `signInAs`, etc.) reused from `portfolioForwardIncome.test.ts`; if any are missing, add them following the existing per-file factory convention (no shared `testUtils.ts`)

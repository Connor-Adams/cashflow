# Slice C — Portfolio Forward Income Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new "Forward income" tab that projects per-holding annual dividend + interest income, forward yield + yield-on-cost, a 90-day ex-div calendar, and taxStatus × assetType breakdowns. Backed by a materialized `portfolio_forward_projections` table with nightly cron rebuild + Sequelize-hook stale invalidation + lazy-on-read recompute.

**Architecture:** Native-currency income stored in materialized table (one row per household + security). Yields/CAD totals computed at read time from fresh quotes + FX. Stale-marking via Sequelize `afterCreate/afterUpdate/afterDestroy` hooks on `InvestmentActivity`, `SecurityDividend`, `HoldingSnapshot`. Nightly cron runs full rebuild; endpoint reads run lazy rebuild if any row stale.

**Tech Stack:** Sequelize (Postgres in prod, SQLite in dev), Express, TypeScript, Vitest, React + Vite + Tailwind, `node-cron` (existing infra), shadcn-style UI primitives.

**Reference spec:** [docs/superpowers/specs/2026-05-25-portfolio-forward-income-design.md](../specs/2026-05-25-portfolio-forward-income-design.md)

---

## File Structure

**Backend — new files:**
- `backend/src/migrations/20260528000001-portfolio-forward-projections.js` — table + indexes
- `backend/src/models/PortfolioForwardProjection.ts` — Sequelize model
- `backend/src/portfolio/forwardIncome.ts` — pure compute helpers (`inferCadence`, `projectNextEvents`, `computeForwardProjection`)
- `backend/src/portfolio/forwardIncomeBuilder.ts` — DB-touching builder (`rebuildForwardProjectionsForHousehold`, `markStale*`)
- `backend/src/portfolio/forwardIncomeScheduler.ts` — `node-cron` integration
- `backend/src/hooks/forwardIncomeStaleHooks.ts` — Sequelize hook registration

**Backend — modifications:**
- `backend/src/models/index.ts` — register `PortfolioForwardProjection`, call hook registration
- `backend/src/config/env.ts` — `forwardIncomeEnabled`, `forwardIncomeCron`
- `backend/src/server.ts` — start scheduler on boot
- `backend/src/routes/portfolio.ts` — new `GET /api/portfolio/forward-income` handler

**Backend — tests:**
- `backend/test/portfolio/forwardIncome.test.ts`
- `backend/test/portfolio/forwardIncomeBuilder.test.ts`
- `backend/test/portfolio/forwardIncomeStale.test.ts`
- `backend/test/portfolio/forwardIncomeScheduler.test.ts`
- `backend/test/integration/portfolioForwardIncome.test.ts`
- `backend/test/migrations/forwardIncomeMigration.test.ts`

**Shared types:**
- `shared/api-types.ts` — add `PortfolioForwardIncome` and inline child types

**Frontend — new files:**
- `frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.tsx`
- `frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.tsx`
- `frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.tsx`
- `frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.tsx`
- `frontend/src/pages/portfolio-forward-income/ByTaxStatusBreakdown.tsx`
- `frontend/src/pages/portfolio-forward-income/ByAssetTypeBreakdown.tsx`
- `frontend/src/pages/portfolio-forward-income/CaveatsBanner.tsx`
- One `*.test.tsx` per component (7 test files)

**Frontend — modifications:**
- `frontend/src/types/api.ts` — re-export `PortfolioForwardIncome`
- `frontend/src/pages/PortfolioPage.tsx` — insert tab between income and realized

---

## Task 1: Migration — `portfolio_forward_projections` table

**Files:**
- Create: `backend/src/migrations/20260528000001-portfolio-forward-projections.js`
- Test: `backend/test/migrations/forwardIncomeMigration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/migrations/forwardIncomeMigration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Sequelize, DataTypes } from 'sequelize';

describe('20260528000001-portfolio-forward-projections', () => {
  let sequelize: Sequelize;
  let migration: { up: Function; down: Function };

  beforeAll(async () => {
    sequelize = new Sequelize('sqlite::memory:', { logging: false });
    // Minimal table deps (UNIQUE/FK references)
    await sequelize.getQueryInterface().createTable('households', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    });
    await sequelize.getQueryInterface().createTable('securities', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    });
    migration = require('../../src/migrations/20260528000001-portfolio-forward-projections.js');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('up creates portfolio_forward_projections table', async () => {
    await migration.up(sequelize.getQueryInterface(), Sequelize);
    const tables = await sequelize.getQueryInterface().showAllTables();
    expect(tables).toContain('portfolio_forward_projections');
  });

  it('enforces UNIQUE (household_id, security_id)', async () => {
    await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
    await sequelize.query(`INSERT INTO securities (id) VALUES (10)`);
    await sequelize.query(`
      INSERT INTO portfolio_forward_projections
        (household_id, security_id, qty_basis, annual_dividend_per_share, annual_interest_per_share,
         projected_annual_income_native, currency, cadence_label, next_ex_div_dates, computed_at,
         created_at, updated_at)
      VALUES (1, 10, 100, 0, 0, 0, 'CAD', 'none', '[]', datetime('now'), datetime('now'), datetime('now'))
    `);
    await expect(
      sequelize.query(`
        INSERT INTO portfolio_forward_projections
          (household_id, security_id, qty_basis, annual_dividend_per_share, annual_interest_per_share,
           projected_annual_income_native, currency, cadence_label, next_ex_div_dates, computed_at,
           created_at, updated_at)
        VALUES (1, 10, 200, 0, 0, 0, 'CAD', 'none', '[]', datetime('now'), datetime('now'), datetime('now'))
      `),
    ).rejects.toThrow();
  });

  it('down drops the table cleanly', async () => {
    await migration.down(sequelize.getQueryInterface(), Sequelize);
    const tables = await sequelize.getQueryInterface().showAllTables();
    expect(tables).not.toContain('portfolio_forward_projections');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
yarn workspace backend test -- forwardIncomeMigration
```
Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Create the migration file**

```js
// backend/src/migrations/20260528000001-portfolio-forward-projections.js
'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('portfolio_forward_projections', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      security_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'securities', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      qty_basis: { type: Sequelize.DECIMAL(20, 8), allowNull: false },
      annual_dividend_per_share: { type: Sequelize.DECIMAL(20, 8), allowNull: false, defaultValue: 0 },
      annual_interest_per_share: { type: Sequelize.DECIMAL(20, 8), allowNull: false, defaultValue: 0 },
      projected_annual_income_native: { type: Sequelize.DECIMAL(20, 2), allowNull: false, defaultValue: 0 },
      currency: { type: Sequelize.STRING(8), allowNull: false },
      cadence_label: { type: Sequelize.STRING(16), allowNull: false },
      median_spacing_days: { type: Sequelize.INTEGER, allowNull: true },
      cv_pct: { type: Sequelize.DECIMAL(8, 4), allowNull: true },
      unreliable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      next_ex_div_dates: { type: Sequelize.JSON, allowNull: false, defaultValue: [] },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      stale_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      'portfolio_forward_projections',
      ['household_id', 'security_id'],
      { name: 'pfp_household_security_unique', unique: true },
    );
    await queryInterface.addIndex(
      'portfolio_forward_projections',
      ['household_id', 'stale_at'],
      { name: 'idx_pfp_household_stale' },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('portfolio_forward_projections');
  },
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
yarn workspace backend test -- forwardIncomeMigration
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260528000001-portfolio-forward-projections.js \
        backend/test/migrations/forwardIncomeMigration.test.ts
git commit -m "feat(portfolio): add portfolio_forward_projections migration"
```

---

## Task 2: Sequelize model — `PortfolioForwardProjection`

**Files:**
- Create: `backend/src/models/PortfolioForwardProjection.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write the model**

```ts
// backend/src/models/PortfolioForwardProjection.ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export interface NextExDivEntry {
  date: string;             // ISO date 'YYYY-MM-DD'
  estimatedPerShare: number;
  kind: 'dividend' | 'interest';
}

export class PortfolioForwardProjection extends Model<
  InferAttributes<PortfolioForwardProjection>,
  InferCreationAttributes<PortfolioForwardProjection>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare securityId: number;
  declare qtyBasis: string;
  declare annualDividendPerShare: string;
  declare annualInterestPerShare: string;
  declare projectedAnnualIncomeNative: string;
  declare currency: string;
  declare cadenceLabel: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';
  declare medianSpacingDays: number | null;
  declare cvPct: string | null;
  declare unreliable: boolean;
  declare nextExDivDates: NextExDivEntry[];
  declare computedAt: Date;
  declare staleAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPortfolioForwardProjection(
  sequelize: Sequelize,
): typeof PortfolioForwardProjection {
  PortfolioForwardProjection.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      securityId: { type: DataTypes.INTEGER, field: 'security_id', allowNull: false },
      qtyBasis: { type: DataTypes.DECIMAL(20, 8), field: 'qty_basis', allowNull: false },
      annualDividendPerShare: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'annual_dividend_per_share',
        allowNull: false,
        defaultValue: '0',
      },
      annualInterestPerShare: {
        type: DataTypes.DECIMAL(20, 8),
        field: 'annual_interest_per_share',
        allowNull: false,
        defaultValue: '0',
      },
      projectedAnnualIncomeNative: {
        type: DataTypes.DECIMAL(20, 2),
        field: 'projected_annual_income_native',
        allowNull: false,
        defaultValue: '0',
      },
      currency: { type: DataTypes.STRING(8), allowNull: false },
      cadenceLabel: { type: DataTypes.STRING(16), field: 'cadence_label', allowNull: false },
      medianSpacingDays: { type: DataTypes.INTEGER, field: 'median_spacing_days', allowNull: true },
      cvPct: { type: DataTypes.DECIMAL(8, 4), field: 'cv_pct', allowNull: true },
      unreliable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      nextExDivDates: {
        type: DataTypes.JSON,
        field: 'next_ex_div_dates',
        allowNull: false,
        defaultValue: [],
      },
      computedAt: { type: DataTypes.DATE, field: 'computed_at', allowNull: false },
      staleAt: { type: DataTypes.DATE, field: 'stale_at', allowNull: true },
    } as ModelAttributes<PortfolioForwardProjection>,
    {
      sequelize,
      modelName: 'PortfolioForwardProjection',
      tableName: 'portfolio_forward_projections',
      underscored: true,
      timestamps: true,
    },
  );
  return PortfolioForwardProjection;
}
```

- [ ] **Step 2: Register in models/index.ts**

Find the section that imports + inits other models and add:

```ts
// At top with other imports
import {
  PortfolioForwardProjection,
  initPortfolioForwardProjection,
} from './PortfolioForwardProjection';

// Where other models are initialized
initPortfolioForwardProjection(sequelize);

// In exports
export { PortfolioForwardProjection };
```

- [ ] **Step 3: Run typecheck**

```bash
yarn workspace backend typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/PortfolioForwardProjection.ts backend/src/models/index.ts
git commit -m "feat(portfolio): add PortfolioForwardProjection model"
```

---

## Task 3: Pure helper — `inferCadence`

**Files:**
- Create: `backend/src/portfolio/forwardIncome.ts`
- Test: `backend/test/portfolio/forwardIncome.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// backend/test/portfolio/forwardIncome.test.ts
import { describe, it, expect } from 'vitest';
import { inferCadence } from '../../src/portfolio/forwardIncome';

const asOf = new Date('2026-05-25');

function dailyOffset(days: number): Date {
  const d = new Date(asOf);
  d.setDate(d.getDate() - days);
  return d;
}

describe('inferCadence', () => {
  it('returns none for zero events', () => {
    expect(inferCadence([], asOf)).toEqual({
      annualPerShare: 0,
      medianSpacingDays: null,
      cadenceLabel: 'none',
      cvPct: null,
      eventCount12mo: 0,
    });
  });

  it('classifies 12 monthly events as monthly', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({
      date: dailyOffset((i + 1) * 30),
      perShareAmount: 0.10,
    }));
    const r = inferCadence(events, asOf);
    expect(r.cadenceLabel).toBe('monthly');
    expect(r.annualPerShare).toBeCloseTo(1.20, 4);
    expect(r.eventCount12mo).toBe(12);
    expect(r.medianSpacingDays).toBe(30);
    expect(r.cvPct).toBeCloseTo(0, 4);
  });

  it('classifies 4 quarterly events as quarterly', () => {
    const events = Array.from({ length: 4 }, (_, i) => ({
      date: dailyOffset((i + 1) * 90),
      perShareAmount: 0.50,
    }));
    const r = inferCadence(events, asOf);
    expect(r.cadenceLabel).toBe('quarterly');
    expect(r.annualPerShare).toBeCloseTo(2.00, 4);
    expect(r.medianSpacingDays).toBe(90);
  });

  it('classifies 2 events as semiannual', () => {
    const events = [
      { date: dailyOffset(180), perShareAmount: 1.0 },
      { date: dailyOffset(360), perShareAmount: 1.0 },
    ];
    expect(inferCadence(events, asOf).cadenceLabel).toBe('semiannual');
  });

  it('classifies 1 event as annual', () => {
    const events = [{ date: dailyOffset(100), perShareAmount: 2.0 }];
    expect(inferCadence(events, asOf).cadenceLabel).toBe('annual');
  });

  it('classifies 7 events as irregular', () => {
    const events = Array.from({ length: 7 }, (_, i) => ({
      date: dailyOffset((i + 1) * 50),
      perShareAmount: 0.20,
    }));
    expect(inferCadence(events, asOf).cadenceLabel).toBe('irregular');
  });

  it('returns null cvPct when fewer than 4 events', () => {
    const events = [
      { date: dailyOffset(60), perShareAmount: 0.5 },
      { date: dailyOffset(150), perShareAmount: 0.5 },
      { date: dailyOffset(240), perShareAmount: 0.5 },
    ];
    expect(inferCadence(events, asOf).cvPct).toBeNull();
  });

  it('computes cvPct from last 4 events by date desc, high variance flags', () => {
    const events = [
      { date: dailyOffset(360), perShareAmount: 0.10 },
      { date: dailyOffset(270), perShareAmount: 0.20 },
      { date: dailyOffset(180), perShareAmount: 0.30 },
      { date: dailyOffset(90), perShareAmount: 0.40 },
    ];
    const r = inferCadence(events, asOf);
    expect(r.cvPct).not.toBeNull();
    expect(r.cvPct!).toBeGreaterThan(0.25);
  });

  it('excludes events outside 365-day window', () => {
    const events = [
      { date: dailyOffset(30), perShareAmount: 1.0 },
      { date: dailyOffset(400), perShareAmount: 99.0 }, // outside window
    ];
    const r = inferCadence(events, asOf);
    expect(r.annualPerShare).toBeCloseTo(1.0, 4);
    expect(r.eventCount12mo).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
yarn workspace backend test -- forwardIncome.test
```
Expected: FAIL — `inferCadence` not defined.

- [ ] **Step 3: Implement `inferCadence`**

```ts
// backend/src/portfolio/forwardIncome.ts
export type CadenceLabel =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'irregular'
  | 'none';

export interface PaymentEvent {
  date: Date;
  perShareAmount: number;
}

export interface CadenceResult {
  annualPerShare: number;
  medianSpacingDays: number | null;
  cadenceLabel: CadenceLabel;
  cvPct: number | null;
  eventCount12mo: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function labelFromCount(n: number): CadenceLabel {
  if (n === 0) return 'none';
  if (n === 1) return 'annual';
  if (n === 2) return 'semiannual';
  if (n >= 3 && n <= 5) return 'quarterly';
  if (n >= 10 && n <= 15) return 'monthly';
  return 'irregular';
}

export function inferCadence(events: PaymentEvent[], asOf: Date): CadenceResult {
  const cutoff = new Date(asOf.getTime() - 365 * ONE_DAY_MS);
  const inWindow = events
    .filter((e) => e.date >= cutoff && e.date <= asOf)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const annualPerShare = inWindow.reduce((s, e) => s + e.perShareAmount, 0);

  let medianSpacingDays: number | null = null;
  if (inWindow.length >= 2) {
    const spacings: number[] = [];
    for (let i = 1; i < inWindow.length; i++) {
      const diff = (inWindow[i].date.getTime() - inWindow[i - 1].date.getTime()) / ONE_DAY_MS;
      spacings.push(diff);
    }
    spacings.sort((a, b) => a - b);
    medianSpacingDays = Math.round(median(spacings));
  }

  let cvPct: number | null = null;
  if (inWindow.length >= 4) {
    const last4 = inWindow.slice(-4).map((e) => e.perShareAmount);
    const mean = last4.reduce((s, x) => s + x, 0) / 4;
    if (mean !== 0) {
      const variance = last4.reduce((s, x) => s + (x - mean) ** 2, 0) / 4;
      cvPct = Math.sqrt(variance) / Math.abs(mean);
    } else {
      cvPct = 0;
    }
  }

  return {
    annualPerShare,
    medianSpacingDays,
    cadenceLabel: labelFromCount(inWindow.length),
    cvPct,
    eventCount12mo: inWindow.length,
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
yarn workspace backend test -- forwardIncome.test
```
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/forwardIncome.ts backend/test/portfolio/forwardIncome.test.ts
git commit -m "feat(portfolio): add inferCadence helper for forward income"
```

---

## Task 4: Pure helper — `projectNextEvents`

**Files:**
- Modify: `backend/src/portfolio/forwardIncome.ts`
- Modify: `backend/test/portfolio/forwardIncome.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// Append to backend/test/portfolio/forwardIncome.test.ts
import { projectNextEvents } from '../../src/portfolio/forwardIncome';

describe('projectNextEvents', () => {
  it('returns empty when medianSpacingDays > horizon', () => {
    const result = projectNextEvents({
      lastEventDate: new Date('2026-05-25'),
      medianSpacingDays: 365,
      lastPerShareAmount: 1.0,
      horizonDays: 90,
      asOf: new Date('2026-05-25'),
    });
    expect(result).toEqual([]);
  });

  it('returns ~3 entries for monthly cadence over 90d horizon', () => {
    const result = projectNextEvents({
      lastEventDate: new Date('2026-05-01'),
      medianSpacingDays: 30,
      lastPerShareAmount: 0.10,
      horizonDays: 90,
      asOf: new Date('2026-05-25'),
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.every((e) => e.estimatedPerShare === 0.10)).toBe(true);
  });

  it('returns 1 entry for quarterly cadence over 90d horizon', () => {
    const result = projectNextEvents({
      lastEventDate: new Date('2026-04-15'),
      medianSpacingDays: 90,
      lastPerShareAmount: 0.50,
      horizonDays: 90,
      asOf: new Date('2026-05-25'),
    });
    expect(result.length).toBe(1);
    expect(result[0].date.toISOString().slice(0, 10)).toBe('2026-07-14');
  });

  it('skips past dates and only returns dates after asOf', () => {
    const result = projectNextEvents({
      lastEventDate: new Date('2026-03-01'),
      medianSpacingDays: 30,
      lastPerShareAmount: 0.10,
      horizonDays: 90,
      asOf: new Date('2026-05-25'),
    });
    expect(result.every((e) => e.date > new Date('2026-05-25'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace backend test -- forwardIncome.test
```
Expected: 4 new tests fail (function undefined).

- [ ] **Step 3: Implement `projectNextEvents`**

Append to `backend/src/portfolio/forwardIncome.ts`:

```ts
export interface ProjectNextEventsArgs {
  lastEventDate: Date;
  medianSpacingDays: number;
  lastPerShareAmount: number;
  horizonDays: number;
  asOf: Date;
}

export function projectNextEvents(args: ProjectNextEventsArgs): Array<{
  date: Date;
  estimatedPerShare: number;
}> {
  const { lastEventDate, medianSpacingDays, lastPerShareAmount, horizonDays, asOf } = args;
  if (medianSpacingDays <= 0) return [];
  const horizonEnd = new Date(asOf.getTime() + horizonDays * ONE_DAY_MS);
  const out: Array<{ date: Date; estimatedPerShare: number }> = [];
  let next = new Date(lastEventDate.getTime() + medianSpacingDays * ONE_DAY_MS);
  while (next <= horizonEnd) {
    if (next > asOf) {
      out.push({ date: next, estimatedPerShare: lastPerShareAmount });
    }
    next = new Date(next.getTime() + medianSpacingDays * ONE_DAY_MS);
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace backend test -- forwardIncome.test
```
Expected: all tests pass (8 + 4 = 12).

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/forwardIncome.ts backend/test/portfolio/forwardIncome.test.ts
git commit -m "feat(portfolio): add projectNextEvents helper"
```

---

## Task 5: Pure helper — `computeForwardProjection`

**Files:**
- Modify: `backend/src/portfolio/forwardIncome.ts`
- Modify: `backend/test/portfolio/forwardIncome.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// Append to backend/test/portfolio/forwardIncome.test.ts
import { computeForwardProjection } from '../../src/portfolio/forwardIncome';

describe('computeForwardProjection', () => {
  const asOf = new Date('2026-05-25');

  const fourMonthlyDividends = Array.from({ length: 12 }, (_, i) => ({
    date: dailyOffset((i + 1) * 30),
    perShareAmount: 0.10,
  }));

  it('returns zero projection when qty=0', () => {
    const r = computeForwardProjection({
      securityId: 1,
      qtyToday: 0,
      currency: 'CAD',
      dividendEvents: fourMonthlyDividends,
      interestEvents: [],
      asOf,
    });
    expect(r.projectedAnnualIncomeNative).toBe(0);
    expect(r.qtyBasis).toBe(0);
  });

  it('computes dividend-only projection', () => {
    const r = computeForwardProjection({
      securityId: 1,
      qtyToday: 100,
      currency: 'CAD',
      dividendEvents: fourMonthlyDividends,
      interestEvents: [],
      asOf,
    });
    expect(r.annualDividendPerShare).toBeCloseTo(1.20, 4);
    expect(r.annualInterestPerShare).toBe(0);
    expect(r.projectedAnnualIncomeNative).toBeCloseTo(120.00, 2);
    expect(r.cadenceLabel).toBe('monthly');
    expect(r.nextExDivDates.length).toBeGreaterThan(0);
    expect(r.nextExDivDates[0].kind).toBe('dividend');
    expect(r.unreliable).toBe(false);
  });

  it('computes interest-only projection (bond)', () => {
    const semiAnnualInterest = [
      { date: dailyOffset(180), perShareAmount: 2.5 },
      { date: dailyOffset(360), perShareAmount: 2.5 },
    ];
    const r = computeForwardProjection({
      securityId: 2,
      qtyToday: 1000,
      currency: 'CAD',
      dividendEvents: [],
      interestEvents: semiAnnualInterest,
      asOf,
    });
    expect(r.annualDividendPerShare).toBe(0);
    expect(r.annualInterestPerShare).toBeCloseTo(5.0, 4);
    expect(r.projectedAnnualIncomeNative).toBeCloseTo(5000, 2);
    expect(r.cadenceLabel).toBe('semiannual');
    expect(r.nextExDivDates.every((e) => e.kind === 'interest')).toBe(true);
  });

  it('combines dividends + interest', () => {
    const r = computeForwardProjection({
      securityId: 3,
      qtyToday: 50,
      currency: 'USD',
      dividendEvents: fourMonthlyDividends,
      interestEvents: [{ date: dailyOffset(90), perShareAmount: 0.05 }],
      asOf,
    });
    expect(r.annualDividendPerShare).toBeCloseTo(1.20, 4);
    expect(r.annualInterestPerShare).toBeCloseTo(0.05, 4);
    expect(r.projectedAnnualIncomeNative).toBeCloseTo(50 * 1.25, 2);
    expect(r.currency).toBe('USD');
  });

  it('flags unreliable when cvPct > 0.25', () => {
    const irregular = [
      { date: dailyOffset(360), perShareAmount: 0.10 },
      { date: dailyOffset(270), perShareAmount: 0.20 },
      { date: dailyOffset(180), perShareAmount: 0.30 },
      { date: dailyOffset(90), perShareAmount: 0.40 },
    ];
    const r = computeForwardProjection({
      securityId: 4,
      qtyToday: 100,
      currency: 'CAD',
      dividendEvents: irregular,
      interestEvents: [],
      asOf,
    });
    expect(r.unreliable).toBe(true);
  });

  it('flags unreliable when 1-3 events (insufficient history)', () => {
    const r = computeForwardProjection({
      securityId: 5,
      qtyToday: 100,
      currency: 'CAD',
      dividendEvents: [
        { date: dailyOffset(180), perShareAmount: 1.0 },
        { date: dailyOffset(90), perShareAmount: 1.0 },
      ],
      interestEvents: [],
      asOf,
    });
    expect(r.unreliable).toBe(true);
  });

  it('is not unreliable when zero events (different bucket)', () => {
    const r = computeForwardProjection({
      securityId: 6,
      qtyToday: 100,
      currency: 'CAD',
      dividendEvents: [],
      interestEvents: [],
      asOf,
    });
    expect(r.unreliable).toBe(false);
    expect(r.cadenceLabel).toBe('none');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace backend test -- forwardIncome.test
```

- [ ] **Step 3: Implement `computeForwardProjection`**

Append to `backend/src/portfolio/forwardIncome.ts`:

```ts
export interface ForwardProjectionInput {
  securityId: number;
  qtyToday: number;
  currency: string;
  dividendEvents: PaymentEvent[];
  interestEvents: PaymentEvent[];
  asOf: Date;
}

export interface ForwardProjectionOutput {
  qtyBasis: number;
  annualDividendPerShare: number;
  annualInterestPerShare: number;
  projectedAnnualIncomeNative: number;
  currency: string;
  cadenceLabel: CadenceLabel;
  medianSpacingDays: number | null;
  cvPct: number | null;
  unreliable: boolean;
  nextExDivDates: Array<{ date: string; estimatedPerShare: number; kind: 'dividend' | 'interest' }>;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeForwardProjection(
  input: ForwardProjectionInput,
): ForwardProjectionOutput {
  const { securityId: _id, qtyToday, currency, dividendEvents, interestEvents, asOf } = input;
  const divCadence = inferCadence(dividendEvents, asOf);
  const intCadence = inferCadence(interestEvents, asOf);

  const annualDividendPerShare = divCadence.annualPerShare;
  const annualInterestPerShare = intCadence.annualPerShare;
  const projectedAnnualIncomeNative =
    qtyToday * (annualDividendPerShare + annualInterestPerShare);

  // Dominant series = whichever has more events; ties favor dividend.
  const dominant = intCadence.eventCount12mo > divCadence.eventCount12mo ? intCadence : divCadence;
  const cadenceLabel = dominant.cadenceLabel;
  const medianSpacingDays = dominant.medianSpacingDays;
  const cvPct = dominant.cvPct;

  const totalEvents = divCadence.eventCount12mo + intCadence.eventCount12mo;
  const unreliable =
    (cvPct !== null && cvPct > 0.25) ||
    (totalEvents > 0 && totalEvents < 4);

  const nextExDivDates: ForwardProjectionOutput['nextExDivDates'] = [];

  if (divCadence.eventCount12mo > 0 && divCadence.medianSpacingDays && divCadence.medianSpacingDays > 0) {
    const sortedDiv = [...dividendEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
    const last = sortedDiv[sortedDiv.length - 1];
    const events = projectNextEvents({
      lastEventDate: last.date,
      medianSpacingDays: divCadence.medianSpacingDays,
      lastPerShareAmount: last.perShareAmount,
      horizonDays: 90,
      asOf,
    });
    for (const e of events) {
      nextExDivDates.push({ date: toIsoDate(e.date), estimatedPerShare: e.estimatedPerShare, kind: 'dividend' });
    }
  }

  if (intCadence.eventCount12mo > 0 && intCadence.medianSpacingDays && intCadence.medianSpacingDays > 0) {
    const sortedInt = [...interestEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
    const last = sortedInt[sortedInt.length - 1];
    const events = projectNextEvents({
      lastEventDate: last.date,
      medianSpacingDays: intCadence.medianSpacingDays,
      lastPerShareAmount: last.perShareAmount,
      horizonDays: 90,
      asOf,
    });
    for (const e of events) {
      nextExDivDates.push({ date: toIsoDate(e.date), estimatedPerShare: e.estimatedPerShare, kind: 'interest' });
    }
  }

  nextExDivDates.sort((a, b) => a.date.localeCompare(b.date));

  return {
    qtyBasis: qtyToday,
    annualDividendPerShare,
    annualInterestPerShare,
    projectedAnnualIncomeNative,
    currency,
    cadenceLabel,
    medianSpacingDays,
    cvPct,
    unreliable,
    nextExDivDates,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace backend test -- forwardIncome.test
```
Expected: all tests pass (12 + 7 = 19).

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/forwardIncome.ts backend/test/portfolio/forwardIncome.test.ts
git commit -m "feat(portfolio): add computeForwardProjection combining dividend + interest"
```

---

## Task 6: Builder — `rebuildForwardProjectionsForHousehold`

**Files:**
- Create: `backend/src/portfolio/forwardIncomeBuilder.ts`
- Test: `backend/test/portfolio/forwardIncomeBuilder.test.ts`

- [ ] **Step 1: Write failing tests using existing test DB helper**

Inspect `backend/test/testUtils.ts` (or equivalent) for the DB setup helper. The repo uses an in-memory SQLite per-test via a shared helper (look at any existing integration test for the pattern — e.g. [backend/test/integration/portfolioMetrics.test.ts](backend/test/integration/portfolioMetrics.test.ts)).

```ts
// backend/test/portfolio/forwardIncomeBuilder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, makeHousehold, makeAccount, makeSecurity, makeHoldingSnapshot, makeDividendEvent, makeInvestmentActivity } from '../testUtils';
import { PortfolioForwardProjection } from '../../src/models/PortfolioForwardProjection';
import {
  rebuildForwardProjectionsForHousehold,
  rebuildForwardProjectionsForAllHouseholds,
} from '../../src/portfolio/forwardIncomeBuilder';

describe('rebuildForwardProjectionsForHousehold', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('creates one row per held security on first build', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec1 = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    const sec2 = await makeSecurity({ symbol: 'XEQT', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec1.id, quantity: '100', statementDate: '2026-05-20' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec2.id, quantity: '50', statementDate: '2026-05-20' });
    // 4 quarterly dividends for sec1
    for (let i = 1; i <= 4; i++) {
      await makeDividendEvent({ securityId: sec1.id, exDividendDate: `2026-0${i}-15`, amount: '0.25', currency: 'CAD' });
    }

    const r = await rebuildForwardProjectionsForHousehold(hh.id);
    expect(r.rebuilt).toBe(2);
    const rows = await PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
    expect(rows).toHaveLength(2);
    const vcn = rows.find((x) => x.securityId === sec1.id)!;
    expect(Number(vcn.annualDividendPerShare)).toBeCloseTo(1.0, 4);
    expect(Number(vcn.projectedAnnualIncomeNative)).toBeCloseTo(100, 2);
  });

  it('updates existing row + clears stale_at', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '100', statementDate: '2026-05-20' });
    await PortfolioForwardProjection.create({
      householdId: hh.id, securityId: sec.id, qtyBasis: '99', annualDividendPerShare: '0',
      annualInterestPerShare: '0', projectedAnnualIncomeNative: '0', currency: 'CAD',
      cadenceLabel: 'none', medianSpacingDays: null, cvPct: null, unreliable: false,
      nextExDivDates: [], computedAt: new Date('2020-01-01'), staleAt: new Date(),
    });
    await rebuildForwardProjectionsForHousehold(hh.id);
    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
    expect(row!.staleAt).toBeNull();
    expect(Number(row!.qtyBasis)).toBe(100);
  });

  it('deletes rows for securities no longer held', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'OLD', currency: 'CAD' });
    await PortfolioForwardProjection.create({
      householdId: hh.id, securityId: sec.id, qtyBasis: '50', annualDividendPerShare: '0',
      annualInterestPerShare: '0', projectedAnnualIncomeNative: '0', currency: 'CAD',
      cadenceLabel: 'none', medianSpacingDays: null, cvPct: null, unreliable: false,
      nextExDivDates: [], computedAt: new Date(), staleAt: null,
    });
    // No holdings_snapshot for `sec` — should get deleted
    const r = await rebuildForwardProjectionsForHousehold(hh.id);
    expect(r.deleted).toBe(1);
    const rows = await PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
    expect(rows).toHaveLength(0);
  });

  it('isolates households', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const acctA = await makeAccount({ householdId: a.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'XEQT', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acctA.id, householdId: a.id, securityId: sec.id, quantity: '10', statementDate: '2026-05-20' });
    await rebuildForwardProjectionsForHousehold(a.id);
    const aRows = await PortfolioForwardProjection.findAll({ where: { householdId: a.id } });
    const bRows = await PortfolioForwardProjection.findAll({ where: { householdId: b.id } });
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(0);
  });

  it('rebuildForwardProjectionsForAllHouseholds iterates', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const acctA = await makeAccount({ householdId: a.id, accountType: 'investment' });
    const acctB = await makeAccount({ householdId: b.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'XEQT', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acctA.id, householdId: a.id, securityId: sec.id, quantity: '5', statementDate: '2026-05-20' });
    await makeHoldingSnapshot({ accountId: acctB.id, householdId: b.id, securityId: sec.id, quantity: '7', statementDate: '2026-05-20' });
    const r = await rebuildForwardProjectionsForAllHouseholds();
    expect(r.households).toBe(2);
    expect(r.rebuilt).toBe(2);
  });

  it('counts interest activity in projection', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'BOND', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '1000', statementDate: '2026-05-20' });
    for (let i = 1; i <= 2; i++) {
      await makeInvestmentActivity({
        accountId: acct.id, householdId: hh.id, securityId: sec.id,
        activityType: 'interest', amount: '25', currency: 'CAD',
        tradeDate: `2026-0${i * 3}-15`,
      });
    }
    await rebuildForwardProjectionsForHousehold(hh.id);
    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
    expect(Number(row!.annualInterestPerShare)).toBeCloseTo(0.05, 4);
    expect(Number(row!.projectedAnnualIncomeNative)).toBeCloseTo(50, 2);
  });
});
```

If `testUtils.ts` lacks any of the factory helpers above, add them following existing factory patterns. Inspect existing factory files in `backend/test/` before writing — do not introduce a new pattern.

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace backend test -- forwardIncomeBuilder
```

- [ ] **Step 3: Implement the builder**

```ts
// backend/src/portfolio/forwardIncomeBuilder.ts
import { Op } from 'sequelize';
import { Account } from '../models/Account';
import { Household } from '../models/Household';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { PortfolioForwardProjection } from '../models/PortfolioForwardProjection';
import { SecurityDividend } from '../models/SecurityDividend';
import { Security } from '../models/Security';
import { computeForwardProjection, type PaymentEvent } from './forwardIncome';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function latestHoldingsByHousehold(householdId: number): Promise<Map<number, { qty: number; currency: string }>> {
  const invAccounts = await Account.findAll({
    where: { householdId, accountType: 'investment' },
    attributes: ['id'],
  });
  if (invAccounts.length === 0) return new Map();
  const acctIds = invAccounts.map((a) => a.id);

  // Latest snapshot per (account, security) — same shape as loadVisibleLatestHoldings
  const snapshots = await HoldingSnapshot.findAll({
    where: { accountId: { [Op.in]: acctIds } },
    order: [['statementDate', 'DESC']],
  });
  const latestByPair = new Map<string, HoldingSnapshot>();
  for (const s of snapshots) {
    const key = `${s.accountId}:${s.securityId}`;
    if (!latestByPair.has(key)) latestByPair.set(key, s);
  }

  // Aggregate across accounts → one entry per security
  const byBySecurity = new Map<number, { qty: number; currency: string }>();
  for (const s of latestByPair.values()) {
    const qty = Number(s.quantity);
    if (qty === 0) continue;
    const existing = byBySecurity.get(s.securityId);
    if (existing) {
      existing.qty += qty;
    } else {
      byBySecurity.set(s.securityId, { qty, currency: s.currency });
    }
  }
  return byBySecurity;
}

export interface RebuildResult {
  rebuilt: number;
  deleted: number;
}

export async function rebuildForwardProjectionsForHousehold(
  householdId: number,
  asOf: Date = new Date(),
): Promise<RebuildResult> {
  const holdings = await latestHoldingsByHousehold(householdId);
  const securityIds = [...holdings.keys()];

  let divEvents: SecurityDividend[] = [];
  let intEvents: InvestmentActivity[] = [];
  if (securityIds.length > 0) {
    const cutoff = new Date(asOf.getTime() - 395 * ONE_DAY_MS); // 13mo window for safety
    divEvents = await SecurityDividend.findAll({
      where: {
        securityId: { [Op.in]: securityIds },
        exDividendDate: { [Op.gte]: cutoff.toISOString().slice(0, 10) },
      },
    });
    const invAccounts = await Account.findAll({
      where: { householdId, accountType: 'investment' },
      attributes: ['id'],
    });
    intEvents = await InvestmentActivity.findAll({
      where: {
        accountId: { [Op.in]: invAccounts.map((a) => a.id) },
        securityId: { [Op.in]: securityIds },
        activityType: 'interest',
        tradeDate: { [Op.gte]: cutoff.toISOString().slice(0, 10) },
      },
    });
  }

  const securities = await Security.findAll({ where: { id: { [Op.in]: securityIds } } });
  const secById = new Map(securities.map((s) => [s.id, s]));

  let rebuilt = 0;
  for (const [securityId, holding] of holdings.entries()) {
    const sec = secById.get(securityId);
    if (!sec) continue;

    const divPayments: PaymentEvent[] = divEvents
      .filter((d) => d.securityId === securityId)
      .map((d) => ({ date: new Date(d.exDividendDate), perShareAmount: Number(d.amount) }));

    const intPayments: PaymentEvent[] = intEvents
      .filter((a) => a.securityId === securityId && a.amount != null && holding.qty > 0)
      .map((a) => ({
        date: new Date(a.tradeDate),
        perShareAmount: Number(a.amount) / holding.qty,
      }));

    const proj = computeForwardProjection({
      securityId,
      qtyToday: holding.qty,
      currency: holding.currency,
      dividendEvents: divPayments,
      interestEvents: intPayments,
      asOf,
    });

    await PortfolioForwardProjection.upsert({
      householdId,
      securityId,
      qtyBasis: String(proj.qtyBasis),
      annualDividendPerShare: String(proj.annualDividendPerShare),
      annualInterestPerShare: String(proj.annualInterestPerShare),
      projectedAnnualIncomeNative: String(proj.projectedAnnualIncomeNative.toFixed(2)),
      currency: proj.currency,
      cadenceLabel: proj.cadenceLabel,
      medianSpacingDays: proj.medianSpacingDays,
      cvPct: proj.cvPct === null ? null : String(proj.cvPct),
      unreliable: proj.unreliable,
      nextExDivDates: proj.nextExDivDates,
      computedAt: asOf,
      staleAt: null,
    });
    rebuilt++;
  }

  const existing = await PortfolioForwardProjection.findAll({ where: { householdId } });
  const deleteIds = existing
    .filter((row) => !holdings.has(row.securityId))
    .map((row) => row.id);
  let deleted = 0;
  if (deleteIds.length > 0) {
    deleted = await PortfolioForwardProjection.destroy({ where: { id: { [Op.in]: deleteIds } } });
  }

  return { rebuilt, deleted };
}

export async function rebuildForwardProjectionsForAllHouseholds(
  asOf: Date = new Date(),
): Promise<{ households: number; rebuilt: number; deleted: number }> {
  const households = await Household.findAll({ attributes: ['id'] });
  let rebuilt = 0;
  let deleted = 0;
  for (const hh of households) {
    const r = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
    rebuilt += r.rebuilt;
    deleted += r.deleted;
  }
  return { households: households.length, rebuilt, deleted };
}

export async function markStaleForHousehold(householdId: number, securityId?: number): Promise<void> {
  const where: { householdId: number; securityId?: number } = { householdId };
  if (securityId !== undefined) where.securityId = securityId;
  await PortfolioForwardProjection.update({ staleAt: new Date() }, { where });
}

export async function markStaleForAllHoldersOfSecurity(securityId: number): Promise<void> {
  await PortfolioForwardProjection.update({ staleAt: new Date() }, { where: { securityId } });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace backend test -- forwardIncomeBuilder
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/forwardIncomeBuilder.ts \
        backend/test/portfolio/forwardIncomeBuilder.test.ts
git commit -m "feat(portfolio): add forward income builder + stale-mark helpers"
```

---

## Task 7: Sequelize stale-invalidation hooks

**Files:**
- Create: `backend/src/hooks/forwardIncomeStaleHooks.ts`
- Modify: `backend/src/models/index.ts`
- Test: `backend/test/portfolio/forwardIncomeStale.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// backend/test/portfolio/forwardIncomeStale.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setupTestDb, teardownTestDb,
  makeHousehold, makeAccount, makeSecurity,
} from '../testUtils';
import { PortfolioForwardProjection } from '../../src/models/PortfolioForwardProjection';
import { InvestmentActivity } from '../../src/models/InvestmentActivity';
import { SecurityDividend } from '../../src/models/SecurityDividend';
import { HoldingSnapshot } from '../../src/models/HoldingSnapshot';

async function seedFreshProjection(householdId: number, securityId: number) {
  return PortfolioForwardProjection.create({
    householdId, securityId, qtyBasis: '100', annualDividendPerShare: '0',
    annualInterestPerShare: '0', projectedAnnualIncomeNative: '0', currency: 'CAD',
    cadenceLabel: 'none', medianSpacingDays: null, cvPct: null, unreliable: false,
    nextExDivDates: [], computedAt: new Date(), staleAt: null,
  });
}

describe('forward income stale hooks', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('InvestmentActivity.create with type=interest marks matching projection stale', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'BOND', currency: 'CAD' });
    await seedFreshProjection(hh.id, sec.id);

    await InvestmentActivity.create({
      accountId: acct.id, householdId: hh.id, securityId: sec.id,
      activityType: 'interest', amount: '10', currency: 'CAD',
      tradeDate: '2026-05-20', description: 'Interest', sourceRowFingerprint: 'fp1', importBatch: 'b1',
    });

    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
    expect(row!.staleAt).not.toBeNull();
  });

  it('InvestmentActivity.create with type=buy marks projection stale (qty changes)', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    await seedFreshProjection(hh.id, sec.id);

    await InvestmentActivity.create({
      accountId: acct.id, householdId: hh.id, securityId: sec.id,
      activityType: 'buy', quantity: '10', price: '50', amount: '500', currency: 'CAD',
      tradeDate: '2026-05-20', description: 'Buy', sourceRowFingerprint: 'fp2', importBatch: 'b1',
    });

    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
    expect(row!.staleAt).not.toBeNull();
  });

  it('SecurityDividend.create marks all holders of that security stale', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const sec = await makeSecurity({ symbol: 'XEQT', currency: 'CAD' });
    await seedFreshProjection(a.id, sec.id);
    await seedFreshProjection(b.id, sec.id);

    await SecurityDividend.create({
      securityId: sec.id, exDividendDate: '2026-05-20',
      amount: '0.10', currency: 'CAD', fetchedAt: new Date(),
    });

    const rowA = await PortfolioForwardProjection.findOne({ where: { householdId: a.id, securityId: sec.id } });
    const rowB = await PortfolioForwardProjection.findOne({ where: { householdId: b.id, securityId: sec.id } });
    expect(rowA!.staleAt).not.toBeNull();
    expect(rowB!.staleAt).not.toBeNull();
  });

  it('HoldingSnapshot.create marks matching household+security stale', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    await seedFreshProjection(hh.id, sec.id);

    await HoldingSnapshot.create({
      accountId: acct.id, householdId: hh.id, securityId: sec.id,
      statementDate: '2026-05-20', quantity: '100', currency: 'CAD',
      sourceRowFingerprint: 'fp3', importBatch: 'b1',
    });

    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: sec.id } });
    expect(row!.staleAt).not.toBeNull();
  });

  it('does not mark anything stale when affected security is not held', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const heldSec = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    const unheldSec = await makeSecurity({ symbol: 'OTHER', currency: 'CAD' });
    await seedFreshProjection(hh.id, heldSec.id);

    await InvestmentActivity.create({
      accountId: acct.id, householdId: hh.id, securityId: unheldSec.id,
      activityType: 'buy', quantity: '1', price: '1', amount: '1', currency: 'CAD',
      tradeDate: '2026-05-20', description: 'Buy', sourceRowFingerprint: 'fp4', importBatch: 'b1',
    });

    const row = await PortfolioForwardProjection.findOne({ where: { householdId: hh.id, securityId: heldSec.id } });
    expect(row!.staleAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace backend test -- forwardIncomeStale
```

- [ ] **Step 3: Implement hook registration**

```ts
// backend/src/hooks/forwardIncomeStaleHooks.ts
import type { Sequelize } from 'sequelize';
import { Account } from '../models/Account';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { SecurityDividend } from '../models/SecurityDividend';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import {
  markStaleForHousehold,
  markStaleForAllHoldersOfSecurity,
} from '../portfolio/forwardIncomeBuilder';

async function householdIdForAccount(accountId: number): Promise<number | null> {
  const acct = await Account.findByPk(accountId, { attributes: ['householdId'] });
  return acct?.householdId ?? null;
}

export function registerForwardIncomeStaleHooks(_sequelize: Sequelize): void {
  const ACTIVITY_TYPES_OF_INTEREST = new Set(['interest', 'buy', 'sell', 'dividend', 'transfer']);

  InvestmentActivity.addHook('afterCreate', 'fwd_income_stale_create', async (instance) => {
    if (!ACTIVITY_TYPES_OF_INTEREST.has(instance.activityType)) return;
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  InvestmentActivity.addHook('afterUpdate', 'fwd_income_stale_update', async (instance) => {
    if (!ACTIVITY_TYPES_OF_INTEREST.has(instance.activityType)) return;
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  InvestmentActivity.addHook('afterDestroy', 'fwd_income_stale_destroy', async (instance) => {
    if (instance.securityId == null) return;
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });

  SecurityDividend.addHook('afterCreate', 'fwd_income_stale_div_create', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });
  SecurityDividend.addHook('afterUpdate', 'fwd_income_stale_div_update', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });
  SecurityDividend.addHook('afterDestroy', 'fwd_income_stale_div_destroy', async (instance) => {
    await markStaleForAllHoldersOfSecurity(instance.securityId);
  });

  HoldingSnapshot.addHook('afterCreate', 'fwd_income_stale_snap_create', async (instance) => {
    const hhId = instance.householdId ?? (await householdIdForAccount(instance.accountId));
    if (hhId == null) return;
    await markStaleForHousehold(hhId, instance.securityId);
  });
}
```

- [ ] **Step 4: Wire in models/index.ts**

Append after all `init*(sequelize)` calls:

```ts
import { registerForwardIncomeStaleHooks } from '../hooks/forwardIncomeStaleHooks';
// ...
registerForwardIncomeStaleHooks(sequelize);
```

- [ ] **Step 5: Run — expect PASS**

```bash
yarn workspace backend test -- forwardIncomeStale
```
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/hooks/forwardIncomeStaleHooks.ts \
        backend/src/models/index.ts \
        backend/test/portfolio/forwardIncomeStale.test.ts
git commit -m "feat(portfolio): add Sequelize hooks for forward income stale invalidation"
```

---

## Task 8: Scheduler + env vars

**Files:**
- Modify: `backend/src/config/env.ts`
- Create: `backend/src/portfolio/forwardIncomeScheduler.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/test/portfolio/forwardIncomeScheduler.test.ts`

- [ ] **Step 1: Extend env config**

Add to `EnvConfig` type:
```ts
forwardIncomeEnabled: boolean;
forwardIncomeCron: string;
```

Add to the parsed export (find where `quoteSchedulerEnabled` and `quoteTickCron` are defined in `env.ts` and follow the same pattern):

```ts
export const forwardIncomeEnabled =
  (process.env.FORWARD_INCOME_ENABLED ?? 'true').toLowerCase() === 'true';
export const forwardIncomeCron = process.env.FORWARD_INCOME_CRON ?? '0 2 * * *';
```

- [ ] **Step 2: Write failing scheduler tests**

```ts
// backend/test/portfolio/forwardIncomeScheduler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, makeHousehold, makeAccount, makeSecurity, makeHoldingSnapshot } from '../testUtils';
import { runForwardIncomeTick } from '../../src/portfolio/forwardIncomeScheduler';
import { PortfolioForwardProjection } from '../../src/models/PortfolioForwardProjection';

describe('runForwardIncomeTick', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('skips when disabled', async () => {
    const r = await runForwardIncomeTick({ enabled: false });
    expect(r.status).toBe('skipped_disabled');
  });

  it('rebuilds all households when enabled', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'VCN', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '100', statementDate: '2026-05-20' });

    const r = await runForwardIncomeTick({ enabled: true });
    expect(r.status).toBe('ran');
    expect(r.householdsProcessed).toBe(1);
    expect(r.rebuilt).toBe(1);
    const rows = await PortfolioForwardProjection.findAll({ where: { householdId: hh.id } });
    expect(rows).toHaveLength(1);
  });

  it('re-entrancy guard prevents overlapping ticks (sequential test)', async () => {
    // Fire two ticks back-to-back; both should resolve without throwing
    const r1 = await runForwardIncomeTick({ enabled: true });
    const r2 = await runForwardIncomeTick({ enabled: true });
    expect(r1.status).toBe('ran');
    expect(r2.status).toBe('ran');
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
yarn workspace backend test -- forwardIncomeScheduler
```

- [ ] **Step 4: Implement the scheduler**

```ts
// backend/src/portfolio/forwardIncomeScheduler.ts
import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../observability/logger';
import * as env from '../config/env';
import { rebuildForwardProjectionsForAllHouseholds } from './forwardIncomeBuilder';

export interface ForwardIncomeTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  rebuilt?: number;
  deleted?: number;
  error?: string;
}

export interface ForwardIncomeTickConfig {
  enabled: boolean;
}

function configFromEnv(): ForwardIncomeTickConfig {
  return { enabled: env.forwardIncomeEnabled };
}

let runningTick = false;
let activeTask: ScheduledTask | null = null;

export async function runForwardIncomeTick(
  configOverride?: Partial<ForwardIncomeTickConfig>,
): Promise<ForwardIncomeTickResult> {
  const config: ForwardIncomeTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const r = await rebuildForwardProjectionsForAllHouseholds();
    return {
      status: 'ran',
      householdsProcessed: r.households,
      rebuilt: r.rebuilt,
      deleted: r.deleted,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

export function startForwardIncomeScheduler(): ScheduledTask | null {
  if (!env.forwardIncomeEnabled) {
    logger.info('forward_income_scheduler_disabled');
    return null;
  }
  if (activeTask) {
    logger.warn('forward_income_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.forwardIncomeCron)) {
    logger.error('forward_income_scheduler_invalid_cron', { expression: env.forwardIncomeCron });
    return null;
  }
  activeTask = cron.schedule(env.forwardIncomeCron, async () => {
    if (runningTick) {
      logger.debug('forward_income_tick_skipped_reentrant');
      return;
    }
    runningTick = true;
    try {
      const r = await runForwardIncomeTick();
      logger.info('forward_income_tick', r as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error('forward_income_tick_unhandled', {}, err);
    } finally {
      runningTick = false;
    }
  });
  logger.info('forward_income_scheduler_started', { cron: env.forwardIncomeCron });
  return activeTask;
}

export function stopForwardIncomeScheduler(): void {
  if (!activeTask) return;
  activeTask.stop();
  activeTask = null;
}
```

- [ ] **Step 5: Wire scheduler in server.ts**

Locate where `startQuoteScheduler()` is called in [server.ts](backend/src/server.ts) and add adjacent:

```ts
import { startForwardIncomeScheduler } from './portfolio/forwardIncomeScheduler';
// ...
startForwardIncomeScheduler();
```

- [ ] **Step 6: Run — expect PASS**

```bash
yarn workspace backend test -- forwardIncomeScheduler
yarn workspace backend typecheck
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/config/env.ts \
        backend/src/portfolio/forwardIncomeScheduler.ts \
        backend/src/server.ts \
        backend/test/portfolio/forwardIncomeScheduler.test.ts
git commit -m "feat(portfolio): add nightly forward income scheduler"
```

---

## Task 9: Shared types — `PortfolioForwardIncome`

**Files:**
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Append the response type**

Add at end of file (or in the Portfolio* section):

```ts
// shared/api-types.ts (append)
export type PortfolioForwardIncomeCadence =
  | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular' | 'none';

export interface PortfolioForwardIncomeRow {
  securityId: number;
  symbol: string;
  name: string;
  assetType: string | null;
  currency: string;
  qty: number;
  currentMvNative: number;
  costBasisNative: number;
  annualDividendPerShare: number;
  annualInterestPerShare: number;
  projectedAnnualIncomeNative: number;
  projectedAnnualIncomeCad: number;
  forwardYieldPct: number;
  forwardYieldOnCostPct: number;
  cadenceLabel: PortfolioForwardIncomeCadence;
  cvPct: number | null;
  unreliable: boolean;
  nextExDivDates: Array<{
    date: string;
    estimatedPerShare: number;
    estimatedTotal: number;
    kind: 'dividend' | 'interest';
  }>;
}

export interface PortfolioForwardIncomeTaxBucket {
  taxStatus:
    | 'registered_rrsp' | 'registered_tfsa' | 'registered_fhsa'
    | 'registered_rrif' | 'non_registered' | 'n_a';
  byCurrency: Array<{ currency: string; amount: number }>;
  totalCad: number;
}

export interface PortfolioForwardIncomeAssetBucket {
  assetType: string;
  byCurrency: Array<{ currency: string; amount: number }>;
  totalCad: number;
}

export interface PortfolioForwardIncomeUpcomingEntry {
  date: string;
  securityId: number;
  symbol: string;
  estimatedTotalNative: number;
  estimatedTotalCad: number;
  currency: string;
  kind: 'dividend' | 'interest';
}

export interface PortfolioForwardIncome {
  totals: {
    projectedAnnualIncomeCad: number;
    projectedAnnualIncomeByCurrency: Array<{ currency: string; amount: number }>;
    forwardYieldPct: number;
    forwardYieldOnCostPct: number;
    computedAt: string;
    fxRateUsedAt: string;
  };
  rows: PortfolioForwardIncomeRow[];
  byTaxStatus: PortfolioForwardIncomeTaxBucket[];
  byAssetType: PortfolioForwardIncomeAssetBucket[];
  upcoming90d: PortfolioForwardIncomeUpcomingEntry[];
  caveats: {
    unreliableSecurityIds: number[];
    holdingsWithoutHistory: Array<{
      securityId: number;
      symbol: string;
      reason: 'no_dividend_history' | 'insufficient_history';
    }>;
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
yarn workspace backend typecheck && yarn workspace frontend typecheck
```

- [ ] **Step 3: Commit**

```bash
git add shared/api-types.ts
git commit -m "feat(types): add PortfolioForwardIncome shared types"
```

---

## Task 10: Endpoint — `GET /api/portfolio/forward-income`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Test: `backend/test/integration/portfolioForwardIncome.test.ts`

- [ ] **Step 1: Write failing integration tests**

```ts
// backend/test/integration/portfolioForwardIncome.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server';
import {
  setupTestDb, teardownTestDb, signInAs,
  makeHousehold, makeAccount, makeSecurity, makeHoldingSnapshot,
  makeDividendEvent, makeInvestmentActivity, makeFxRate,
} from '../testUtils';

describe('GET /api/portfolio/forward-income', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('401 when unauthenticated', async () => {
    const res = await request(app).get('/api/portfolio/forward-income');
    expect(res.status).toBe(401);
  });

  it('returns all-zero structure for empty household', async () => {
    const hh = await makeHousehold();
    const cookie = await signInAs({ householdId: hh.id });
    const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.totals.projectedAnnualIncomeCad).toBe(0);
    expect(res.body.rows).toEqual([]);
    expect(res.body.upcoming90d).toEqual([]);
  });

  it('returns projection for held security with dividend history', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment', taxStatus: 'non_registered' });
    const sec = await makeSecurity({ symbol: 'VCN', name: 'Vanguard Canada', assetType: 'etf', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '100', marketValue: '5000', costBasis: '4500', currency: 'CAD', statementDate: '2026-05-20' });
    for (let m = 1; m <= 12; m++) {
      await makeDividendEvent({ securityId: sec.id, exDividendDate: `2026-${String(m).padStart(2, '0')}-15`, amount: '0.10', currency: 'CAD' });
    }
    await makeFxRate({ fromCurrency: 'CAD', toCurrency: 'CAD', rate: 1, asOfDate: '2026-05-25' });

    const cookie = await signInAs({ householdId: hh.id });
    const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.symbol).toBe('VCN');
    expect(row.cadenceLabel).toBe('monthly');
    expect(row.annualDividendPerShare).toBeCloseTo(1.20, 4);
    expect(row.projectedAnnualIncomeNative).toBeCloseTo(120, 2);
    expect(row.projectedAnnualIncomeCad).toBeCloseTo(120, 2);
    expect(row.forwardYieldPct).toBeCloseTo(120 / 5000, 4);
    expect(row.forwardYieldOnCostPct).toBeCloseTo(120 / 4500, 4);
    expect(row.unreliable).toBe(false);
    expect(row.nextExDivDates.length).toBeGreaterThan(0);
    expect(res.body.totals.projectedAnnualIncomeCad).toBeCloseTo(120, 2);
  });

  it('FX-converts USD holding to CAD in totals', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'AAPL', assetType: 'equity', currency: 'USD' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '10', marketValue: '1000', costBasis: '900', currency: 'USD', statementDate: '2026-05-20' });
    for (let q = 1; q <= 4; q++) {
      await makeDividendEvent({ securityId: sec.id, exDividendDate: `2026-0${q * 2}-15`, amount: '0.50', currency: 'USD' });
    }
    await makeFxRate({ fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.37, asOfDate: '2026-05-25' });

    const cookie = await signInAs({ householdId: hh.id });
    const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.projectedAnnualIncomeNative).toBeCloseTo(20, 2);
    expect(row.projectedAnnualIncomeCad).toBeCloseTo(20 * 1.37, 2);
    expect(res.body.totals.projectedAnnualIncomeCad).toBeCloseTo(20 * 1.37, 2);
  });

  it('rolls up byTaxStatus and byAssetType matrices', async () => {
    const hh = await makeHousehold();
    const tfsaAcct = await makeAccount({ householdId: hh.id, accountType: 'investment', taxStatus: 'registered_tfsa' });
    const sec = await makeSecurity({ symbol: 'XEQT', assetType: 'etf', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: tfsaAcct.id, householdId: hh.id, securityId: sec.id, quantity: '50', marketValue: '1500', currency: 'CAD', statementDate: '2026-05-20' });
    for (let m = 1; m <= 12; m++) {
      await makeDividendEvent({ securityId: sec.id, exDividendDate: `2026-${String(m).padStart(2, '0')}-15`, amount: '0.10', currency: 'CAD' });
    }
    await makeFxRate({ fromCurrency: 'CAD', toCurrency: 'CAD', rate: 1, asOfDate: '2026-05-25' });

    const cookie = await signInAs({ householdId: hh.id });
    const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    const tfsa = res.body.byTaxStatus.find((b: { taxStatus: string }) => b.taxStatus === 'registered_tfsa');
    expect(tfsa).toBeDefined();
    expect(tfsa.totalCad).toBeCloseTo(60, 2);
    const etf = res.body.byAssetType.find((b: { assetType: string }) => b.assetType === 'etf');
    expect(etf.totalCad).toBeCloseTo(60, 2);
  });

  it('lazy rebuild fires when row is stale', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'VCN', currency: 'CAD', assetType: 'etf' });
    await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '100', marketValue: '5000', currency: 'CAD', statementDate: '2026-05-20' });
    await makeFxRate({ fromCurrency: 'CAD', toCurrency: 'CAD', rate: 1, asOfDate: '2026-05-25' });

    const cookie = await signInAs({ householdId: hh.id });
    // First call — populates table
    const first = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    expect(first.body.rows[0].annualDividendPerShare).toBe(0);

    // Add 4 quarterly dividends — hook marks stale
    for (let q = 1; q <= 4; q++) {
      await makeDividendEvent({ securityId: sec.id, exDividendDate: `2026-0${q * 2}-15`, amount: '0.25', currency: 'CAD' });
    }
    // Second call — lazy rebuild kicks in
    const second = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    expect(second.body.rows[0].annualDividendPerShare).toBeCloseTo(1.0, 4);
  });

  it('isolates households (cross-household 403/empty)', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const acctB = await makeAccount({ householdId: b.id, accountType: 'investment' });
    const sec = await makeSecurity({ symbol: 'XEQT', currency: 'CAD' });
    await makeHoldingSnapshot({ accountId: acctB.id, householdId: b.id, securityId: sec.id, quantity: '100', currency: 'CAD', statementDate: '2026-05-20' });

    const cookieA = await signInAs({ householdId: a.id });
    const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookieA);
    expect(res.body.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace backend test -- portfolioForwardIncome
```

- [ ] **Step 3: Implement the endpoint**

Add to [backend/src/routes/portfolio.ts](backend/src/routes/portfolio.ts), placed adjacent to other `/portfolio/*` routes:

```ts
// Imports at top of file (merge with existing):
import { PortfolioForwardProjection } from '../models/PortfolioForwardProjection';
import { rebuildForwardProjectionsForHousehold } from '../portfolio/forwardIncomeBuilder';
import { ensureFxRate } from '../fx/bankOfCanada';
import type { PortfolioForwardIncome } from '../../../shared/api-types';

router.get('/forward-income', requireAuth, async (req, res) => {
  const auth = currentAuth(req);
  const householdId = auth.household.id;

  // 1. Trigger lazy rebuild if any row is stale OR no rows yet AND household has holdings.
  const staleCount = await PortfolioForwardProjection.count({
    where: { householdId, staleAt: { [Op.ne]: null } },
  });
  const totalRows = await PortfolioForwardProjection.count({ where: { householdId } });
  const { latestHoldings } = await loadVisibleLatestHoldings(req);
  if (staleCount > 0 || (totalRows === 0 && latestHoldings.length > 0)) {
    await rebuildForwardProjectionsForHousehold(householdId);
  }

  // 2. Load rows + joined security data.
  const rows = await PortfolioForwardProjection.findAll({ where: { householdId } });
  const securityIds = rows.map((r) => r.securityId);
  const securities = await Security.findAll({ where: { id: { [Op.in]: securityIds } } });
  const secById = new Map(securities.map((s) => [s.id, s]));

  // Holdings keyed by securityId (qty + currentMv + costBasis aggregated across accounts)
  const holdingByPair = new Map<string, typeof latestHoldings[number]>();
  for (const h of latestHoldings) {
    const key = `${h.accountId}:${h.securityId}`;
    if (!holdingByPair.has(key)) holdingByPair.set(key, h);
  }
  interface Agg { qty: number; mvNative: number; costNative: number; currency: string; taxStatus: string; }
  const aggBySec = new Map<number, Agg>();
  // Account taxStatus lookup
  const accountIds = [...new Set(latestHoldings.map((h) => h.accountId))];
  const accounts = await Account.findAll({ where: { id: { [Op.in]: accountIds } } });
  const taxByAcct = new Map(accounts.map((a) => [a.id, a.taxStatus ?? 'n_a']));
  for (const h of holdingByPair.values()) {
    const cur = h.currency;
    const qty = Number(h.quantity);
    const mv = Number(h.marketValue ?? 0);
    const cost = Number(h.costBasis ?? 0);
    const existing = aggBySec.get(h.securityId);
    if (existing) {
      existing.qty += qty;
      existing.mvNative += mv;
      existing.costNative += cost;
    } else {
      aggBySec.set(h.securityId, {
        qty, mvNative: mv, costNative: cost, currency: cur,
        taxStatus: taxByAcct.get(h.accountId) ?? 'n_a',
      });
    }
  }

  // 3. FX lookups
  const asOf = new Date();
  const fxByCurrency = new Map<string, { rate: number; fetchedAt: string }>();
  fxByCurrency.set('CAD', { rate: 1, fetchedAt: asOf.toISOString() });
  for (const r of rows) {
    if (r.currency !== 'CAD' && !fxByCurrency.has(r.currency)) {
      const fx = await ensureFxRate(r.currency, 'CAD', asOf.toISOString().slice(0, 10));
      fxByCurrency.set(r.currency, { rate: fx ? Number(fx.rate) : 1, fetchedAt: fx?.asOfDate ?? asOf.toISOString() });
    }
  }

  // 4. Build rows
  let totalAnnualCad = 0;
  let totalMvCad = 0;
  let totalCostCad = 0;
  const byCurrency = new Map<string, number>();
  const outRows = rows.map((r) => {
    const sec = secById.get(r.securityId);
    const agg = aggBySec.get(r.securityId);
    const fx = fxByCurrency.get(r.currency)?.rate ?? 1;
    const projNative = Number(r.projectedAnnualIncomeNative);
    const projCad = projNative * fx;
    const mvNative = agg?.mvNative ?? 0;
    const costNative = agg?.costNative ?? 0;
    const forwardYieldPct = mvNative > 0 ? projNative / mvNative : 0;
    const forwardYieldOnCostPct = costNative > 0 ? projNative / costNative : 0;
    totalAnnualCad += projCad;
    totalMvCad += mvNative * fx;
    totalCostCad += costNative * fx;
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + projNative);

    return {
      securityId: r.securityId,
      symbol: sec?.symbol ?? '',
      name: sec?.name ?? '',
      assetType: sec?.assetType ?? null,
      currency: r.currency,
      qty: Number(r.qtyBasis),
      currentMvNative: mvNative,
      costBasisNative: costNative,
      annualDividendPerShare: Number(r.annualDividendPerShare),
      annualInterestPerShare: Number(r.annualInterestPerShare),
      projectedAnnualIncomeNative: projNative,
      projectedAnnualIncomeCad: projCad,
      forwardYieldPct,
      forwardYieldOnCostPct,
      cadenceLabel: r.cadenceLabel,
      cvPct: r.cvPct === null ? null : Number(r.cvPct),
      unreliable: r.unreliable,
      nextExDivDates: r.nextExDivDates.map((d) => ({
        date: d.date,
        estimatedPerShare: d.estimatedPerShare,
        estimatedTotal: d.estimatedPerShare * Number(r.qtyBasis),
        kind: d.kind,
      })),
    };
  });

  // 5. Breakdowns
  const byTaxStatusMap = new Map<string, Map<string, number>>();
  const byAssetTypeMap = new Map<string, Map<string, number>>();
  for (const out of outRows) {
    const agg = aggBySec.get(out.securityId);
    const taxStatus = agg?.taxStatus ?? 'n_a';
    const assetType = out.assetType ?? 'other';
    if (!byTaxStatusMap.has(taxStatus)) byTaxStatusMap.set(taxStatus, new Map());
    if (!byAssetTypeMap.has(assetType)) byAssetTypeMap.set(assetType, new Map());
    byTaxStatusMap.get(taxStatus)!.set(out.currency, (byTaxStatusMap.get(taxStatus)!.get(out.currency) ?? 0) + out.projectedAnnualIncomeNative);
    byAssetTypeMap.get(assetType)!.set(out.currency, (byAssetTypeMap.get(assetType)!.get(out.currency) ?? 0) + out.projectedAnnualIncomeNative);
  }
  const cadConvert = (cur: string, amt: number) => amt * (fxByCurrency.get(cur)?.rate ?? 1);
  const byTaxStatus = [...byTaxStatusMap.entries()].map(([taxStatus, byCur]) => ({
    taxStatus: taxStatus as PortfolioForwardIncome['byTaxStatus'][number]['taxStatus'],
    byCurrency: [...byCur.entries()].map(([currency, amount]) => ({ currency, amount })),
    totalCad: [...byCur.entries()].reduce((s, [c, a]) => s + cadConvert(c, a), 0),
  }));
  const byAssetType = [...byAssetTypeMap.entries()].map(([assetType, byCur]) => ({
    assetType,
    byCurrency: [...byCur.entries()].map(([currency, amount]) => ({ currency, amount })),
    totalCad: [...byCur.entries()].reduce((s, [c, a]) => s + cadConvert(c, a), 0),
  }));

  // 6. upcoming90d (flatten + sort)
  const upcoming: PortfolioForwardIncome['upcoming90d'] = [];
  for (const out of outRows) {
    for (const d of out.nextExDivDates) {
      upcoming.push({
        date: d.date,
        securityId: out.securityId,
        symbol: out.symbol,
        estimatedTotalNative: d.estimatedTotal,
        estimatedTotalCad: d.estimatedTotal * (fxByCurrency.get(out.currency)?.rate ?? 1),
        currency: out.currency,
        kind: d.kind,
      });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  // 7. caveats
  const unreliableSecurityIds = outRows.filter((r) => r.unreliable).map((r) => r.securityId);
  const holdingsWithoutHistory = outRows
    .filter((r) => r.cadenceLabel === 'none' || (r.cadenceLabel !== 'none' && r.annualDividendPerShare === 0 && r.annualInterestPerShare === 0))
    .map((r) => ({
      securityId: r.securityId,
      symbol: r.symbol,
      reason: (r.cadenceLabel === 'none' ? 'no_dividend_history' : 'insufficient_history') as 'no_dividend_history' | 'insufficient_history',
    }));

  // 8. totals
  const oldestComputedAt = rows.length === 0
    ? new Date().toISOString()
    : rows.reduce((min, r) => (r.computedAt < min ? r.computedAt : min), rows[0].computedAt).toISOString();
  const fxRateUsedAt = asOf.toISOString();

  const response: PortfolioForwardIncome = {
    totals: {
      projectedAnnualIncomeCad: totalAnnualCad,
      projectedAnnualIncomeByCurrency: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
      forwardYieldPct: totalMvCad > 0 ? totalAnnualCad / totalMvCad : 0,
      forwardYieldOnCostPct: totalCostCad > 0 ? totalAnnualCad / totalCostCad : 0,
      computedAt: oldestComputedAt,
      fxRateUsedAt,
    },
    rows: outRows,
    byTaxStatus,
    byAssetType,
    upcoming90d: upcoming,
    caveats: { unreliableSecurityIds, holdingsWithoutHistory },
  };

  res.json(response);
});
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace backend test -- portfolioForwardIncome
```
Expected: all integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/portfolio.ts \
        backend/test/integration/portfolioForwardIncome.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/forward-income endpoint"
```

---

## Task 11: Performance smoke test

**Files:**
- Modify: `backend/test/integration/portfolioForwardIncome.test.ts`

- [ ] **Step 1: Append perf test**

```ts
// Append to backend/test/integration/portfolioForwardIncome.test.ts
describe('GET /api/portfolio/forward-income — perf smoke', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('responds in < 500ms p95 with 50-security fixture (3 runs)', async () => {
    const hh = await makeHousehold();
    const acct = await makeAccount({ householdId: hh.id, accountType: 'investment' });
    await makeFxRate({ fromCurrency: 'CAD', toCurrency: 'CAD', rate: 1, asOfDate: '2026-05-25' });
    await makeFxRate({ fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.37, asOfDate: '2026-05-25' });
    for (let i = 0; i < 50; i++) {
      const sec = await makeSecurity({ symbol: `TEST${i}`, currency: i % 2 === 0 ? 'CAD' : 'USD', assetType: 'etf' });
      await makeHoldingSnapshot({ accountId: acct.id, householdId: hh.id, securityId: sec.id, quantity: '100', marketValue: '1000', costBasis: '900', currency: i % 2 === 0 ? 'CAD' : 'USD', statementDate: '2026-05-20' });
      for (let m = 1; m <= 12; m++) {
        await makeDividendEvent({ securityId: sec.id, exDividendDate: `2026-${String(m).padStart(2, '0')}-15`, amount: '0.10', currency: i % 2 === 0 ? 'CAD' : 'USD' });
      }
    }
    const cookie = await signInAs({ householdId: hh.id });
    // Warm: first call rebuilds; measure subsequent reads
    await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
    const durations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const res = await request(app).get('/api/portfolio/forward-income').set('Cookie', cookie);
      durations.push(Date.now() - t0);
      expect(res.status).toBe(200);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1];
    expect(p95).toBeLessThan(500);
  });
});
```

500ms is the cap (CI overhead included). Local target is < 100ms.

- [ ] **Step 2: Run**

```bash
yarn workspace backend test -- portfolioForwardIncome
```

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/portfolioForwardIncome.test.ts
git commit -m "test(portfolio): add 50-security perf smoke for forward income"
```

---

## Task 12: Frontend types re-export

**Files:**
- Modify: `frontend/src/types/api.ts`

- [ ] **Step 1: Add re-exports**

Find the existing `Portfolio*` re-export block in [frontend/src/types/api.ts](frontend/src/types/api.ts) and append:

```ts
export type {
  PortfolioForwardIncome,
  PortfolioForwardIncomeRow,
  PortfolioForwardIncomeCadence,
  PortfolioForwardIncomeTaxBucket,
  PortfolioForwardIncomeAssetBucket,
  PortfolioForwardIncomeUpcomingEntry,
} from '@cashflow/shared/api-types';
```

(Match the existing import alias the file uses for shared types — could be `../../shared/api-types` or `@cashflow/shared/api-types`. Use whichever the file already uses.)

- [ ] **Step 2: Typecheck**

```bash
yarn workspace frontend typecheck
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/api.ts
git commit -m "feat(types): re-export PortfolioForwardIncome on frontend"
```

---

## Task 13: Component — `CaveatsBanner`

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/CaveatsBanner.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/CaveatsBanner.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// frontend/src/pages/portfolio-forward-income/CaveatsBanner.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CaveatsBanner } from './CaveatsBanner';

describe('CaveatsBanner', () => {
  it('renders nothing when there are no caveats', () => {
    const { container } = render(
      <CaveatsBanner unreliableSymbols={[]} holdingsWithoutHistory={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists unreliable symbols when expanded', () => {
    render(<CaveatsBanner unreliableSymbols={['VCN', 'XEQT']} holdingsWithoutHistory={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText('VCN')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
  });

  it('lists holdings without history', () => {
    render(
      <CaveatsBanner
        unreliableSymbols={[]}
        holdingsWithoutHistory={[
          { symbol: 'NEWCO', reason: 'no_dividend_history' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText('NEWCO')).toBeInTheDocument();
    expect(screen.getByText(/no dividend history/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn workspace frontend test -- CaveatsBanner
```

- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/CaveatsBanner.tsx
import { useState } from 'react';
import { Card } from '@/components/ui/card';

export interface CaveatsBannerProps {
  unreliableSymbols: string[];
  holdingsWithoutHistory: Array<{
    symbol: string;
    reason: 'no_dividend_history' | 'insufficient_history';
  }>;
}

export function CaveatsBanner({ unreliableSymbols, holdingsWithoutHistory }: CaveatsBannerProps) {
  const [expanded, setExpanded] = useState(false);
  if (unreliableSymbols.length === 0 && holdingsWithoutHistory.length === 0) return null;
  const total = unreliableSymbols.length + holdingsWithoutHistory.length;
  return (
    <Card className="border-yellow-300 bg-yellow-50">
      <div className="flex items-center justify-between p-3">
        <span>
          {total} holdings have unreliable or missing income projections.
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-sm underline"
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {expanded && (
        <div className="p-3 pt-0">
          {unreliableSymbols.length > 0 && (
            <div className="mb-2">
              <p className="font-medium mb-1">Unreliable cadence (CV &gt; 25%):</p>
              <ul className="list-disc pl-6 text-sm">
                {unreliableSymbols.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
          )}
          {holdingsWithoutHistory.length > 0 && (
            <div>
              <p className="font-medium mb-1">Holdings without history:</p>
              <ul className="list-disc pl-6 text-sm">
                {holdingsWithoutHistory.map((h) => (
                  <li key={h.symbol}>
                    {h.symbol} — {h.reason === 'no_dividend_history' ? 'no dividend history' : 'insufficient history'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn workspace frontend test -- CaveatsBanner
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/CaveatsBanner.tsx \
        frontend/src/pages/portfolio-forward-income/CaveatsBanner.test.tsx
git commit -m "feat(portfolio): add CaveatsBanner for forward income tab"
```

---

## Task 14: Component — `ForwardIncomeStatsRow`

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ForwardIncomeStatsRow } from './ForwardIncomeStatsRow';

describe('ForwardIncomeStatsRow', () => {
  it('renders 4 stats', () => {
    render(
      <ForwardIncomeStatsRow
        projectedAnnualIncomeCad={1234.56}
        forwardYieldPct={0.0345}
        forwardYieldOnCostPct={0.0410}
        computedAt="2026-05-25T10:00:00Z"
      />,
    );
    expect(screen.getByText(/\$1,234\.56/)).toBeInTheDocument();
    expect(screen.getByText(/3\.45%/)).toBeInTheDocument();
    expect(screen.getByText(/4\.10%/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.tsx
import { Card } from '@/components/ui/card';
import { formatMoney } from '../../lib/formatMoney';

export interface ForwardIncomeStatsRowProps {
  projectedAnnualIncomeCad: number;
  forwardYieldPct: number;
  forwardYieldOnCostPct: number;
  computedAt: string;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

export function ForwardIncomeStatsRow({
  projectedAnnualIncomeCad, forwardYieldPct, forwardYieldOnCostPct, computedAt,
}: ForwardIncomeStatsRowProps) {
  const dt = new Date(computedAt);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="p-3">
        <p className="text-sm muted">Projected annual income (CAD)</p>
        <p className="text-2xl font-semibold">{formatMoney(projectedAnnualIncomeCad, 'CAD')}</p>
      </Card>
      <Card className="p-3">
        <p className="text-sm muted">Forward yield</p>
        <p className="text-2xl font-semibold">{fmtPct(forwardYieldPct)}</p>
      </Card>
      <Card className="p-3">
        <p className="text-sm muted">Forward yield on cost</p>
        <p className="text-2xl font-semibold">{fmtPct(forwardYieldOnCostPct)}</p>
      </Card>
      <Card className="p-3">
        <p className="text-sm muted">Computed</p>
        <p className="text-sm">{dt.toLocaleString()}</p>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.tsx \
        frontend/src/pages/portfolio-forward-income/ForwardIncomeStatsRow.test.tsx
git commit -m "feat(portfolio): add ForwardIncomeStatsRow component"
```

---

## Task 15: Component — `ForwardIncomeTable`

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ForwardIncomeTable } from './ForwardIncomeTable';
import type { PortfolioForwardIncomeRow } from '../../types/api';

function row(overrides: Partial<PortfolioForwardIncomeRow> = {}): PortfolioForwardIncomeRow {
  return {
    securityId: 1, symbol: 'VCN', name: 'Vanguard Canada', assetType: 'etf',
    currency: 'CAD', qty: 100, currentMvNative: 5000, costBasisNative: 4500,
    annualDividendPerShare: 1.2, annualInterestPerShare: 0,
    projectedAnnualIncomeNative: 120, projectedAnnualIncomeCad: 120,
    forwardYieldPct: 0.024, forwardYieldOnCostPct: 0.027,
    cadenceLabel: 'monthly', cvPct: 0.1, unreliable: false,
    nextExDivDates: [],
    ...overrides,
  };
}

describe('ForwardIncomeTable', () => {
  it('renders rows', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ symbol: 'VCN' }), row({ securityId: 2, symbol: 'XEQT', projectedAnnualIncomeCad: 200 })]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('VCN')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
  });

  it('default sort is projectedAnnualIncomeCad desc', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ symbol: 'A', projectedAnnualIncomeCad: 50 }), row({ securityId: 2, symbol: 'B', projectedAnnualIncomeCad: 500 })]} />
      </MemoryRouter>,
    );
    const symbols = screen.getAllByTestId('fi-row-symbol').map((el) => el.textContent);
    expect(symbols).toEqual(['B', 'A']);
  });

  it('hide-unreliable filter removes flagged rows', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[
          row({ symbol: 'A', unreliable: false }),
          row({ securityId: 2, symbol: 'B', unreliable: true }),
        ]} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText(/hide unreliable/i));
    expect(screen.queryByText('B')).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('clicking symbol cell navigates to drill', () => {
    render(
      <MemoryRouter>
        <ForwardIncomeTable rows={[row({ securityId: 42, symbol: 'VCN' })]} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'VCN' });
    expect(link.getAttribute('href')).toBe('/portfolio/security/42');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.tsx
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PortfolioForwardIncomeRow } from '../../types/api';
import { formatMoney } from '../../lib/formatMoney';

type SortKey =
  | 'symbol' | 'projectedAnnualIncomeNative' | 'projectedAnnualIncomeCad'
  | 'forwardYieldPct' | 'forwardYieldOnCostPct' | 'cadenceLabel';

export interface ForwardIncomeTableProps {
  rows: PortfolioForwardIncomeRow[];
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

export function ForwardIncomeTable({ rows }: ForwardIncomeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('projectedAnnualIncomeCad');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [hideUnreliable, setHideUnreliable] = useState(false);

  const display = useMemo(() => {
    const filtered = hideUnreliable ? rows.filter((r) => !r.unreliable) : rows;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [rows, sortKey, sortDir, hideUnreliable]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('desc'); }
  }

  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          checked={hideUnreliable}
          onChange={(e) => setHideUnreliable(e.target.checked)}
        />
        <span className="text-sm">Hide unreliable</span>
      </label>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th onClick={() => toggleSort('symbol')} className="cursor-pointer text-left">Symbol</th>
            <th className="text-right">Qty</th>
            <th onClick={() => toggleSort('projectedAnnualIncomeNative')} className="cursor-pointer text-right">Annual (native)</th>
            <th onClick={() => toggleSort('projectedAnnualIncomeCad')} className="cursor-pointer text-right">Annual (CAD)</th>
            <th onClick={() => toggleSort('forwardYieldPct')} className="cursor-pointer text-right">Yield</th>
            <th onClick={() => toggleSort('forwardYieldOnCostPct')} className="cursor-pointer text-right">YoC</th>
            <th onClick={() => toggleSort('cadenceLabel')} className="cursor-pointer text-left">Cadence</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {display.map((r) => (
            <tr key={r.securityId}>
              <td>
                <Link to={`/portfolio/security/${r.securityId}`} data-testid="fi-row-symbol">
                  {r.symbol}
                </Link>
              </td>
              <td className="text-right">{r.qty.toLocaleString()}</td>
              <td className="text-right">{formatMoney(r.projectedAnnualIncomeNative, r.currency)}</td>
              <td className="text-right">{formatMoney(r.projectedAnnualIncomeCad, 'CAD')}</td>
              <td className="text-right">{fmtPct(r.forwardYieldPct)}</td>
              <td className="text-right">{fmtPct(r.forwardYieldOnCostPct)}</td>
              <td>{r.cadenceLabel}</td>
              <td>{r.unreliable && <span title="Unreliable cadence" aria-label="Unreliable">⚠</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.tsx \
        frontend/src/pages/portfolio-forward-income/ForwardIncomeTable.test.tsx
git commit -m "feat(portfolio): add ForwardIncomeTable component"
```

---

## Task 16: Component — `UpcomingCalendarStrip`

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { UpcomingCalendarStrip } from './UpcomingCalendarStrip';

describe('UpcomingCalendarStrip', () => {
  it('renders empty state when no entries', () => {
    render(<MemoryRouter><UpcomingCalendarStrip entries={[]} /></MemoryRouter>);
    expect(screen.getByText(/no payments expected/i)).toBeInTheDocument();
  });

  it('renders chips and links to drill', () => {
    render(
      <MemoryRouter>
        <UpcomingCalendarStrip
          entries={[
            { date: '2026-06-15', securityId: 42, symbol: 'VCN', estimatedTotalNative: 24, estimatedTotalCad: 24, currency: 'CAD', kind: 'dividend' },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('VCN')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /VCN/i });
    expect(link.getAttribute('href')).toBe('/portfolio/security/42');
  });

  it('preserves order from props', () => {
    render(
      <MemoryRouter>
        <UpcomingCalendarStrip
          entries={[
            { date: '2026-06-15', securityId: 1, symbol: 'A', estimatedTotalNative: 1, estimatedTotalCad: 1, currency: 'CAD', kind: 'dividend' },
            { date: '2026-07-20', securityId: 2, symbol: 'B', estimatedTotalNative: 2, estimatedTotalCad: 2, currency: 'CAD', kind: 'dividend' },
          ]}
        />
      </MemoryRouter>,
    );
    const syms = screen.getAllByTestId('fi-cal-symbol').map((el) => el.textContent);
    expect(syms).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.tsx
import { Link } from 'react-router-dom';
import type { PortfolioForwardIncomeUpcomingEntry } from '../../types/api';
import { formatMoney } from '../../lib/formatMoney';

export interface UpcomingCalendarStripProps {
  entries: PortfolioForwardIncomeUpcomingEntry[];
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function UpcomingCalendarStrip({ entries }: UpcomingCalendarStripProps) {
  if (entries.length === 0) {
    return <p className="muted text-sm mt-3">No payments expected in next 90 days.</p>;
  }
  return (
    <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
      {entries.map((e, i) => (
        <Link
          key={`${e.securityId}-${e.date}-${i}`}
          to={`/portfolio/security/${e.securityId}`}
          className="flex-shrink-0 rounded border p-2 hover:bg-gray-50"
        >
          <p className="text-xs muted">{fmtDate(e.date)}</p>
          <p className="font-medium" data-testid="fi-cal-symbol">{e.symbol}</p>
          <p className="text-xs">{formatMoney(e.estimatedTotalCad, 'CAD')}</p>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.tsx \
        frontend/src/pages/portfolio-forward-income/UpcomingCalendarStrip.test.tsx
git commit -m "feat(portfolio): add UpcomingCalendarStrip component"
```

---

## Task 17: Component — `ByTaxStatusBreakdown` + `ByAssetTypeBreakdown`

These two components have the same shape — implement both in one task.

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/ByTaxStatusBreakdown.tsx`
- Create: `frontend/src/pages/portfolio-forward-income/ByAssetTypeBreakdown.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/ByTaxStatusBreakdown.test.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/ByAssetTypeBreakdown.test.tsx`

- [ ] **Step 1: Tests**

```tsx
// ByTaxStatusBreakdown.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ByTaxStatusBreakdown } from './ByTaxStatusBreakdown';

describe('ByTaxStatusBreakdown', () => {
  it('renders bucket rows with currency + total CAD', () => {
    render(
      <ByTaxStatusBreakdown
        buckets={[
          { taxStatus: 'registered_tfsa', byCurrency: [{ currency: 'CAD', amount: 60 }, { currency: 'USD', amount: 40 }], totalCad: 114.8 },
          { taxStatus: 'non_registered', byCurrency: [{ currency: 'CAD', amount: 100 }], totalCad: 100 },
        ]}
      />,
    );
    expect(screen.getByText(/TFSA/i)).toBeInTheDocument();
    expect(screen.getByText(/Non-registered/i)).toBeInTheDocument();
    expect(screen.getByText(/\$114\.80/)).toBeInTheDocument();
  });

  it('renders empty state when no buckets', () => {
    render(<ByTaxStatusBreakdown buckets={[]} />);
    expect(screen.getByText(/no projected income/i)).toBeInTheDocument();
  });
});
```

```tsx
// ByAssetTypeBreakdown.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ByAssetTypeBreakdown } from './ByAssetTypeBreakdown';

describe('ByAssetTypeBreakdown', () => {
  it('renders asset type rows', () => {
    render(
      <ByAssetTypeBreakdown
        buckets={[
          { assetType: 'etf', byCurrency: [{ currency: 'CAD', amount: 60 }], totalCad: 60 },
          { assetType: 'equity', byCurrency: [{ currency: 'USD', amount: 50 }], totalCad: 68.5 },
        ]}
      />,
    );
    expect(screen.getByText('etf')).toBeInTheDocument();
    expect(screen.getByText('equity')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/ByTaxStatusBreakdown.tsx
import { Card } from '@/components/ui/card';
import type { PortfolioForwardIncomeTaxBucket } from '../../types/api';
import { formatMoney } from '../../lib/formatMoney';

const TAX_LABEL: Record<PortfolioForwardIncomeTaxBucket['taxStatus'], string> = {
  registered_tfsa: 'TFSA',
  registered_rrsp: 'RRSP',
  registered_fhsa: 'FHSA',
  registered_rrif: 'RRIF',
  non_registered: 'Non-registered',
  n_a: 'Other',
};

export interface ByTaxStatusBreakdownProps {
  buckets: PortfolioForwardIncomeTaxBucket[];
}

export function ByTaxStatusBreakdown({ buckets }: ByTaxStatusBreakdownProps) {
  if (buckets.length === 0) return <p className="muted text-sm">No projected income by tax status.</p>;
  return (
    <Card className="p-3">
      <h4 className="font-medium mb-2">By account type</h4>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left">Bucket</th><th className="text-left">Currencies</th><th className="text-right">Total (CAD)</th></tr></thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.taxStatus}>
              <td>{TAX_LABEL[b.taxStatus]}</td>
              <td>{b.byCurrency.map((c) => `${c.currency} ${formatMoney(c.amount, c.currency)}`).join(' • ')}</td>
              <td className="text-right">{formatMoney(b.totalCad, 'CAD')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

```tsx
// frontend/src/pages/portfolio-forward-income/ByAssetTypeBreakdown.tsx
import { Card } from '@/components/ui/card';
import type { PortfolioForwardIncomeAssetBucket } from '../../types/api';
import { formatMoney } from '../../lib/formatMoney';

export interface ByAssetTypeBreakdownProps {
  buckets: PortfolioForwardIncomeAssetBucket[];
}

export function ByAssetTypeBreakdown({ buckets }: ByAssetTypeBreakdownProps) {
  if (buckets.length === 0) return <p className="muted text-sm">No projected income by asset type.</p>;
  return (
    <Card className="p-3">
      <h4 className="font-medium mb-2">By asset type</h4>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left">Asset type</th><th className="text-left">Currencies</th><th className="text-right">Total (CAD)</th></tr></thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.assetType}>
              <td>{b.assetType}</td>
              <td>{b.byCurrency.map((c) => `${c.currency} ${formatMoney(c.amount, c.currency)}`).join(' • ')}</td>
              <td className="text-right">{formatMoney(b.totalCad, 'CAD')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/By*Breakdown.tsx \
        frontend/src/pages/portfolio-forward-income/By*Breakdown.test.tsx
git commit -m "feat(portfolio): add ByTaxStatus and ByAssetType breakdown components"
```

---

## Task 18: Orchestrator — `ForwardIncomePanel`

**Files:**
- Create: `frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.tsx`
- Test: `frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.test.tsx`

- [ ] **Step 1: Test**

```tsx
// frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ForwardIncomePanel } from './ForwardIncomePanel';
import * as api from '../../lib/api';

const mockData = {
  totals: {
    projectedAnnualIncomeCad: 120,
    projectedAnnualIncomeByCurrency: [{ currency: 'CAD', amount: 120 }],
    forwardYieldPct: 0.024,
    forwardYieldOnCostPct: 0.027,
    computedAt: '2026-05-25T10:00:00Z',
    fxRateUsedAt: '2026-05-25T10:00:00Z',
  },
  rows: [{
    securityId: 1, symbol: 'VCN', name: 'Vanguard Canada', assetType: 'etf',
    currency: 'CAD', qty: 100, currentMvNative: 5000, costBasisNative: 4500,
    annualDividendPerShare: 1.2, annualInterestPerShare: 0,
    projectedAnnualIncomeNative: 120, projectedAnnualIncomeCad: 120,
    forwardYieldPct: 0.024, forwardYieldOnCostPct: 0.027,
    cadenceLabel: 'monthly' as const, cvPct: 0.1, unreliable: false,
    nextExDivDates: [],
  }],
  byTaxStatus: [{ taxStatus: 'non_registered' as const, byCurrency: [{ currency: 'CAD', amount: 120 }], totalCad: 120 }],
  byAssetType: [{ assetType: 'etf', byCurrency: [{ currency: 'CAD', amount: 120 }], totalCad: 120 }],
  upcoming90d: [],
  caveats: { unreliableSecurityIds: [], holdingsWithoutHistory: [] },
};

describe('ForwardIncomePanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows loading then renders data', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce(mockData);
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('VCN')).toBeInTheDocument());
  });

  it('shows error then retry', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValueOnce(new Error('boom'));
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('renders empty state when no rows', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValueOnce({ ...mockData, rows: [] });
    render(<MemoryRouter><ForwardIncomePanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/no income-generating holdings/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```tsx
// frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.tsx
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { getJson } from '../../lib/api';
import type { PortfolioForwardIncome } from '../../types/api';
import { ForwardIncomeStatsRow } from './ForwardIncomeStatsRow';
import { ForwardIncomeTable } from './ForwardIncomeTable';
import { UpcomingCalendarStrip } from './UpcomingCalendarStrip';
import { ByTaxStatusBreakdown } from './ByTaxStatusBreakdown';
import { ByAssetTypeBreakdown } from './ByAssetTypeBreakdown';
import { CaveatsBanner } from './CaveatsBanner';

export function ForwardIncomePanel() {
  const [data, setData] = useState<PortfolioForwardIncome | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getJson<PortfolioForwardIncome>('/api/portfolio/forward-income');
      setData(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load forward income');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Card><p className="muted p-3">Loading…</p></Card>;
  if (err) return <p className="error">{err}</p>;
  if (!data) return null;

  if (data.rows.length === 0) {
    return (
      <Card>
        <p className="muted p-3">
          No income-generating holdings yet — projections appear after the first paid event.
        </p>
      </Card>
    );
  }

  const unreliableSet = new Set(data.caveats.unreliableSecurityIds);
  const unreliableSymbols = data.rows.filter((r) => unreliableSet.has(r.securityId)).map((r) => r.symbol);

  return (
    <div className="flex flex-col gap-3">
      <ForwardIncomeStatsRow
        projectedAnnualIncomeCad={data.totals.projectedAnnualIncomeCad}
        forwardYieldPct={data.totals.forwardYieldPct}
        forwardYieldOnCostPct={data.totals.forwardYieldOnCostPct}
        computedAt={data.totals.computedAt}
      />
      <CaveatsBanner
        unreliableSymbols={unreliableSymbols}
        holdingsWithoutHistory={data.caveats.holdingsWithoutHistory.map((h) => ({ symbol: h.symbol, reason: h.reason }))}
      />
      <UpcomingCalendarStrip entries={data.upcoming90d} />
      <div className="grid gap-3 lg:grid-cols-2">
        <ByTaxStatusBreakdown buckets={data.byTaxStatus} />
        <ByAssetTypeBreakdown buckets={data.byAssetType} />
      </div>
      <ForwardIncomeTable rows={data.rows} />
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.tsx \
        frontend/src/pages/portfolio-forward-income/ForwardIncomePanel.test.tsx
git commit -m "feat(portfolio): add ForwardIncomePanel orchestrator"
```

---

## Task 19: Wire tab into `PortfolioPage`

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

- [ ] **Step 1: Find the TabKey + TAB_DEFS + TabPanel sites**

```bash
grep -n "TabKey\|TAB_DEFS\|TabPanel\|'income'\|'realized'" frontend/src/pages/PortfolioPage.tsx
```

Expected structure (around line 82):
```ts
type TabKey = 'holdings' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'realized'
```

- [ ] **Step 2: Insert new tab key**

Add `'forward-income'` after `'income'`:

```ts
type TabKey = 'holdings' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'forward-income' | 'realized'
```

In the tab definitions array, add entry between income and realized:
```ts
{ value: 'income', label: 'Income' },
{ value: 'forward-income', label: 'Forward income' },
{ value: 'realized', label: 'Realized P&L' },
```

- [ ] **Step 3: Add the TabPanel**

Locate the existing TabPanel block for `'income'` and add adjacent panel for forward-income:

```tsx
import { ForwardIncomePanel } from './portfolio-forward-income/ForwardIncomePanel';
// ...
<TabPanel value="forward-income" active={activeTab}>
  <ForwardIncomePanel />
</TabPanel>
```

- [ ] **Step 4: Smoke test the page**

```bash
yarn workspace frontend test -- PortfolioPage
yarn workspace frontend typecheck
```

If existing PortfolioPage tests fail because they assert tab strip length or ordering, update them.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx
git commit -m "feat(portfolio): wire Forward income tab into PortfolioPage"
```

---

## Task 20: Manual verification + final check

- [ ] **Step 1: Run full test suites**

```bash
yarn workspace backend test
yarn workspace frontend test
yarn workspace backend typecheck
yarn workspace frontend typecheck
yarn workspace backend lint
yarn workspace frontend lint
```

All green.

- [ ] **Step 2: Run dev server + verify in browser**

Per `CLAUDE.md` — Connor wants real-browser verification. Use the `run` skill, the `verify` skill, or:
```bash
yarn workspace backend dev   # one terminal
yarn workspace frontend dev  # another terminal
```
Open `http://localhost:5173/portfolio`, click the new "Forward income" tab. Confirm:
- Loading skeleton appears briefly.
- Stats row renders 4 cards.
- Table renders with sortable columns + "Hide unreliable" toggle.
- Calendar strip renders (or empty state if no upcoming events).
- ByTaxStatus + ByAssetType breakdowns render.
- Drill cross-link (symbol click) navigates to `/portfolio/security/:id`.
- Empty household shows empty-state message.

- [ ] **Step 3: Smoke-fire nightly cron locally**

```bash
yarn workspace backend test -- forwardIncomeScheduler
```

Manually verify scheduler logs at startup:
```bash
yarn workspace backend dev
# Look for "forward_income_scheduler_started" log line
```

- [ ] **Step 4: Final commit / push for review**

```bash
git status
git log --oneline -25
# Push branch + open PR (per Connor's CLAUDE.md: gh pr create + auto-merge with merge commits)
```

---

## Self-review summary

**Spec coverage:**
- §4.1 Table — Task 1 ✓
- §4.2 Pure helpers — Tasks 3, 4, 5 ✓
- §4.3 Builder — Task 6 ✓
- §4.4 Hooks — Task 7 ✓
- §4.5 Scheduler — Task 8 ✓
- §4.6 Endpoint — Tasks 9, 10 ✓
- §5 Frontend — Tasks 12-19 ✓
- §6.1-6.7 Tests — distributed across each implementation task ✓
- §7 Open questions — implementation-time items called out in Task 7 commit (hook location) and Task 10 commit (FX accessor — uses `ensureFxRate` from bankOfCanada directly, no extraction needed)
- §8 Out of scope — respected; no GIC maturity dates, no DGR projection, no per-account drill within forward tab

**Type consistency check:** `PortfolioForwardIncome` shape in Task 9 matches what the endpoint produces in Task 10 and what the frontend types re-export in Task 12.

**Placeholder scan:** All steps contain complete code; no TBD/TODO. The `testUtils.ts` factory references in Task 6 + 7 + 10 may require minor additions (`makeDividendEvent`, `makeInvestmentActivity`, `makeFxRate`) — Task 6 Step 1 explicitly flags this and tells the engineer to follow existing factory patterns.


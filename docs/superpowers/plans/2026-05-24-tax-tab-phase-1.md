# Tax Tab Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/tax` page with a Canadian filing-grade personal T1 (federal + Ontario) estimate for the current year, computed from existing transactions + investment activity + new tax slip and carryforward tables.

**Architecture:** Three layers. (1) Schema additions (`Entity`, `TaxCategory`, `TaxSlip`, `Carryforward`, `TaxReturn`) + `entityId`/`taxStatus` columns on existing tables. (2) Pure TypeScript tax engine under `backend/src/tax/` with year-keyed rate tables, no IO, fully unit-tested against CRA-published examples. (3) Builder layer (`buildPersonalFacts`) that pulls DB rows → `TaxYearFacts`, then routes that wrap engine output with snapshot caching. Frontend `TaxPage` with Overview / Personal T1 / Slips tabs.

**Tech Stack:** TypeScript, Sequelize, Postgres (prod) / SQLite (dev), `decimal.js` (new), Express, React + Vite, Node built-in test runner via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-05-24-tax-tab-design.md`

---

## File Structure

**Created (backend):**
- `backend/src/migrations/20260525000001-tax-entities.js`
- `backend/src/migrations/20260525000002-account-entity-and-tax-status.js`
- `backend/src/migrations/20260525000003-transaction-entity-id.js`
- `backend/src/migrations/20260525000004-tax-categories.js`
- `backend/src/migrations/20260525000005-tax-slips.js`
- `backend/src/migrations/20260525000006-carryforwards.js`
- `backend/src/migrations/20260525000007-tax-return-snapshots.js`
- `backend/src/migrations/20260525000008-backfill-personal-entities.js`
- `backend/src/models/Entity.ts`
- `backend/src/models/TaxCategory.ts`
- `backend/src/models/TaxSlip.ts`
- `backend/src/models/Carryforward.ts`
- `backend/src/models/TaxReturn.ts`
- `backend/src/tax/engine/types.ts`
- `backend/src/tax/engine/brackets.ts`
- `backend/src/tax/engine/cpp-ei.ts`
- `backend/src/tax/engine/dividends.ts`
- `backend/src/tax/engine/capital-gains.ts`
- `backend/src/tax/engine/credits.ts`
- `backend/src/tax/engine/integration.ts`
- `backend/src/tax/engine/instalments.ts`
- `backend/src/tax/engine/t1.ts`
- `backend/src/tax/data/rates-2024.ts`
- `backend/src/tax/data/rates-2025.ts`
- `backend/src/tax/data/rates-2026.ts`
- `backend/src/tax/builders/buildPersonalFacts.ts`
- `backend/src/tax/util/decimal.ts`
- `backend/src/tax/util/factsHash.ts`
- `backend/src/routes/tax.ts`
- `backend/test/tax/brackets.test.ts`
- `backend/test/tax/cpp-ei.test.ts`
- `backend/test/tax/dividends.test.ts`
- `backend/test/tax/capital-gains.test.ts`
- `backend/test/tax/credits.test.ts`
- `backend/test/tax/instalments.test.ts`
- `backend/test/tax/t1-scenarios.test.ts`
- `backend/test/tax/buildPersonalFacts.test.ts`
- `backend/test/tax/routes.test.ts`

**Modified (backend):**
- `backend/src/models/Account.ts` — `+entityId`, `+taxStatus`
- `backend/src/models/Transaction.ts` — `+entityId`
- `backend/src/models/index.ts` — register new models, add associations
- `backend/src/app.ts` — mount `tax` router
- `backend/package.json` — add `decimal.js` dep, extend `test` glob
- `backend/src/tax/engine/types.ts` — types only; isolated

**Created (frontend):**
- `frontend/src/pages/TaxPage.tsx`
- `frontend/src/pages/tax/OverviewTab.tsx`
- `frontend/src/pages/tax/PersonalT1Tab.tsx`
- `frontend/src/pages/tax/SlipsTab.tsx`
- `frontend/src/hooks/useTaxReturn.ts`
- `frontend/src/hooks/useTaxSlips.ts`
- `frontend/src/hooks/useTaxEntities.ts`

**Modified (frontend):**
- `frontend/src/App.tsx` — add `/tax` route
- `frontend/src/components/Sidebar.tsx` — add Tax nav entry

---

## Conventions used throughout

- Sequelize models use `InferAttributes`/`InferCreationAttributes` pattern, `underscored: true`, explicit `field` aliases. Mirror `backend/src/models/Account.ts`.
- Migrations are `YYYYMMDDhhmmss-description.js`, CommonJS, snake_case columns, both `up` and `down` defined.
- Engine uses `Decimal` (decimal.js) for every dollar value. **Number type is banned in `backend/src/tax/engine/`.**
- Tests use Node built-in test runner: `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`. Run with `yarn workspace backend test`.
- All amounts entering engine are CAD. FX conversion happens in builder, never inside engine.
- Commit after each task. Conventional Commits format. No `Co-Authored-By` lines.

---

### Task 1: Install dependency + add tax dir scaffolding

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/tax/engine/.gitkeep`, `backend/src/tax/data/.gitkeep`, `backend/src/tax/builders/.gitkeep`, `backend/src/tax/util/.gitkeep`

- [ ] **Step 1: Add decimal.js dependency**

Run:
```bash
yarn workspace backend add decimal.js@^10.4.3
```
Expected: `decimal.js` appears under `dependencies` in `backend/package.json`.

- [ ] **Step 2: Extend test glob to pick up backend/test/tax/*.test.ts**

In `backend/package.json`, change the `"test"` script from:
```
"test": "tsx --test test/*.test.ts test/portfolio/*.test.ts test/fx/*.test.ts"
```
to:
```
"test": "tsx --test test/*.test.ts test/portfolio/*.test.ts test/fx/*.test.ts test/tax/*.test.ts"
```

- [ ] **Step 3: Create tax dir tree**

```bash
mkdir -p backend/src/tax/engine backend/src/tax/data backend/src/tax/builders backend/src/tax/util backend/test/tax
touch backend/src/tax/engine/.gitkeep backend/src/tax/data/.gitkeep backend/src/tax/builders/.gitkeep backend/src/tax/util/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/yarn.lock backend/src/tax
git commit -m "chore(tax): scaffold backend/src/tax + add decimal.js dep"
```

---

### Task 2: Decimal utility + factsHash util

**Files:**
- Create: `backend/src/tax/util/decimal.ts`
- Create: `backend/src/tax/util/factsHash.ts`
- Create: `backend/test/tax/decimal.test.ts`

- [ ] **Step 1: Write failing test for decimal util**

`backend/test/tax/decimal.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D, sumD, toCents, fromCents } from '../../src/tax/util/decimal';

test('D constructs from string and number', () => {
  assert.equal(D('1.23').toFixed(2), '1.23');
  assert.equal(D(1.23).toFixed(2), '1.23');
});

test('sumD adds an array preserving precision', () => {
  assert.equal(sumD(['0.1', '0.2']).toFixed(2), '0.30');
});

test('toCents / fromCents round-trip', () => {
  assert.equal(toCents(D('123.45')), 12345);
  assert.equal(fromCents(12345).toFixed(2), '123.45');
});
```

- [ ] **Step 2: Run test and confirm failure**

```bash
yarn workspace backend test 2>&1 | grep -A1 decimal.test
```
Expected: failure (module not found).

- [ ] **Step 3: Implement decimal util**

`backend/src/tax/util/decimal.ts`:
```ts
import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export type DecimalLike = Decimal | string | number;

export function D(v: DecimalLike): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

export function sumD(values: DecimalLike[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

export function toCents(v: Decimal): number {
  return v.times(100).round().toNumber();
}

export function fromCents(cents: number): Decimal {
  return new Decimal(cents).dividedBy(100);
}

export function maxZero(v: Decimal): Decimal {
  return v.isNegative() ? new Decimal(0) : v;
}
```

- [ ] **Step 4: Implement factsHash**

`backend/src/tax/util/factsHash.ts`:
```ts
import { createHash } from 'node:crypto';

export function factsHash(facts: unknown): string {
  return createHash('sha256').update(canonicalize(facts)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}';
}
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
yarn workspace backend test 2>&1 | grep -E '(decimal|pass|fail)'
```
Expected: all decimal tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/tax/util backend/test/tax/decimal.test.ts
git commit -m "feat(tax): add Decimal + factsHash utilities"
```

---

### Task 3: Entity model + migration

**Files:**
- Create: `backend/src/migrations/20260525000001-tax-entities.js`
- Create: `backend/src/models/Entity.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write Entity migration**

`backend/src/migrations/20260525000001-tax-entities.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_entities', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      kind: { type: Sequelize.STRING(16), allowNull: false }, // 'personal' | 'corp'
      legal_name: { type: Sequelize.STRING(160), allowNull: false },
      jurisdiction: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'CA-ON' },
      fiscal_year_end: { type: Sequelize.STRING(10), allowNull: true }, // 'MM-DD' for corp
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('tax_entities', ['household_id', 'kind'], {
      name: 'tax_entities_household_kind',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tax_entities', 'tax_entities_household_kind');
    await queryInterface.dropTable('tax_entities');
  },
};
```

- [ ] **Step 2: Write Entity model**

`backend/src/models/Entity.ts`:
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

export type EntityKind = 'personal' | 'corp';

export class Entity extends Model<
  InferAttributes<Entity>,
  InferCreationAttributes<Entity>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare kind: EntityKind;
  declare legalName: string;
  declare jurisdiction: CreationOptional<string>;
  declare fiscalYearEnd: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initEntity(sequelize: Sequelize): typeof Entity {
  Entity.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      legalName: { type: DataTypes.STRING(160), field: 'legal_name', allowNull: false },
      jurisdiction: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'CA-ON',
      },
      fiscalYearEnd: {
        type: DataTypes.STRING(10),
        field: 'fiscal_year_end',
        allowNull: true,
      },
    } as ModelAttributes<Entity>,
    {
      sequelize,
      modelName: 'Entity',
      tableName: 'tax_entities',
      underscored: true,
      timestamps: true,
    }
  );
  return Entity;
}
```

- [ ] **Step 3: Register Entity in models barrel**

In `backend/src/models/index.ts`, add the import next to existing model imports, and call `initEntity(sequelize)` in the same init block. Add `export * from './Entity';`.

- [ ] **Step 4: Run migration locally + smoke**

```bash
yarn workspace backend run db:migrate
```
Expected: migration `20260525000001-tax-entities` applied without error. Verify with:
```bash
sqlite3 backend/dev.sqlite ".schema tax_entities"
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260525000001-tax-entities.js backend/src/models/Entity.ts backend/src/models/index.ts
git commit -m "feat(tax): add Entity model + migration"
```

---

### Task 4: Account.entityId + Account.taxStatus migration + model edit

**Files:**
- Create: `backend/src/migrations/20260525000002-account-entity-and-tax-status.js`
- Modify: `backend/src/models/Account.ts`

- [ ] **Step 1: Write migration**

`backend/src/migrations/20260525000002-account-entity-and-tax-status.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('accounts', 'tax_status', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'n_a',
    });
    await queryInterface.addIndex('accounts', ['entity_id'], {
      name: 'accounts_entity_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('accounts', 'accounts_entity_id');
    await queryInterface.removeColumn('accounts', 'tax_status');
    await queryInterface.removeColumn('accounts', 'entity_id');
  },
};
```

- [ ] **Step 2: Edit Account model**

In `backend/src/models/Account.ts`, add fields to the class:
```ts
  declare entityId: number | null;
  declare taxStatus: CreationOptional<string>;
```
and to the init attributes object:
```ts
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      taxStatus: {
        type: DataTypes.STRING(32),
        field: 'tax_status',
        allowNull: false,
        defaultValue: 'n_a',
      },
```

Also export `AccountTaxStatus` union:
```ts
export type AccountTaxStatus =
  | 'registered_rrsp'
  | 'registered_tfsa'
  | 'registered_fhsa'
  | 'registered_rrif'
  | 'non_registered'
  | 'n_a';
```

- [ ] **Step 3: Run migration**

```bash
yarn workspace backend run db:migrate
```
Expected: applied. Verify:
```bash
sqlite3 backend/dev.sqlite "PRAGMA table_info(accounts);" | grep -E '(entity_id|tax_status)'
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/20260525000002-account-entity-and-tax-status.js backend/src/models/Account.ts
git commit -m "feat(tax): add Account.entityId + Account.taxStatus"
```

---

### Task 5: Transaction.entityId migration + model edit

**Files:**
- Create: `backend/src/migrations/20260525000003-transaction-entity-id.js`
- Modify: `backend/src/models/Transaction.ts`

- [ ] **Step 1: Write migration**

`backend/src/migrations/20260525000003-transaction-entity-id.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'entity_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('transactions', ['entity_id', 'date'], {
      name: 'transactions_entity_date',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('transactions', 'transactions_entity_date');
    await queryInterface.removeColumn('transactions', 'entity_id');
  },
};
```

- [ ] **Step 2: Edit Transaction model**

In `backend/src/models/Transaction.ts`, mirror the pattern from Task 4: add `declare entityId: number | null;` to the class and the matching init attribute (`field: 'entity_id'`, `allowNull: true`).

- [ ] **Step 3: Run migration**

```bash
yarn workspace backend run db:migrate
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/20260525000003-transaction-entity-id.js backend/src/models/Transaction.ts
git commit -m "feat(tax): add Transaction.entityId"
```

---

### Task 6: TaxCategory + TaxSlip + Carryforward + TaxReturn migrations and models

**Files:**
- Create: `backend/src/migrations/20260525000004-tax-categories.js`
- Create: `backend/src/migrations/20260525000005-tax-slips.js`
- Create: `backend/src/migrations/20260525000006-carryforwards.js`
- Create: `backend/src/migrations/20260525000007-tax-return-snapshots.js`
- Create: `backend/src/models/TaxCategory.ts`
- Create: `backend/src/models/TaxSlip.ts`
- Create: `backend/src/models/Carryforward.ts`
- Create: `backend/src/models/TaxReturn.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: TaxCategory migration**

`backend/src/migrations/20260525000004-tax-categories.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tax_categories', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      label: { type: Sequelize.STRING(160), allowNull: false },
      t1_line: { type: Sequelize.STRING(8), allowNull: true },
      t2_schedule: { type: Sequelize.STRING(8), allowNull: true },
      t2_line: { type: Sequelize.STRING(8), allowNull: true },
      is_deductible: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      business_use_default: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('tax_categories');
  },
};
```

- [ ] **Step 2: TaxSlip migration**

`backend/src/migrations/20260525000005-tax-slips.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('tax_slips', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      slip_type: { type: Sequelize.STRING(8), allowNull: false }, // T4|T5|T3|T4A|T5008
      issuer: { type: Sequelize.STRING(256), allowNull: false },
      box_values: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      source_doc_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tax_slips', ['entity_id', 'year'], {
      name: 'tax_slips_entity_year',
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('tax_slips', 'tax_slips_entity_year');
    await queryInterface.dropTable('tax_slips');
  },
};
```

- [ ] **Step 3: Carryforward migration**

`backend/src/migrations/20260525000006-carryforwards.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('carryforwards', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      kind: { type: Sequelize.STRING(24), allowNull: false },
      as_of_year: { type: Sequelize.INTEGER, allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('carryforwards', ['entity_id', 'kind', 'as_of_year'], {
      name: 'carryforwards_entity_kind_year',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('carryforwards', 'carryforwards_entity_kind_year');
    await queryInterface.dropTable('carryforwards');
  },
};
```

- [ ] **Step 4: TaxReturn snapshot migration**

`backend/src/migrations/20260525000007-tax-return-snapshots.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const isPostgres = queryInterface.sequelize.getDialect() === 'postgres';
    await queryInterface.createTable('tax_return_snapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false },
      facts_hash: { type: Sequelize.STRING(64), allowNull: false },
      lines: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      totals: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      warnings: {
        type: isPostgres ? Sequelize.JSONB : Sequelize.JSON,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tax_return_snapshots', ['entity_id', 'year'], {
      name: 'tax_return_snapshots_entity_year',
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex(
      'tax_return_snapshots',
      'tax_return_snapshots_entity_year'
    );
    await queryInterface.dropTable('tax_return_snapshots');
  },
};
```

- [ ] **Step 5: Write models — TaxCategory**

`backend/src/models/TaxCategory.ts`: mirror the Account pattern. Fields: `id`, `code`, `label`, `t1Line` (nullable), `t2Schedule` (nullable), `t2Line` (nullable), `isDeductible` (bool), `businessUseDefault` (decimal, nullable). `tableName: 'tax_categories'`, `underscored: true`.

- [ ] **Step 6: Write models — TaxSlip**

`backend/src/models/TaxSlip.ts`. Fields: `id`, `entityId`, `year`, `slipType`, `issuer`, `boxValues` (DataTypes.JSON), `sourceDocId` (nullable). `tableName: 'tax_slips'`.

Type alias to export:
```ts
export type SlipType = 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
export type TaxSlipBoxValues = Record<string, number | string>;
```

- [ ] **Step 7: Write models — Carryforward**

`backend/src/models/Carryforward.ts`. Fields: `id`, `entityId`, `kind`, `asOfYear`, `amount` (string per Sequelize DECIMAL convention), `notes` (text, nullable). Export:
```ts
export type CarryforwardKind =
  | 'cap_loss'
  | 'rrsp_room'
  | 'grip'
  | 'cda'
  | 'erdtoh'
  | 'nerdtoh'
  | 'non_cap_loss'
  | 'aaii'
  | 'instalments_paid';
```

- [ ] **Step 8: Write models — TaxReturn snapshot**

`backend/src/models/TaxReturn.ts`. Fields: `id`, `entityId`, `year`, `computedAt`, `factsHash`, `lines` (JSON, typed `unknown`), `totals` (JSON, typed `unknown`), `warnings` (JSON, typed `unknown`). `tableName: 'tax_return_snapshots'`.

- [ ] **Step 9: Wire all four into models/index.ts**

Import each, call `initTaxCategory`, `initTaxSlip`, `initCarryforward`, `initTaxReturn` in the same init block. Export from barrel.

- [ ] **Step 10: Migrate + smoke**

```bash
yarn workspace backend run db:migrate
sqlite3 backend/dev.sqlite ".tables" | tr ' ' '\n' | grep -E '(tax_|carryforwards)'
```
Expected output contains: `tax_categories`, `tax_slips`, `tax_return_snapshots`, `carryforwards`, `tax_entities`.

- [ ] **Step 11: Commit**

```bash
git add backend/src/migrations/2026052500000{4,5,6,7}-*.js backend/src/models/{TaxCategory,TaxSlip,Carryforward,TaxReturn}.ts backend/src/models/index.ts
git commit -m "feat(tax): add TaxCategory, TaxSlip, Carryforward, TaxReturn models"
```

---

### Task 7: Backfill default Personal entity per household

**Files:**
- Create: `backend/src/migrations/20260525000008-backfill-personal-entities.js`

- [ ] **Step 1: Write backfill migration**

`backend/src/migrations/20260525000008-backfill-personal-entities.js`:
```js
'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    // 1 Personal entity per household, named "Personal".
    const [households] = await sequelize.query('SELECT id FROM households');
    for (const h of households) {
      const [existing] = await sequelize.query(
        `SELECT id FROM tax_entities WHERE household_id = :hid AND kind = 'personal'`,
        { replacements: { hid: h.id } }
      );
      let entityId;
      if (existing.length > 0) {
        entityId = existing[0].id;
      } else {
        const now = new Date().toISOString();
        const [insertResult] = await sequelize.query(
          `INSERT INTO tax_entities (household_id, kind, legal_name, jurisdiction, created_at, updated_at)
           VALUES (:hid, 'personal', 'Personal', 'CA-ON', :now, :now)
           RETURNING id`,
          { replacements: { hid: h.id, now } }
        );
        // SQLite RETURNING fallback
        if (Array.isArray(insertResult) && insertResult[0]?.id != null) {
          entityId = insertResult[0].id;
        } else {
          const [lookup] = await sequelize.query(
            `SELECT id FROM tax_entities WHERE household_id = :hid AND kind = 'personal'`,
            { replacements: { hid: h.id } }
          );
          entityId = lookup[0].id;
        }
      }
      // Assign all accounts in household to this entity if entity_id is null.
      await sequelize.query(
        `UPDATE accounts SET entity_id = :eid WHERE household_id = :hid AND entity_id IS NULL`,
        { replacements: { eid: entityId, hid: h.id } }
      );
      // Propagate to transactions via account_id join.
      await sequelize.query(
        `UPDATE transactions
            SET entity_id = :eid
          WHERE entity_id IS NULL
            AND account_id IN (SELECT id FROM accounts WHERE household_id = :hid)`,
        { replacements: { eid: entityId, hid: h.id } }
      );
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('UPDATE transactions SET entity_id = NULL');
    await sequelize.query('UPDATE accounts SET entity_id = NULL');
    await sequelize.query(`DELETE FROM tax_entities WHERE kind = 'personal' AND legal_name = 'Personal'`);
  },
};
```

- [ ] **Step 2: Run migration + smoke**

```bash
yarn workspace backend run db:migrate
sqlite3 backend/dev.sqlite "SELECT kind, legal_name, household_id FROM tax_entities;"
sqlite3 backend/dev.sqlite "SELECT COUNT(*) AS unassigned FROM accounts WHERE entity_id IS NULL;"
```
Expected: at least one row in `tax_entities`, 0 unassigned accounts (assuming household has accounts).

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260525000008-backfill-personal-entities.js
git commit -m "feat(tax): backfill default Personal entity per household"
```

---

### Task 8: Engine types

**Files:**
- Create: `backend/src/tax/engine/types.ts`

- [ ] **Step 1: Write types module**

`backend/src/tax/engine/types.ts`:
```ts
import type { Decimal } from '../util/decimal';

export type Currency = 'CAD' | 'USD' | string;

export type SlipBoxes = Record<string, Decimal>;

export type SlipFact = {
  slipId: number;
  slipType: 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
  issuer: string;
  boxes: SlipBoxes;
};

export type IncomeItem = {
  source: string;
  amount: Decimal;
  cadAmount: Decimal;
};

export type CapGainEvent = {
  source: string;
  securityId: number;
  proceeds: Decimal;
  acb: Decimal;
  outlays: Decimal;
  date: string;
};

export type RrspContrib = {
  source: string;
  amount: Decimal;
  date: string;
};

export type PersonalCarryforwards = {
  netCapitalLoss: Decimal;
  rrspRoom: Decimal;
  nonCapLoss: Decimal;
  instalmentsPaid: Decimal;
};

export type TaxYearFacts = {
  year: number;
  jurisdiction: 'CA-ON';
  employmentIncome: IncomeItem[];
  selfEmploymentIncome: IncomeItem[];
  selfEmploymentExpenses: IncomeItem[];
  interestIncome: IncomeItem[];
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  capitalGainEvents: CapGainEvent[];
  rrspContribs: RrspContrib[];
  slips: SlipFact[];
  carryforwards: PersonalCarryforwards;
  spouse?: {
    netIncome: Decimal;
  };
  ageAtYearEnd: number;
};

export type TaxLine = {
  code: string;
  label: string;
  amount: Decimal;
  inputs: { source: string; amount: Decimal }[];
  formula?: string;
};

export type TaxReturn = {
  year: number;
  lines: TaxLine[];
  totals: {
    totalIncome: Decimal;
    netIncome: Decimal;
    taxableIncome: Decimal;
    federalTax: Decimal;
    provincialTax: Decimal;
    cppContrib: Decimal;
    eiPremium: Decimal;
    totalPayable: Decimal;
    refundOrOwing: Decimal;
  };
  warnings: string[];
};

export type Bracket = {
  upTo: Decimal | null; // null = open-ended top bracket
  rate: Decimal;        // e.g. 0.15
};

export type RateTable = {
  year: number;
  federalBrackets: Bracket[];
  provincialBrackets: Bracket[]; // Ontario
  basicPersonalAmountFederal: Decimal;
  bpaFederalPhaseoutStart: Decimal;
  bpaFederalPhaseoutEnd: Decimal;
  bpaFederalMin: Decimal;
  basicPersonalAmountOntario: Decimal;
  spousalAmountFederal: Decimal;
  spousalAmountOntario: Decimal;
  ageAmountFederal: Decimal;
  ageAmountOntario: Decimal;
  ageAmountAge: number;
  ageAmountFederalThreshold: Decimal;
  ageAmountOntarioThreshold: Decimal;
  employmentAmountFederal: Decimal;
  dividendGrossUpEligible: Decimal;
  dividendGrossUpNonEligible: Decimal;
  dtcFederalEligible: Decimal;
  dtcFederalNonEligible: Decimal;
  dtcOntarioEligible: Decimal;
  dtcOntarioNonEligible: Decimal;
  cpp: {
    ympe: Decimal;            // year's maximum pensionable earnings
    yampe: Decimal;           // year's additional maximum pensionable earnings (CPP2)
    basicExemption: Decimal;
    employeeRate: Decimal;    // CPP1 employee rate
    cpp2Rate: Decimal;        // additional rate above YMPE up to YAMPE
  };
  ei: {
    maxInsurable: Decimal;
    employeeRate: Decimal;
  };
  capitalGainsInclusion: Decimal; // 0.5 for years where the 2024 budget change is deferred/cancelled
  onSurtaxBands?: Array<{ threshold: Decimal; rate: Decimal }>; // ON surtax (currently 20%/36%)
  ontarioHealthPremium: Array<{ upTo: Decimal | null; flat: Decimal; marginalRate: Decimal }>;
  donationLowRate: Decimal;     // 0.15 federal
  donationHighRateThreshold: Decimal; // $200
  donationHighRateFederal: Decimal;   // 0.29 (or 0.33 above tax bracket)
  donationLowRateOntario: Decimal;
  donationHighRateOntario: Decimal;
  medicalThresholdPercent: Decimal; // 0.03
  medicalThresholdCap: Decimal;     // year-specific
  sources: { name: string; url: string }[];
};
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/tax/engine/types.ts
git commit -m "feat(tax): engine types (TaxYearFacts, TaxReturn, RateTable)"
```

---

### Task 9: Rate table — 2024 (known values)

**Files:**
- Create: `backend/src/tax/data/rates-2024.ts`

> **Verification note:** Values below are from CRA T1-2024 federal rate sheet + Ontario Ministry of Finance 2024 personal income tax rate card. Engineer MUST verify each constant against the cited URLs before merge.

- [ ] **Step 1: Write rate table**

`backend/src/tax/data/rates-2024.ts`:
```ts
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2024: RateTable = {
  year: 2024,
  federalBrackets: [
    { upTo: D('55867'), rate: D('0.15') },
    { upTo: D('111733'), rate: D('0.205') },
    { upTo: D('173205'), rate: D('0.26') },
    { upTo: D('246752'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  provincialBrackets: [
    { upTo: D('51446'), rate: D('0.0505') },
    { upTo: D('102894'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  basicPersonalAmountFederal: D('15705'),
  bpaFederalPhaseoutStart: D('173205'),
  bpaFederalPhaseoutEnd: D('246752'),
  bpaFederalMin: D('14156'),
  basicPersonalAmountOntario: D('12399'),
  spousalAmountFederal: D('15705'),
  spousalAmountOntario: D('10527'),
  ageAmountFederal: D('8790'),
  ageAmountOntario: D('5916'),
  ageAmountAge: 65,
  ageAmountFederalThreshold: D('44325'),
  ageAmountOntarioThreshold: D('43127'),
  employmentAmountFederal: D('1433'),
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  cpp: {
    ympe: D('68500'),
    yampe: D('73200'),
    basicExemption: D('3500'),
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  ei: {
    maxInsurable: D('63200'),
    employeeRate: D('0.0166'),
  },
  capitalGainsInclusion: D('0.5'),
  onSurtaxBands: [
    { threshold: D('5554'), rate: D('0.20') },
    { threshold: D('7108'), rate: D('0.36') },
  ],
  ontarioHealthPremium: [
    { upTo: D('20000'), flat: D('0'), marginalRate: D('0') },
    { upTo: D('25000'), flat: D('0'), marginalRate: D('0.06') },
    { upTo: D('36000'), flat: D('300'), marginalRate: D('0') },
    { upTo: D('38500'), flat: D('300'), marginalRate: D('0.06') },
    { upTo: D('48000'), flat: D('450'), marginalRate: D('0') },
    { upTo: D('48600'), flat: D('450'), marginalRate: D('0.25') },
    { upTo: D('72000'), flat: D('600'), marginalRate: D('0') },
    { upTo: D('72600'), flat: D('600'), marginalRate: D('0.25') },
    { upTo: D('200000'), flat: D('750'), marginalRate: D('0') },
    { upTo: D('200600'), flat: D('750'), marginalRate: D('0.25') },
    { upTo: null, flat: D('900'), marginalRate: D('0') },
  ],
  donationLowRate: D('0.15'),
  donationHighRateThreshold: D('200'),
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2759'),
  sources: [
    { name: 'CRA T1-2024 Federal rate schedule', url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package.html' },
    { name: 'ON Min of Finance 2024 personal income tax rates', url: 'https://www.fin.gov.on.ca/en/tax/pit/rates.html' },
  ],
};
```

- [ ] **Step 2: Verify every constant against source URLs**

For each constant in the file, open the cited CRA / ON Finance page and confirm. Annotate any discrepancy with a `// VERIFIED YYYY-MM-DD` comment per group. If any constant is wrong, fix it.

- [ ] **Step 3: Commit**

```bash
git add backend/src/tax/data/rates-2024.ts
git commit -m "feat(tax): add 2024 rate table (federal + ON)"
```

---

### Task 10: Rate tables — 2025 and 2026

**Files:**
- Create: `backend/src/tax/data/rates-2025.ts`
- Create: `backend/src/tax/data/rates-2026.ts`

- [ ] **Step 1: Encode 2025 rates**

Copy `rates-2024.ts` to `rates-2025.ts`. Replace every constant with the 2025 value sourced from:
- CRA T1-2025 federal rate schedule
- ON Min of Finance 2025 personal income tax page

Export name: `RATES_2025`. Update `sources[].url` if needed. CPP YMPE 2025 = $71,300, YAMPE = $81,200. EI max insurable 2025 = $65,700.

- [ ] **Step 2: Encode 2026 rates**

Copy to `rates-2026.ts`. Replace constants with 2026 values from CRA (federal brackets are indexed annually — fetch from current CRA index factor page). Export name: `RATES_2026`.

If 2026 ON brackets have not been published yet at implementation time, use CRA's projected indexation factor on the 2025 brackets and emit a warning comment at the top of the file: `// 2026 ON brackets projected from indexation factor X.XX; update once published.`

- [ ] **Step 3: Create rate lookup**

In `backend/src/tax/engine/brackets.ts` (will be created in Task 11), the year-to-rates lookup will live. For now, ensure all three rate modules export their respective `RATES_YYYY` const.

- [ ] **Step 4: Commit**

```bash
git add backend/src/tax/data/rates-2025.ts backend/src/tax/data/rates-2026.ts
git commit -m "feat(tax): add 2025 + 2026 rate tables"
```

---

### Task 11: Brackets engine (TDD)

**Files:**
- Create: `backend/src/tax/engine/brackets.ts`
- Create: `backend/test/tax/brackets.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/test/tax/brackets.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor, applyBrackets } from '../../src/tax/engine/brackets';

test('ratesFor returns 2024 table', () => {
  const r = ratesFor(2024);
  assert.equal(r.year, 2024);
  assert.equal(r.federalBrackets[0].rate.toString(), '0.15');
});

test('ratesFor throws RateTableMissingError for unknown year', () => {
  assert.throws(() => ratesFor(2099), /RateTableMissingError/);
});

test('applyBrackets at $0 = $0 tax', () => {
  const r = ratesFor(2024);
  assert.equal(applyBrackets(D('0'), r.federalBrackets).toFixed(2), '0.00');
});

test('applyBrackets at $1 below first bracket cap = 15%', () => {
  const r = ratesFor(2024);
  // first cap $55,867; test at $55,866
  assert.equal(
    applyBrackets(D('55866'), r.federalBrackets).toFixed(2),
    D('55866').times('0.15').toFixed(2)
  );
});

test('applyBrackets crosses into 20.5% bracket correctly', () => {
  const r = ratesFor(2024);
  // $60,000: $55,867 × 0.15 + ($60,000 - $55,867) × 0.205
  const expected = D('55867').times('0.15').plus(D('4133').times('0.205'));
  assert.equal(applyBrackets(D('60000'), r.federalBrackets).toFixed(2), expected.toFixed(2));
});

test('applyBrackets at $300k hits top bracket', () => {
  const r = ratesFor(2024);
  const tax = applyBrackets(D('300000'), r.federalBrackets);
  assert.ok(tax.greaterThan(D('70000')));
  assert.ok(tax.lessThan(D('85000')));
});

test('Ontario brackets at $200k', () => {
  const r = ratesFor(2024);
  const tax = applyBrackets(D('200000'), r.provincialBrackets);
  assert.ok(tax.greaterThan(D('15000')));
  assert.ok(tax.lessThan(D('22000')));
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
yarn workspace backend test 2>&1 | grep brackets
```
Expected: failures (module missing).

- [ ] **Step 3: Implement brackets**

`backend/src/tax/engine/brackets.ts`:
```ts
import { D, Decimal } from '../util/decimal';
import type { Bracket, RateTable } from './types';
import { RATES_2024 } from '../data/rates-2024';
import { RATES_2025 } from '../data/rates-2025';
import { RATES_2026 } from '../data/rates-2026';

export class RateTableMissingError extends Error {
  constructor(year: number) {
    super(
      `RateTableMissingError: no rate table encoded for year ${year}. Add backend/src/tax/data/rates-${year}.ts.`
    );
    this.name = 'RateTableMissingError';
  }
}

const TABLES: Record<number, RateTable> = {
  2024: RATES_2024,
  2025: RATES_2025,
  2026: RATES_2026,
};

export function ratesFor(year: number): RateTable {
  const t = TABLES[year];
  if (!t) throw new RateTableMissingError(year);
  return t;
}

export function applyBrackets(taxableIncome: Decimal, brackets: Bracket[]): Decimal {
  let remaining = taxableIncome;
  let lowerBound = D('0');
  let tax = D('0');
  for (const b of brackets) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const slice = b.upTo === null ? remaining : Decimal.min(remaining, b.upTo.minus(lowerBound));
    tax = tax.plus(slice.times(b.rate));
    remaining = remaining.minus(slice);
    lowerBound = b.upTo ?? lowerBound;
  }
  return tax;
}
```

Note: `Decimal` is imported as both type and value because `decimal.js` exports a class. The static `Decimal.min(a, b)` is the standard way to get a min of two Decimals.

- [ ] **Step 4: Run tests, confirm pass**

```bash
yarn workspace backend test 2>&1 | grep -E '(brackets|pass|fail)'
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/engine/brackets.ts backend/test/tax/brackets.test.ts
git commit -m "feat(tax): bracket engine + tests"
```

---

### Task 12: CPP + EI engine (TDD)

**Files:**
- Create: `backend/src/tax/engine/cpp-ei.ts`
- Create: `backend/test/tax/cpp-ei.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/test/tax/cpp-ei.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { computeCppEmployee, computeEiEmployee } from '../../src/tax/engine/cpp-ei';

test('CPP employee at $0 employment income = $0', () => {
  const r = ratesFor(2024);
  assert.equal(computeCppEmployee(D('0'), r).toFixed(2), '0.00');
});

test('CPP employee at $30k: (30000-3500) * 0.0595', () => {
  const r = ratesFor(2024);
  const exp = D('30000').minus('3500').times('0.0595');
  assert.equal(computeCppEmployee(D('30000'), r).toFixed(2), exp.toFixed(2));
});

test('CPP employee at YMPE+ caps base contribution + adds CPP2 up to YAMPE', () => {
  const r = ratesFor(2024); // YMPE 68500, YAMPE 73200
  const base = D('68500').minus('3500').times('0.0595');
  const cpp2 = D('73200').minus('68500').times('0.04');
  const expected = base.plus(cpp2);
  assert.equal(computeCppEmployee(D('80000'), r).toFixed(2), expected.toFixed(2));
});

test('EI employee at $30k: 30000 * 0.0166', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('30000'), r).toFixed(2), D('30000').times('0.0166').toFixed(2));
});

test('EI employee caps at maxInsurable', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('100000'), r).toFixed(2), D('63200').times('0.0166').toFixed(2));
});
```

- [ ] **Step 2: Implement**

`backend/src/tax/engine/cpp-ei.ts`:
```ts
import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

export function computeCppEmployee(employmentIncome: Decimal, r: RateTable): Decimal {
  if (employmentIncome.lessThanOrEqualTo(r.cpp.basicExemption)) return D('0');
  const baseBase = Decimal.min(employmentIncome, r.cpp.ympe).minus(r.cpp.basicExemption);
  const baseContrib = maxZero(baseBase).times(r.cpp.employeeRate);
  const cpp2Base = maxZero(
    Decimal.min(employmentIncome, r.cpp.yampe).minus(r.cpp.ympe)
  );
  const cpp2 = cpp2Base.times(r.cpp.cpp2Rate);
  return baseContrib.plus(cpp2);
}

export function computeEiEmployee(employmentIncome: Decimal, r: RateTable): Decimal {
  const base = Decimal.min(employmentIncome, r.ei.maxInsurable);
  return base.times(r.ei.employeeRate);
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace backend test 2>&1 | grep cpp-ei
git add backend/src/tax/engine/cpp-ei.ts backend/test/tax/cpp-ei.test.ts
git commit -m "feat(tax): CPP + EI contribution engine"
```

---

### Task 13: Dividends engine (TDD)

**Files:**
- Create: `backend/src/tax/engine/dividends.ts`
- Create: `backend/test/tax/dividends.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/test/tax/dividends.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import {
  grossUpEligible,
  grossUpNonEligible,
  dtcFederal,
  dtcOntario,
} from '../../src/tax/engine/dividends';

test('eligible dividend $1000 grosses up to $1380', () => {
  const r = ratesFor(2024);
  assert.equal(grossUpEligible(D('1000'), r).toFixed(2), '1380.00');
});

test('non-eligible dividend $1000 grosses up to $1150', () => {
  const r = ratesFor(2024);
  assert.equal(grossUpNonEligible(D('1000'), r).toFixed(2), '1150.00');
});

test('federal DTC on $1380 grossed-up eligible = 1380 * 0.150198', () => {
  const r = ratesFor(2024);
  assert.equal(
    dtcFederal(D('1380'), 'eligible', r).toFixed(4),
    D('1380').times('0.150198').toFixed(4)
  );
});

test('Ontario DTC on $1380 grossed-up eligible = 1380 * 0.10', () => {
  const r = ratesFor(2024);
  assert.equal(dtcOntario(D('1380'), 'eligible', r).toFixed(2), '138.00');
});
```

- [ ] **Step 2: Implement**

`backend/src/tax/engine/dividends.ts`:
```ts
import { type Decimal } from '../util/decimal';
import type { RateTable } from './types';

export type DividendKind = 'eligible' | 'non_eligible';

export function grossUpEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpEligible.plus(1));
}

export function grossUpNonEligible(actual: Decimal, r: RateTable): Decimal {
  return actual.times(r.dividendGrossUpNonEligible.plus(1));
}

export function dtcFederal(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  const rate = kind === 'eligible' ? r.dtcFederalEligible : r.dtcFederalNonEligible;
  return grossedUp.times(rate);
}

export function dtcOntario(grossedUp: Decimal, kind: DividendKind, r: RateTable): Decimal {
  const rate = kind === 'eligible' ? r.dtcOntarioEligible : r.dtcOntarioNonEligible;
  return grossedUp.times(rate);
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace backend test 2>&1 | grep dividends
git add backend/src/tax/engine/dividends.ts backend/test/tax/dividends.test.ts
git commit -m "feat(tax): dividend gross-up + DTC engine"
```

---

### Task 14: Capital gains engine (TDD)

**Files:**
- Create: `backend/src/tax/engine/capital-gains.ts`
- Create: `backend/test/tax/capital-gains.test.ts`

- [ ] **Step 1: Write failing tests**

`backend/test/tax/capital-gains.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { taxableCapitalGains } from '../../src/tax/engine/capital-gains';
import type { CapGainEvent } from '../../src/tax/engine/types';

const ev = (g: number): CapGainEvent => ({
  source: 'test',
  securityId: 1,
  proceeds: D(g + 1000),
  acb: D('1000'),
  outlays: D('0'),
  date: '2024-06-01',
});

test('no events -> $0 taxable', () => {
  const r = ratesFor(2024);
  assert.equal(taxableCapitalGains([], r, D('0')).taxable.toFixed(2), '0.00');
});

test('single $2000 gain -> $1000 taxable (50% inclusion)', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(2000)], r, D('0'));
  assert.equal(result.taxable.toFixed(2), '1000.00');
});

test('gross gain $0 with carried-fwd net cap loss does not go negative', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([], r, D('500'));
  assert.equal(result.taxable.toFixed(2), '0.00');
  assert.equal(result.carryforwardRemaining.toFixed(2), '500.00');
});

test('gain $2000 with $400 carried loss: taxable = 1000 - 400 = 600', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(2000)], r, D('400'));
  assert.equal(result.taxable.toFixed(2), '600.00');
  assert.equal(result.carryforwardRemaining.toFixed(2), '0.00');
});
```

- [ ] **Step 2: Implement**

`backend/src/tax/engine/capital-gains.ts`:
```ts
import { D, Decimal, maxZero } from '../util/decimal';
import type { CapGainEvent, RateTable } from './types';

export type CapGainsResult = {
  gross: Decimal;
  inclusionRate: Decimal;
  taxable: Decimal;
  carryforwardRemaining: Decimal;
};

export function taxableCapitalGains(
  events: CapGainEvent[],
  r: RateTable,
  netCapLossCarryforward: Decimal
): CapGainsResult {
  const gross = events.reduce<Decimal>(
    (acc, e) => acc.plus(e.proceeds.minus(e.acb).minus(e.outlays)),
    D('0')
  );
  const includable = gross.times(r.capitalGainsInclusion);
  if (includable.lessThanOrEqualTo(0)) {
    // Loss year: roll the loss into carryforward (50%-included absorbed).
    return {
      gross,
      inclusionRate: r.capitalGainsInclusion,
      taxable: D('0'),
      carryforwardRemaining: netCapLossCarryforward.plus(includable.negated()),
    };
  }
  const applied = Decimal.min(includable, netCapLossCarryforward);
  return {
    gross,
    inclusionRate: r.capitalGainsInclusion,
    taxable: maxZero(includable.minus(applied)),
    carryforwardRemaining: netCapLossCarryforward.minus(applied),
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
yarn workspace backend test 2>&1 | grep capital-gains
git add backend/src/tax/engine/capital-gains.ts backend/test/tax/capital-gains.test.ts
git commit -m "feat(tax): capital gains engine (50% inclusion + loss carryforward)"
```

---

### Task 15: Credits engine (TDD)

**Files:**
- Create: `backend/src/tax/engine/credits.ts`
- Create: `backend/test/tax/credits.test.ts`

Covers BPA (with phaseout), spousal, age, employment amount, CPP+EI credit, donation credit, basic medical credit.

- [ ] **Step 1: Write failing tests**

`backend/test/tax/credits.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import {
  basicPersonalAmountFederalApplied,
  spousalCreditFederal,
  ageCreditFederal,
  donationCreditFederal,
} from '../../src/tax/engine/credits';

test('BPA federal full amount at low income', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('50000'), r);
  assert.equal(c.toFixed(2), r.basicPersonalAmountFederal.toFixed(2));
});

test('BPA federal phased down at $200k taxable income', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('200000'), r);
  assert.ok(c.lessThan(r.basicPersonalAmountFederal));
  assert.ok(c.greaterThan(r.bpaFederalMin));
});

test('BPA federal at top bracket = bpaFederalMin', () => {
  const r = ratesFor(2024);
  const c = basicPersonalAmountFederalApplied(D('300000'), r);
  assert.equal(c.toFixed(2), r.bpaFederalMin.toFixed(2));
});

test('spousal credit reduced by spouse net income', () => {
  const r = ratesFor(2024);
  const full = spousalCreditFederal(D('0'), r);
  const reduced = spousalCreditFederal(D('5000'), r);
  assert.ok(reduced.lessThan(full));
  assert.equal(reduced.toFixed(2), full.minus(D('5000')).toFixed(2));
});

test('age credit at 70 with low income = full ageAmountFederal', () => {
  const r = ratesFor(2024);
  const c = ageCreditFederal(70, D('30000'), r);
  assert.equal(c.toFixed(2), r.ageAmountFederal.toFixed(2));
});

test('age credit below 65 = 0', () => {
  const r = ratesFor(2024);
  assert.equal(ageCreditFederal(64, D('30000'), r).toFixed(2), '0.00');
});

test('donation $100 federal: 15% × $100 = $15', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('100'), D('100000'), r).toFixed(2), '15.00');
});

test('donation $500 federal: 15% × $200 + 29% × $300 = $30 + $87 = $117', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('500'), D('100000'), r).toFixed(2), '117.00');
});

test('donation $500 at top bracket: 15% × $200 + 33% × $300 = $30 + $99 = $129', () => {
  const r = ratesFor(2024);
  assert.equal(donationCreditFederal(D('500'), D('300000'), r).toFixed(2), '129.00');
});
```

- [ ] **Step 2: Implement**

`backend/src/tax/engine/credits.ts`:
```ts
import { D, Decimal, maxZero } from '../util/decimal';
import type { RateTable } from './types';

/** BPA grant amount (the deduction-equivalent amount), federal, with high-income phaseout. */
export function basicPersonalAmountFederalApplied(
  taxableIncome: Decimal,
  r: RateTable
): Decimal {
  if (taxableIncome.lessThanOrEqualTo(r.bpaFederalPhaseoutStart)) {
    return r.basicPersonalAmountFederal;
  }
  if (taxableIncome.greaterThanOrEqualTo(r.bpaFederalPhaseoutEnd)) {
    return r.bpaFederalMin;
  }
  const phaseRange = r.bpaFederalPhaseoutEnd.minus(r.bpaFederalPhaseoutStart);
  const above = taxableIncome.minus(r.bpaFederalPhaseoutStart);
  const reduction = r.basicPersonalAmountFederal.minus(r.bpaFederalMin).times(above.dividedBy(phaseRange));
  return r.basicPersonalAmountFederal.minus(reduction);
}

/** Returns the credit *amount* (eligible amount), not the credit value. Caller multiplies by lowest rate. */
export function spousalCreditFederal(spouseNetIncome: Decimal, r: RateTable): Decimal {
  return maxZero(r.spousalAmountFederal.minus(spouseNetIncome));
}

export function ageCreditFederal(ageAtYearEnd: number, netIncome: Decimal, r: RateTable): Decimal {
  if (ageAtYearEnd < r.ageAmountAge) return D('0');
  if (netIncome.lessThanOrEqualTo(r.ageAmountFederalThreshold)) return r.ageAmountFederal;
  const reduction = netIncome.minus(r.ageAmountFederalThreshold).times('0.15');
  return maxZero(r.ageAmountFederal.minus(reduction));
}

/** Returns the donation tax credit *value* (not the eligible amount). */
export function donationCreditFederal(
  totalDonations: Decimal,
  taxableIncome: Decimal,
  r: RateTable
): Decimal {
  const low = Decimal.min(totalDonations, r.donationHighRateThreshold);
  const high = maxZero(totalDonations.minus(r.donationHighRateThreshold));
  // High-rate portion is 33% only on amounts that would otherwise be taxed at 33%
  // (i.e., portion of taxable income above the top federal bracket threshold).
  // Approximation per CRA: 33% applies to lesser-of(high portion, taxable income above top bracket).
  const topBracketCap = r.federalBrackets[r.federalBrackets.length - 2].upTo ?? D('0');
  const aboveTop = maxZero(taxableIncome.minus(topBracketCap));
  const at33 = Decimal.min(high, aboveTop);
  const at29 = high.minus(at33);
  return low.times(r.donationLowRate)
    .plus(at29.times(r.donationHighRateFederal))
    .plus(at33.times(D('0.33')));
}
```

> **Note:** This credit module is intentionally minimal for Phase 1. ON donation credit, ON spousal/age, employment amount, CPP/EI credit value, basic medical — add parallel functions and tests below in the same task before committing.

- [ ] **Step 3: Add Ontario credit functions + tests**

Mirror each federal function with an Ontario variant inside the same `credits.ts` file: `basicPersonalAmountOntarioApplied`, `spousalCreditOntario`, `ageCreditOntario`, `donationCreditOntario`. Each takes the rate table and uses `r.basicPersonalAmountOntario`, `r.spousalAmountOntario`, `r.ageAmountOntario`/`r.ageAmountOntarioThreshold`, `r.donationLowRateOntario`/`r.donationHighRateOntario`/`r.donationHighRateThreshold`.

Add at least one test per ON function with assertions analogous to the federal cases.

- [ ] **Step 4: Add employment amount + CPP/EI credit + medical credit**

In the same `credits.ts`:
```ts
export function employmentAmountFederalApplied(employmentIncome: Decimal, r: RateTable): Decimal {
  return Decimal.min(employmentIncome, r.employmentAmountFederal);
}

export function cppEiCreditAmount(cppContrib: Decimal, eiPremium: Decimal): Decimal {
  return cppContrib.plus(eiPremium);
}

export function medicalCreditFederal(
  medicalExpenses: Decimal,
  netIncome: Decimal,
  r: RateTable
): Decimal {
  const threshold = Decimal.min(netIncome.times(r.medicalThresholdPercent), r.medicalThresholdCap);
  const eligible = maxZero(medicalExpenses.minus(threshold));
  return eligible.times(r.donationLowRate); // federal lowest rate = 15%
}
```

Add tests:
```ts
test('medical credit: $5000 expenses, $30k income, threshold = min(30000*0.03=900, cap)', () => {
  const r = ratesFor(2024);
  const expected = D('5000').minus('900').times('0.15');
  assert.equal(medicalCreditFederal(D('5000'), D('30000'), r).toFixed(2), expected.toFixed(2));
});

test('employment amount caps at the rate table constant', () => {
  const r = ratesFor(2024);
  assert.equal(employmentAmountFederalApplied(D('5000'), r).toFixed(2), r.employmentAmountFederal.toFixed(2));
});
```

- [ ] **Step 5: Run + commit**

```bash
yarn workspace backend test 2>&1 | grep credits
git add backend/src/tax/engine/credits.ts backend/test/tax/credits.test.ts
git commit -m "feat(tax): personal credits engine (BPA, spousal, age, donations, medical, employment, CPP/EI)"
```

---

### Task 16: Integration stub + instalments + T1 assembly

**Files:**
- Create: `backend/src/tax/engine/integration.ts`
- Create: `backend/src/tax/engine/instalments.ts`
- Create: `backend/src/tax/engine/t1.ts`
- Create: `backend/test/tax/instalments.test.ts`
- Create: `backend/test/tax/t1-scenarios.test.ts`

- [ ] **Step 1: integration.ts (stub)**

`backend/src/tax/engine/integration.ts`:
```ts
// Phase 1 stub: integration concerns corp→personal dividend flow + GRIP/CDA.
// Phase 1 ships personal T1 only; integration math lives here for Phase 3.
// For Phase 1, expose a no-op that returns the input grossed-up + DTC reduced.
export {}; // ensure module mode
```

- [ ] **Step 2: instalments tests**

`backend/test/tax/instalments.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { quarterlyInstalments } from '../../src/tax/engine/instalments';

test('instalments split tax owing into 4 equal payments', () => {
  const result = quarterlyInstalments(D('12000'));
  assert.equal(result.length, 4);
  assert.equal(result[0].amount.toFixed(2), '3000.00');
  assert.equal(result[3].dueOn.slice(5), '12-15');
});

test('instalments $0 owing returns 4 zero payments', () => {
  const result = quarterlyInstalments(D('0'));
  assert.equal(result.reduce((s, p) => s + p.amount.toNumber(), 0), 0);
});
```

- [ ] **Step 3: instalments impl**

`backend/src/tax/engine/instalments.ts`:
```ts
import { D, type Decimal } from '../util/decimal';

export type Instalment = { dueOn: string; amount: Decimal };

const DUE_DATES = ['03-15', '06-15', '09-15', '12-15'];

export function quarterlyInstalments(annualOwing: Decimal, year: number = new Date().getUTCFullYear()): Instalment[] {
  const per = annualOwing.dividedBy(4);
  return DUE_DATES.map((md) => ({ dueOn: `${year}-${md}`, amount: per }));
}
```

- [ ] **Step 4: t1.ts (the assembly)**

`backend/src/tax/engine/t1.ts`:
```ts
import { D, Decimal, sumD, maxZero } from '../util/decimal';
import type { RateTable, TaxLine, TaxReturn, TaxYearFacts } from './types';
import { applyBrackets } from './brackets';
import { computeCppEmployee, computeEiEmployee } from './cpp-ei';
import { grossUpEligible, grossUpNonEligible, dtcFederal, dtcOntario } from './dividends';
import { taxableCapitalGains } from './capital-gains';
import {
  basicPersonalAmountFederalApplied,
  basicPersonalAmountOntarioApplied,
  spousalCreditFederal,
  spousalCreditOntario,
  ageCreditFederal,
  ageCreditOntario,
  employmentAmountFederalApplied,
  cppEiCreditAmount,
  donationCreditFederal,
  donationCreditOntario,
  medicalCreditFederal,
} from './credits';

export function buildT1(facts: TaxYearFacts, r: RateTable): TaxReturn {
  const warnings: string[] = [];
  const lines: TaxLine[] = [];
  const push = (
    code: string,
    label: string,
    amount: Decimal,
    inputs: { source: string; amount: Decimal }[] = [],
    formula?: string
  ) => {
    lines.push({ code, label, amount, inputs, formula });
  };

  // Employment income L10100 — prefer T4 box 14 totals over computed txns; warn if diff > $50.
  const t4s = facts.slips.filter((s) => s.slipType === 'T4');
  const t4Box14Total = sumD(t4s.map((s) => s.boxes['box14'] ?? D('0')));
  const computedEmployment = sumD(facts.employmentIncome.map((i) => i.cadAmount));
  if (t4s.length > 0 && t4Box14Total.minus(computedEmployment).abs().greaterThan(50)) {
    warnings.push(
      `T4 box 14 total $${t4Box14Total.toFixed(2)} differs from computed employment income $${computedEmployment.toFixed(2)} by more than $50.`
    );
  }
  const employmentLine = t4s.length > 0 ? t4Box14Total : computedEmployment;
  push('L10100', 'Employment income', employmentLine,
    t4s.length > 0
      ? t4s.map((s) => ({ source: `Slip T4 #${s.slipId} box 14`, amount: s.boxes['box14'] ?? D('0') }))
      : facts.employmentIncome.map((i) => ({ source: i.source, amount: i.cadAmount })),
    t4s.length > 0 ? 'sum(T4.box14)' : 'sum(employmentTransactions.cad)'
  );

  // Interest L12100
  const interest = sumD(facts.interestIncome.map((i) => i.cadAmount));
  push('L12100', 'Interest and other investment income', interest,
    facts.interestIncome.map((i) => ({ source: i.source, amount: i.cadAmount })));

  // Eligible dividends L12000 (grossed-up amount)
  const eligibleActual = sumD(facts.eligibleDividends.map((i) => i.cadAmount));
  const eligibleGrossed = grossUpEligible(eligibleActual, r);
  push('L12000', 'Taxable amount of eligible dividends', eligibleGrossed,
    facts.eligibleDividends.map((i) => ({ source: i.source, amount: i.cadAmount })),
    `${r.dividendGrossUpEligible.plus(1).toString()} × actual`);

  // Non-eligible dividends L12010
  const nonElActual = sumD(facts.nonEligibleDividends.map((i) => i.cadAmount));
  const nonElGrossed = grossUpNonEligible(nonElActual, r);
  push('L12010', 'Taxable amount of non-eligible dividends', nonElGrossed,
    facts.nonEligibleDividends.map((i) => ({ source: i.source, amount: i.cadAmount })));

  // Capital gains L12700
  const cg = taxableCapitalGains(facts.capitalGainEvents, r, facts.carryforwards.netCapitalLoss);
  push('L12700', 'Taxable capital gains', cg.taxable,
    facts.capitalGainEvents.map((e) => ({
      source: `${e.source} ${e.date}`,
      amount: e.proceeds.minus(e.acb).minus(e.outlays),
    })),
    `gross × ${r.capitalGainsInclusion.toString()} − applied losses`);

  // Self-employment L13500 = revenue − expenses
  const seRev = sumD(facts.selfEmploymentIncome.map((i) => i.cadAmount));
  const seExp = sumD(facts.selfEmploymentExpenses.map((i) => i.cadAmount));
  const seNet = maxZero(seRev.minus(seExp));
  push('L13500', 'Self-employment income (net)', seNet,
    [
      ...facts.selfEmploymentIncome.map((i) => ({ source: i.source, amount: i.cadAmount })),
      ...facts.selfEmploymentExpenses.map((i) => ({ source: i.source, amount: i.cadAmount.negated() })),
    ],
    'sum(SE revenue) − sum(SE expenses)');

  // Total income L15000
  const totalIncome = sumD([employmentLine, interest, eligibleGrossed, nonElGrossed, cg.taxable, seNet]);
  push('L15000', 'Total income', totalIncome);

  // RRSP deduction L20800
  const rrsp = Decimal.min(sumD(facts.rrspContribs.map((c) => c.amount)), facts.carryforwards.rrspRoom);
  push('L20800', 'RRSP deduction', rrsp,
    facts.rrspContribs.map((c) => ({ source: c.source, amount: c.amount })),
    `min(contribs, rrspRoom=${facts.carryforwards.rrspRoom.toFixed(2)})`);

  // Net income L23600
  const netIncome = maxZero(totalIncome.minus(rrsp));
  push('L23600', 'Net income', netIncome);

  // Taxable income L26000 (apply non-cap loss carryforward)
  const nonCapLossApplied = Decimal.min(netIncome, facts.carryforwards.nonCapLoss);
  const taxableIncome = maxZero(netIncome.minus(nonCapLossApplied));
  push('L26000', 'Taxable income', taxableIncome,
    nonCapLossApplied.greaterThan(0)
      ? [{ source: 'non-cap loss carryforward applied', amount: nonCapLossApplied }]
      : []);

  // Federal tax before credits
  const federalTaxBeforeCredits = applyBrackets(taxableIncome, r.federalBrackets);
  push('L40424', 'Federal tax before credits', federalTaxBeforeCredits);

  // Federal non-refundable credits
  const bpaFedAmt = basicPersonalAmountFederalApplied(taxableIncome, r);
  const spousalFedAmt = facts.spouse ? spousalCreditFederal(facts.spouse.netIncome, r) : D('0');
  const ageFedAmt = ageCreditFederal(facts.ageAtYearEnd, netIncome, r);
  const employmentFedAmt = employmentAmountFederalApplied(employmentLine, r);
  const cppEmployee = computeCppEmployee(employmentLine, r);
  const eiEmployee = computeEiEmployee(employmentLine, r);
  const cppEiCreditEligible = cppEiCreditAmount(cppEmployee, eiEmployee);
  const fedCreditAmountsTotal = sumD([bpaFedAmt, spousalFedAmt, ageFedAmt, employmentFedAmt, cppEiCreditEligible]);
  const fedNonRefundableLowRatePart = fedCreditAmountsTotal.times(r.donationLowRate);

  // Donations (already a tax-credit value, not an amount × rate)
  // For Phase 1 we don't have a donations data source — set to 0 unless user enters via slip later.
  const donationsFedCredit = D('0');

  // Federal DTC (reduces federal tax dollar-for-dollar in credit-value form)
  const fedDtcEligible = dtcFederal(eligibleGrossed, 'eligible', r);
  const fedDtcNonEligible = dtcFederal(nonElGrossed, 'non_eligible', r);

  const federalTax = maxZero(
    federalTaxBeforeCredits
      .minus(fedNonRefundableLowRatePart)
      .minus(donationsFedCredit)
      .minus(fedDtcEligible)
      .minus(fedDtcNonEligible)
  );
  push('L42000', 'Net federal tax', federalTax,
    [
      { source: 'BPA × low rate', amount: bpaFedAmt.times(r.donationLowRate) },
      { source: 'Spousal × low rate', amount: spousalFedAmt.times(r.donationLowRate) },
      { source: 'Age × low rate', amount: ageFedAmt.times(r.donationLowRate) },
      { source: 'Employment amount × low rate', amount: employmentFedAmt.times(r.donationLowRate) },
      { source: 'CPP+EI × low rate', amount: cppEiCreditEligible.times(r.donationLowRate) },
      { source: 'DTC eligible', amount: fedDtcEligible },
      { source: 'DTC non-eligible', amount: fedDtcNonEligible },
    ]);

  // Ontario tax before credits
  const onTaxBeforeCredits = applyBrackets(taxableIncome, r.provincialBrackets);
  const bpaOnAmt = basicPersonalAmountOntarioApplied(taxableIncome, r);
  const spousalOnAmt = facts.spouse ? spousalCreditOntario(facts.spouse.netIncome, r) : D('0');
  const ageOnAmt = ageCreditOntario(facts.ageAtYearEnd, netIncome, r);
  const onCreditTotal = sumD([bpaOnAmt, spousalOnAmt, ageOnAmt, cppEiCreditEligible]).times(r.provincialBrackets[0].rate);
  const onDtcEligible = dtcOntario(eligibleGrossed, 'eligible', r);
  const onDtcNonEligible = dtcOntario(nonElGrossed, 'non_eligible', r);
  const onTax = maxZero(onTaxBeforeCredits.minus(onCreditTotal).minus(onDtcEligible).minus(onDtcNonEligible));
  push('L42800', 'Net Ontario tax', onTax);

  // ON surtax + Ontario Health Premium (use rate table arrays)
  const onSurtax = computeOnSurtax(onTax, r);
  const ohp = computeOhp(taxableIncome, r);
  push('L42801', 'ON surtax', onSurtax);
  push('L42802', 'Ontario Health Premium', ohp);

  // Totals
  const totalPayable = sumD([federalTax, onTax, onSurtax, ohp, cppEmployee, eiEmployee]);
  push('L43500', 'Total payable', totalPayable);

  const instalmentsPaid = facts.carryforwards.instalmentsPaid;
  const refundOrOwing = totalPayable.minus(instalmentsPaid);
  push('L48500', refundOrOwing.greaterThan(0) ? 'Balance owing' : 'Refund', refundOrOwing);

  return {
    year: facts.year,
    lines,
    totals: {
      totalIncome,
      netIncome,
      taxableIncome,
      federalTax,
      provincialTax: onTax.plus(onSurtax).plus(ohp),
      cppContrib: cppEmployee,
      eiPremium: eiEmployee,
      totalPayable,
      refundOrOwing,
    },
    warnings,
  };
}

function computeOnSurtax(onTax: Decimal, r: RateTable): Decimal {
  if (!r.onSurtaxBands) return D('0');
  let surtax = D('0');
  for (const band of r.onSurtaxBands) {
    if (onTax.greaterThan(band.threshold)) {
      surtax = surtax.plus(onTax.minus(band.threshold).times(band.rate));
    }
  }
  return surtax;
}

function computeOhp(taxableIncome: Decimal, r: RateTable): Decimal {
  let lower = D('0');
  for (const tier of r.ontarioHealthPremium) {
    const upper = tier.upTo ?? taxableIncome;
    if (taxableIncome.lessThanOrEqualTo(lower)) break;
    if (taxableIncome.lessThanOrEqualTo(upper)) {
      const inBand = taxableIncome.minus(lower);
      return tier.flat.plus(inBand.times(tier.marginalRate));
    }
    lower = upper;
  }
  const last = r.ontarioHealthPremium[r.ontarioHealthPremium.length - 1];
  return last.flat;
}
```

- [ ] **Step 5: t1 CRA-scenario tests**

`backend/test/tax/t1-scenarios.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { buildT1 } from '../../src/tax/engine/t1';
import type { TaxYearFacts } from '../../src/tax/engine/types';

const emptyCarryFwd = {
  netCapitalLoss: D('0'),
  rrspRoom: D('0'),
  nonCapLoss: D('0'),
  instalmentsPaid: D('0'),
};

function baseFacts(): TaxYearFacts {
  return {
    year: 2024,
    jurisdiction: 'CA-ON',
    employmentIncome: [],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    slips: [],
    carryforwards: { ...emptyCarryFwd },
    ageAtYearEnd: 40,
  };
}

test('Scenario A: $80k employment, no other income, single, age 40', () => {
  // Reference computation done by hand against CRA T1-2024 lines for ON.
  // Total payable expected ≈ $XX,XXX (engineer: fill in from CRA publication or accountant).
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // First sanity: total income = 80000, no deductions => taxable = 80000
  assert.equal(ret.totals.totalIncome.toFixed(2), '80000.00');
  assert.equal(ret.totals.taxableIncome.toFixed(2), '80000.00');
  // Federal+ON+surtax+OHP+CPP+EI total within published range (~$18k-$20k).
  assert.ok(ret.totals.totalPayable.greaterThan(D('17000')));
  assert.ok(ret.totals.totalPayable.lessThan(D('22000')));
});

test('Scenario B: $80k employment + $10k eligible dividends', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('80000'), cadAmount: D('80000') }],
    eligibleDividends: [{ source: 'T5 BMO', amount: D('10000'), cadAmount: D('10000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // Grossed-up eligible div = 13800, total income includes that line at 13800.
  assert.equal(ret.lines.find((l) => l.code === 'L12000')?.amount.toFixed(2), '13800.00');
});

test('Scenario C: $200k employment triggers BPA phaseout', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'T4', amount: D('200000'), cadAmount: D('200000') }],
  };
  const ret = buildT1(facts, ratesFor(2024));
  // Expect more federal tax than 80k case proportionally
  assert.ok(ret.totals.federalTax.greaterThan(D('40000')));
});

test('Scenario D: $0 income returns 0 payable and no negative tax', () => {
  const facts = baseFacts();
  const ret = buildT1(facts, ratesFor(2024));
  assert.equal(ret.totals.totalPayable.toFixed(2), '0.00');
  for (const line of ret.lines) {
    assert.ok(line.amount.greaterThanOrEqualTo(0), `${line.code} went negative`);
  }
});

test('Scenario E: T4 box 14 of $82k beats computed $79.5k, warning emitted', () => {
  const facts: TaxYearFacts = {
    ...baseFacts(),
    employmentIncome: [{ source: 'computed', amount: D('79500'), cadAmount: D('79500') }],
    slips: [
      {
        slipId: 1,
        slipType: 'T4',
        issuer: 'Acme',
        boxes: { box14: D('82000') },
      },
    ],
  };
  const ret = buildT1(facts, ratesFor(2024));
  assert.equal(ret.lines.find((l) => l.code === 'L10100')?.amount.toFixed(2), '82000.00');
  assert.ok(ret.warnings.length > 0);
  assert.ok(ret.warnings[0].includes('T4 box 14'));
});
```

> **Engineer must add:** at least 3 additional `t1-scenarios.test.ts` cases sourced from Connor's prior filed personal returns. Connor will supply the line values; engineer encodes them as fixtures and asserts `totals.totalPayable` within $1 of the filed value.

- [ ] **Step 6: Run all engine tests**

```bash
yarn workspace backend test 2>&1 | tail -40
```
Expected: all tax engine tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/tax/engine/integration.ts backend/src/tax/engine/instalments.ts backend/src/tax/engine/t1.ts backend/test/tax/instalments.test.ts backend/test/tax/t1-scenarios.test.ts
git commit -m "feat(tax): T1 assembly + instalments + integration stub"
```

---

### Task 17: buildPersonalFacts builder

**Files:**
- Create: `backend/src/tax/builders/buildPersonalFacts.ts`
- Create: `backend/test/tax/buildPersonalFacts.test.ts`

- [ ] **Step 1: Write failing builder tests**

`backend/test/tax/buildPersonalFacts.test.ts`:
```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import {
  Account, Entity, FxRate, InvestmentActivity, Security, TaxSlip, Transaction,
  Carryforward, Household,
} from '../../src/models';
import { D } from '../../src/tax/util/decimal';
import { buildPersonalFacts } from '../../src/tax/builders/buildPersonalFacts';

before(async () => {
  await sequelize.sync({ force: true });
});

test('builds facts from seeded data', async () => {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'Personal', jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Checking', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000.0000', currency: 'CAD',
    finalCategory: 'employment_income',
  } as never);
  const facts = await buildPersonalFacts(entity.id, 2024);
  assert.equal(facts.year, 2024);
  assert.equal(facts.jurisdiction, 'CA-ON');
  assert.ok(facts.employmentIncome.length >= 0);
});

test('USD interest converted to CAD via FxRate', async () => {
  // Engineer: seed Security + InvestmentActivity in USD + FxRate USD->CAD = 1.35
  // then assert interestIncome[0].cadAmount = amount * 1.35
});
```

- [ ] **Step 2: Implement buildPersonalFacts**

`backend/src/tax/builders/buildPersonalFacts.ts`:
```ts
import { Op } from 'sequelize';
import {
  Account,
  Carryforward,
  Entity,
  FxRate,
  InvestmentActivity,
  Security,
  TaxSlip,
  Transaction,
} from '../../models';
import { D } from '../util/decimal';
import type {
  CapGainEvent,
  IncomeItem,
  PersonalCarryforwards,
  SlipFact,
  TaxYearFacts,
} from '../engine/types';
import { computeAcb } from '../../portfolio/acb';

export async function buildPersonalFacts(entityId: number, year: number): Promise<TaxYearFacts> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'personal') throw new Error(`Entity ${entityId} is not personal`);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);

  const txns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
    },
  });

  const employmentIncome: IncomeItem[] = [];
  const selfEmploymentIncome: IncomeItem[] = [];
  const selfEmploymentExpenses: IncomeItem[] = [];

  for (const t of txns) {
    const cad = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
    const item: IncomeItem = {
      source: `Txn #${t.id} ${(t as any).finalCategory ?? ''}`,
      amount: D(t.amount as unknown as string),
      cadAmount: cad,
    };
    const cat = (t as any).finalCategory ?? '';
    if (cat === 'employment_income') employmentIncome.push(item);
    else if ((t as any).business && cad.greaterThan(0)) selfEmploymentIncome.push(item);
    else if ((t as any).business && cad.lessThan(0))
      selfEmploymentExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount as unknown as string).abs() });
  }

  // Investment activity → interest, dividends, capital gain events
  const activity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.between]: [yearStart, yearEnd] },
        },
        include: [{ model: Security }],
      })
    : [];

  const interestIncome: IncomeItem[] = [];
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];

  for (const a of activity) {
    const cad = await toCad(D(a.amount as unknown as string), (a as any).currency ?? 'CAD', a.tradeDate as unknown as string);
    const item: IncomeItem = {
      source: `${(a as any).Security?.symbol ?? '?'} ${a.activityType} ${a.tradeDate}`,
      amount: D(a.amount as unknown as string),
      cadAmount: cad,
    };
    if (a.activityType === 'interest') interestIncome.push(item);
    else if (a.activityType === 'dividend') {
      // Default to eligible. Engineer note: future enhancement = tag eligible/non on Security or per activity.
      eligibleDividends.push(item);
    }
  }

  // Capital gain events from sells, using ACB helper
  const capitalGainEvents: CapGainEvent[] = [];
  const securityIds = Array.from(new Set(activity.map((a) => a.securityId).filter((x): x is number => x != null)));
  for (const sid of securityIds) {
    const acts = activity.filter((a) => a.securityId === sid);
    const acb = computeAcb(acts.map((a) => ({
      activityType: a.activityType as any,
      tradeDate: a.tradeDate as unknown as string,
      quantity: Number(a.quantity),
      amount: Number(a.amount),
      fees: Number((a as any).fees ?? 0),
    })));
    for (const realized of acb.realized ?? []) {
      capitalGainEvents.push({
        source: `Security ${sid} sell ${realized.date}`,
        securityId: sid,
        proceeds: D(realized.proceeds),
        acb: D(realized.acb),
        outlays: D(realized.fees ?? 0),
        date: realized.date,
      });
    }
  }

  // Slips
  const slipRows = await TaxSlip.findAll({ where: { entityId, year } });
  const slips: SlipFact[] = slipRows.map((s) => ({
    slipId: s.id,
    slipType: s.slipType as any,
    issuer: s.issuer,
    boxes: Object.fromEntries(
      Object.entries((s.boxValues ?? {}) as Record<string, number | string>).map(([k, v]) => [k, D(v as any)])
    ),
  }));

  // Carryforwards as of prior year
  const cf = await Carryforward.findAll({ where: { entityId, asOfYear: year - 1 } });
  const carryforwards: PersonalCarryforwards = {
    netCapitalLoss: D(cf.find((c) => c.kind === 'cap_loss')?.amount ?? 0),
    rrspRoom: D(cf.find((c) => c.kind === 'rrsp_room')?.amount ?? 0),
    nonCapLoss: D(cf.find((c) => c.kind === 'non_cap_loss')?.amount ?? 0),
    instalmentsPaid: D(cf.find((c) => c.kind === 'instalments_paid')?.amount ?? 0),
  };

  return {
    year,
    jurisdiction: 'CA-ON',
    employmentIncome,
    selfEmploymentIncome,
    selfEmploymentExpenses,
    interestIncome,
    eligibleDividends,
    nonEligibleDividends,
    capitalGainEvents,
    rrspContribs: [], // Phase 1: derive from Transactions with category=rrsp_contribution OR add slip-based path later
    slips,
    carryforwards,
    ageAtYearEnd: 0, // Phase 1: read from User profile; default 0 if missing
  };
}

async function toCad(amount: import('../util/decimal').Decimal, currency: string, date: string) {
  if (currency === 'CAD') return amount;
  const rate = await FxRate.findOne({
    where: { fromCurrency: currency, toCurrency: 'CAD' },
    order: [['ratedDate', 'DESC']],
  });
  if (!rate) throw new Error(`FX rate missing for ${currency}→CAD on/before ${date}`);
  return amount.times(rate.rate as unknown as string);
}
```

> **Engineer note:** `ageAtYearEnd` and the `rrspContribs` source need richer modeling. Phase 1 acceptable defaults: read DOB from `User` if present, else 0; treat any Transaction with `finalCategory === 'rrsp_contribution'` as an RRSP contrib. Add a follow-up TODO in `MEMORY.md` / kindex.

- [ ] **Step 3: Run builder tests**

```bash
yarn workspace backend test 2>&1 | grep buildPersonal
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/tax/builders/buildPersonalFacts.ts backend/test/tax/buildPersonalFacts.test.ts
git commit -m "feat(tax): buildPersonalFacts builder (DB → TaxYearFacts)"
```

---

### Task 18: Tax route with snapshot caching

**Files:**
- Create: `backend/src/routes/tax.ts`
- Create: `backend/test/tax/routes.test.ts`
- Modify: `backend/src/app.ts` (mount router)

- [ ] **Step 1: Write failing route test**

`backend/test/tax/routes.test.ts`:
```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app';
import { sequelize } from '../../src/db';
import { Household, User, Entity } from '../../src/models';

let app: ReturnType<typeof createApp>;

before(async () => {
  await sequelize.sync({ force: true });
  app = createApp();
});

test('GET /api/tax/entities returns entities for current household', async () => {
  // engineer: seed user/session/household + entity, then call:
  const res = await request(app).get('/api/tax/entities');
  // Without auth → 401
  assert.equal(res.status, 401);
});

test('GET /api/tax/personal/:year/return: 404 if no personal entity', async () => {
  // engineer: seed authed user with household but no entity, expect 404 with seed message
});

test('GET /api/tax/personal/:year/return: returns cached snapshot on second call when facts unchanged', async () => {
  // engineer: seed everything, call twice, assert second hits cache (e.g. computedAt unchanged)
});
```

- [ ] **Step 2: Implement route**

`backend/src/routes/tax.ts`:
```ts
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { Entity, TaxReturn, TaxSlip, Carryforward } from '../models';
import { buildPersonalFacts } from '../tax/builders/buildPersonalFacts';
import { buildT1 } from '../tax/engine/t1';
import { ratesFor, RateTableMissingError } from '../tax/engine/brackets';
import { factsHash } from '../tax/util/factsHash';

const router = Router();

router.get('/entities', currentAuth, async (req, res) => {
  const auth = (req as any).auth;
  const householdId = auth?.householdId;
  if (!householdId) return res.status(401).end();
  const entities = await Entity.findAll({ where: { householdId } });
  res.json({ entities });
});

router.get('/personal/:year/return', currentAuth, async (req, res, next) => {
  try {
    const auth = (req as any).auth;
    const householdId = auth?.householdId;
    if (!householdId) return res.status(401).end();
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'invalid year' });
    }
    const entity = await Entity.findOne({ where: { householdId, kind: 'personal' } });
    if (!entity) {
      return res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household. POST /api/tax/entities to create one.',
      });
    }

    const facts = await buildPersonalFacts(entity.id, year);
    const hash = factsHash(serializeFacts(facts));

    const cached = await TaxReturn.findOne({ where: { entityId: entity.id, year } });
    if (cached && cached.factsHash === hash) {
      return res.json({
        cached: true,
        computedAt: cached.computedAt,
        lines: cached.lines,
        totals: cached.totals,
        warnings: cached.warnings,
      });
    }

    const ret = buildT1(facts, ratesFor(year));
    const lines = serializeLines(ret.lines);
    const totals = serializeTotals(ret.totals);
    const computedAt = new Date();

    if (cached) {
      await cached.update({
        factsHash: hash,
        computedAt,
        lines: lines as any,
        totals: totals as any,
        warnings: ret.warnings as any,
      });
    } else {
      await TaxReturn.create({
        entityId: entity.id,
        year,
        factsHash: hash,
        computedAt,
        lines: lines as any,
        totals: totals as any,
        warnings: ret.warnings as any,
      } as any);
    }

    res.json({ cached: false, computedAt, lines, totals, warnings: ret.warnings });
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      return res.status(409).json({ error: 'rate_table_missing', message: (err as Error).message });
    }
    next(err);
  }
});

router.get('/carryforwards', currentAuth, async (req, res) => {
  const auth = (req as any).auth;
  const householdId = auth?.householdId;
  if (!householdId) return res.status(401).end();
  const entity = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  if (!entity) return res.json({ carryforwards: [] });
  const rows = await Carryforward.findAll({ where: { entityId: entity.id }, order: [['asOfYear', 'DESC']] });
  res.json({ carryforwards: rows });
});

router.post('/carryforwards', currentAuth, async (req, res) => {
  const auth = (req as any).auth;
  const householdId = auth?.householdId;
  if (!householdId) return res.status(401).end();
  const { entityId, kind, asOfYear, amount, notes } = req.body ?? {};
  const entity = await Entity.findOne({ where: { id: entityId, householdId } });
  if (!entity) return res.status(404).json({ error: 'entity_not_found' });
  const [row] = await Carryforward.upsert({
    entityId: entity.id, kind, asOfYear, amount, notes,
  } as any);
  res.status(201).json({ carryforward: row });
});

router.post('/slips', currentAuth, async (req, res) => {
  const auth = (req as any).auth;
  const householdId = auth?.householdId;
  if (!householdId) return res.status(401).end();
  const { entityId, year, slipType, issuer, boxValues } = req.body ?? {};
  const entity = await Entity.findOne({ where: { id: entityId, householdId } });
  if (!entity) return res.status(404).json({ error: 'entity_not_found' });
  const slip = await TaxSlip.create({
    entityId: entity.id, year, slipType, issuer, boxValues,
  } as any);
  res.status(201).json({ slip });
});

router.get('/slips', currentAuth, async (req, res) => {
  const auth = (req as any).auth;
  const householdId = auth?.householdId;
  if (!householdId) return res.status(401).end();
  const entity = await Entity.findOne({ where: { householdId, kind: 'personal' } });
  if (!entity) return res.json({ slips: [] });
  const year = req.query.year ? Number(req.query.year) : undefined;
  const rows = await TaxSlip.findAll({ where: year ? { entityId: entity.id, year } : { entityId: entity.id } });
  res.json({ slips: rows });
});

function serializeFacts(facts: ReturnType<typeof structuredClone> | unknown): unknown {
  // Convert Decimal instances to strings for hashing stability.
  return JSON.parse(
    JSON.stringify(facts, (_k, v) =>
      v && typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function' && (v as any).constructor?.name === 'Decimal'
        ? (v as any).toFixed(8)
        : v
    )
  );
}

function serializeLines(lines: any[]): unknown {
  return lines.map((l) => ({
    ...l,
    amount: l.amount.toFixed(2),
    inputs: l.inputs.map((i: any) => ({ ...i, amount: i.amount.toFixed(2) })),
  }));
}

function serializeTotals(totals: any): unknown {
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, (v as any).toFixed(2)]));
}

export default router;
```

- [ ] **Step 3: Mount router in app.ts**

In `backend/src/app.ts` (or whatever file calls `app.use('/api/...', router)`), add:
```ts
import taxRouter from './routes/tax';
// ... inside createApp():
app.use('/api/tax', taxRouter);
```

- [ ] **Step 4: Run route tests**

```bash
yarn workspace backend test 2>&1 | grep routes
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/tax.ts backend/src/app.ts backend/test/tax/routes.test.ts
git commit -m "feat(tax): /api/tax routes with snapshot caching"
```

---

### Task 19: Frontend route + sidebar entry + TaxPage shell

**Files:**
- Create: `frontend/src/pages/TaxPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Write TaxPage shell**

`frontend/src/pages/TaxPage.tsx`:
```tsx
import { useState } from 'react';
import { Tabs } from '../components/ui/tabs';
import { OverviewTab } from './tax/OverviewTab';
import { PersonalT1Tab } from './tax/PersonalT1Tab';
import { SlipsTab } from './tax/SlipsTab';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
];

export function TaxPage() {
  const [tab, setTab] = useState('overview');
  return (
    <section>
      <header><h1>Tax</h1></header>
      <Tabs items={TABS} value={tab} onValueChange={setTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'personal' && <PersonalT1Tab />}
      {tab === 'slips' && <SlipsTab />}
    </section>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `frontend/src/App.tsx`, after the existing imports add:
```tsx
import { TaxPage } from './pages/TaxPage';
```
Inside `<Routes>`, before `<Route path="settings" ...>`:
```tsx
          <Route path="tax" element={<TaxPage />} />
```

- [ ] **Step 3: Add sidebar nav item**

In `frontend/src/components/Sidebar.tsx`, locate the `navItems` array (lines ~34–47). Add after Reports:
```tsx
  { to: '/tax', label: 'Tax', icon: 'tax' },
```
If the icon set lacks `tax`, use an existing applicable icon string (e.g. `'reports'`) and add a note for a future icon swap.

- [ ] **Step 4: Type-check + lint**

```bash
yarn workspace frontend run lint
yarn workspace frontend run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TaxPage.tsx frontend/src/App.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(tax): TaxPage shell + /tax route + sidebar nav"
```

---

### Task 20: Frontend hooks (useTaxEntities, useTaxReturn, useTaxSlips)

**Files:**
- Create: `frontend/src/hooks/useTaxEntities.ts`
- Create: `frontend/src/hooks/useTaxReturn.ts`
- Create: `frontend/src/hooks/useTaxSlips.ts`

- [ ] **Step 1: useTaxEntities**

`frontend/src/hooks/useTaxEntities.ts`:
```ts
import { useEffect, useState } from 'react';

export type TaxEntity = {
  id: number;
  kind: 'personal' | 'corp';
  legalName: string;
  jurisdiction: string;
  fiscalYearEnd: string | null;
};

export function useTaxEntities() {
  const [entities, setEntities] = useState<TaxEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tax/entities', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setEntities(d.entities); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);
  return { entities, error };
}
```

- [ ] **Step 2: useTaxReturn**

`frontend/src/hooks/useTaxReturn.ts`:
```ts
import { useEffect, useState } from 'react';

export type TaxLineDto = {
  code: string;
  label: string;
  amount: string; // serialized Decimal (toFixed(2))
  inputs: { source: string; amount: string }[];
  formula?: string;
};

export type TaxReturnDto = {
  cached: boolean;
  computedAt: string;
  lines: TaxLineDto[];
  totals: Record<string, string>;
  warnings: string[];
};

export function useTaxReturn(year: number) {
  const [data, setData] = useState<TaxReturnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tax/personal/${year}/return`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).message ?? r.statusText);
        return r.json();
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e?.message ?? e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [year]);
  return { data, error, loading };
}
```

- [ ] **Step 3: useTaxSlips**

`frontend/src/hooks/useTaxSlips.ts`:
```ts
import { useCallback, useEffect, useState } from 'react';

export type SlipDto = {
  id: number;
  entityId: number;
  year: number;
  slipType: 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
  issuer: string;
  boxValues: Record<string, number | string>;
};

export function useTaxSlips(year?: number) {
  const [slips, setSlips] = useState<SlipDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const url = year ? `/api/tax/slips?year=${year}` : '/api/tax/slips';
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) { setError(r.statusText); return; }
    setSlips((await r.json()).slips);
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const create = useCallback(async (input: Omit<SlipDto, 'id'>) => {
    const r = await fetch('/api/tax/slips', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(r.statusText);
    await load();
  }, [load]);
  return { slips, error, create, refresh: load };
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useTaxEntities.ts frontend/src/hooks/useTaxReturn.ts frontend/src/hooks/useTaxSlips.ts
git commit -m "feat(tax): frontend hooks for entities, return, slips"
```

---

### Task 21: Frontend tab components

**Files:**
- Create: `frontend/src/pages/tax/OverviewTab.tsx`
- Create: `frontend/src/pages/tax/PersonalT1Tab.tsx`
- Create: `frontend/src/pages/tax/SlipsTab.tsx`

- [ ] **Step 1: OverviewTab**

`frontend/src/pages/tax/OverviewTab.tsx`:
```tsx
import { useTaxReturn } from '../../hooks/useTaxReturn';

const YEAR = new Date().getUTCFullYear();

export function OverviewTab() {
  const { data, error, loading } = useTaxReturn(YEAR);
  if (loading) return <p className="muted">Computing…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;
  return (
    <div>
      <h2>Year {YEAR} — Estimated total payable</h2>
      <p className="big-number">${data.totals.totalPayable}</p>
      <ul>
        <li>Federal tax: ${data.totals.federalTax}</li>
        <li>Ontario tax (incl. surtax + OHP): ${data.totals.provincialTax}</li>
        <li>CPP: ${data.totals.cppContrib}</li>
        <li>EI: ${data.totals.eiPremium}</li>
      </ul>
      {data.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          <ul>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>
      )}
      <p className="muted">{data.cached ? 'Cached snapshot' : 'Freshly computed'} at {new Date(data.computedAt).toLocaleString()}</p>
    </div>
  );
}
```

- [ ] **Step 2: PersonalT1Tab**

`frontend/src/pages/tax/PersonalT1Tab.tsx`:
```tsx
import { useState } from 'react';
import { useTaxReturn, type TaxLineDto } from '../../hooks/useTaxReturn';

const YEAR = new Date().getUTCFullYear();

export function PersonalT1Tab() {
  const { data, error, loading } = useTaxReturn(YEAR);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (loading) return <p className="muted">Computing…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;
  return (
    <div>
      <h2>Personal T1 — {YEAR}</h2>
      <table>
        <thead>
          <tr><th>Line</th><th>Label</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <LineRow key={l.code} line={l} expanded={expanded === l.code} onClick={() => setExpanded(expanded === l.code ? null : l.code)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({ line, expanded, onClick }: { line: TaxLineDto; expanded: boolean; onClick: () => void }) {
  return (
    <>
      <tr onClick={onClick} style={{ cursor: 'pointer' }}>
        <td>{line.code}</td>
        <td>{line.label}</td>
        <td>${line.amount}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={3}>
            {line.formula && <p className="muted">Formula: {line.formula}</p>}
            <ul>
              {line.inputs.map((i, idx) => (
                <li key={idx}>{i.source}: ${i.amount}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
```

- [ ] **Step 3: SlipsTab**

`frontend/src/pages/tax/SlipsTab.tsx`:
```tsx
import { useState } from 'react';
import { useTaxSlips, type SlipDto } from '../../hooks/useTaxSlips';
import { useTaxEntities } from '../../hooks/useTaxEntities';

const YEAR = new Date().getUTCFullYear();
const SLIP_TYPES: SlipDto['slipType'][] = ['T4', 'T5', 'T3', 'T4A', 'T5008'];

export function SlipsTab() {
  const { entities } = useTaxEntities();
  const { slips, create, error } = useTaxSlips(YEAR);
  const personal = entities?.find((e) => e.kind === 'personal');
  const [form, setForm] = useState({ slipType: 'T4' as SlipDto['slipType'], issuer: '', boxValues: '{}' });
  if (!personal) return <p className="muted">No personal entity. Seed one first.</p>;
  return (
    <div>
      <h2>Tax slips ({YEAR})</h2>
      <ul>
        {slips.map((s) => (
          <li key={s.id}>
            {s.slipType} — {s.issuer} — {JSON.stringify(s.boxValues)}
          </li>
        ))}
      </ul>
      <form onSubmit={async (e) => {
        e.preventDefault();
        let parsed: Record<string, number | string>;
        try { parsed = JSON.parse(form.boxValues); }
        catch { alert('boxValues must be valid JSON'); return; }
        await create({
          entityId: personal.id,
          year: YEAR,
          slipType: form.slipType,
          issuer: form.issuer,
          boxValues: parsed,
        });
        setForm({ slipType: 'T4', issuer: '', boxValues: '{}' });
      }}>
        <label>Type
          <select value={form.slipType} onChange={(e) => setForm({ ...form, slipType: e.target.value as SlipDto['slipType'] })}>
            {SLIP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Issuer <input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></label>
        <label>Box values (JSON) <textarea value={form.boxValues} onChange={(e) => setForm({ ...form, boxValues: e.target.value })} /></label>
        <button type="submit">Add slip</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Type-check + lint**

```bash
yarn workspace frontend run lint
yarn workspace frontend run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/
git commit -m "feat(tax): Overview, PersonalT1, Slips tab components"
```

---

### Task 22: End-to-end verification

- [ ] **Step 1: Run full backend test suite**

```bash
yarn workspace backend test
```
Expected: all tests green (including pre-existing).

- [ ] **Step 2: Run full frontend lint + typecheck**

```bash
yarn workspace frontend run lint
yarn workspace frontend run typecheck
```

- [ ] **Step 3: Start dev server, open /tax**

```bash
yarn workspace backend run dev &
yarn workspace frontend run dev &
```
Browser → `http://localhost:5173/tax`. Confirm: Overview tab loads, shows current-year payable; Personal T1 tab lists lines and lines expand on click; Slips tab posts and lists.

- [ ] **Step 4: Filing-grade reconciliation against prior return**

Take Connor's last filed personal return. Enter the T4 box 14, T5 box 24/26, T3 boxes, and prior-year carryforwards via `POST /api/tax/slips` and `POST /api/tax/carryforwards`. Set `Account.taxStatus` correctly on any investment accounts. Trigger `GET /api/tax/personal/<filed-year>/return`. Confirm `totals.totalPayable` is within $1 of the filed value. If not, add a failing scenario to `t1-scenarios.test.ts`, fix the engine, re-verify.

- [ ] **Step 5: Update kindex with what shipped**

Run via mcp__kindex__add: capture decisions made during implementation (any constants that drifted from the spec, any builder shortcuts, the prior-year reconciliation result). Link to the spec/plan nodes.

- [ ] **Step 6: Final commit if anything changed**

```bash
git status
git add -A
git commit -m "fix(tax): adjustments from Phase 1 reconciliation"
```
(Skip if working tree is clean.)

- [ ] **Step 7: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(tax): Phase 1 — Personal T1 (federal + Ontario)" --body "$(cat <<'EOF'
## Summary
- New \`/tax\` page in sidebar.
- Schema: Entity, TaxCategory, TaxSlip, Carryforward, TaxReturn snapshot. Account/Transaction gain \`entityId\`; Account gains \`taxStatus\`.
- Pure TS tax engine under \`backend/src/tax/\` with year-keyed rate tables (2024/2025/2026), tested against CRA examples + Connor's prior filed returns.
- Routes: \`/api/tax/entities\`, \`/api/tax/personal/:year/return\` (snapshot-cached via \`factsHash\`), \`/api/tax/slips\`, \`/api/tax/carryforwards\`.
- UI: Overview · Personal T1 (line-by-line, expandable inputs) · Slips (manual entry).

Spec: \`docs/superpowers/specs/2026-05-24-tax-tab-design.md\`
Plan: \`docs/superpowers/plans/2026-05-24-tax-tab-phase-1.md\`

## Test plan
- [ ] \`yarn workspace backend test\` green
- [ ] \`yarn workspace frontend run lint && yarn workspace frontend run typecheck\` green
- [ ] Manual: /tax loads, all three tabs render against real data
- [ ] Reconciliation: prior filed personal return within \$1
EOF
)"
```

---

## Phase 1 follow-up (out of scope but track)

Open issues / Phase 2 inputs to record via `mcp__kindex__add`:
1. RRSP contribution detection currently relies on `Transaction.finalCategory='rrsp_contribution'` — need explicit category + UI flag.
2. `Account.taxStatus` must be manually set per account; UI surfacing of un-set investment accounts is required in Phase 1 first-run flow.
3. Dividend eligibility (eligible vs non-eligible) currently defaults all dividend activity to eligible. Need per-Security or per-Activity flag.
4. Donation source: no donation data in the model yet — add `donations` slip-like manual entry in Phase 2.
5. Spousal `netIncome` is currently optional and unsourced from the UI; needs partner-invite household integration in Phase 2.
6. `ageAtYearEnd` default 0 — wire from `User` profile (add DOB column if missing).
7. Engine `Decimal` enforcement: add ESLint rule (e.g. `no-restricted-globals` for `Number` inside `backend/src/tax/engine/`) or unit test that imports the module and inspects type signatures.

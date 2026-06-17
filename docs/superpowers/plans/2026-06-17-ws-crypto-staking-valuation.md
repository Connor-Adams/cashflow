# WS Crypto Staking Valuation + Dual-Write Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the WS importer from writing dead-weight zero-CAD Transaction rows for investment accounts, purge the existing 358, and value the 673 crypto staking rewards in CAD at FMV so income and ACB are correct.

**Architecture:** One parser guard removes the dual-write; one ops script purges existing rows. For valuation: backfill DOT/ETH daily close prices into `security_daily_prices`, compute each reward's CAD FMV (`qty × close` on `trade_date`), write `amount`+`price` onto its `investment_activities` row, and teach the ACB engine to treat a valued `staking_reward` as a cost-basis inflow.

**Tech Stack:** TypeScript, Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` (colocated `*.test.ts`), Yahoo (`yahoo-finance2`) + Bank of Canada Valet helpers already in-repo.

**Spec:** `docs/superpowers/specs/2026-06-17-ws-crypto-staking-valuation-design.md`

## Global Constraints

- Backend tests are `node:test` via `tsx`, colocated `foo.test.ts` beside `foo.ts` under `backend/src/`. Run one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/path/x.test.ts`.
- Write Sequelize that runs on both SQLite (default) and Postgres.
- Commit with husky present but no worktree `node_modules`: prefix `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …`.
- No `Co-Authored-By` / co-author trailers.
- Prod writes (purge `--commit`, valuation `--commit`) require Connor's explicit confirmation of exact SQL + counts from a `--dry-run` first. Never auto-run a prod write.
- Ops scripts live in `backend/scripts/`, are `#!/usr/bin/env tsx`, default to `--dry-run`, support `--verbose` / `--household-id` / `--account-id`, connect via `import { ..., sequelize } from '../src/models'`, and use the `DryRunRollback` pattern (do the writes inside a transaction, throw `DryRunRollback` at the end when `--dry-run` so nothing persists).

---

### Task 1: Import guard — stop dual-writing zero-CAD investment Transaction rows

**Files:**
- Modify: `backend/src/import/parseStatementFile.ts:640` (the `base.transactions.push` site)
- Test: `backend/src/import/parseStatementFile.test.ts` (add case; create if absent)

**Interfaces:**
- Consumes: existing `account.accountType`, mapped value `v` (has `.amount: number`).
- Produces: nothing new; behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/import/parseStatementFile.test.ts`. Use the existing WS-monthly fixture pattern in that file (or the nearest existing crypto fixture); the assertion is what matters:

```ts
test('investment account: zero-CAD WS crypto rows create InvestmentActivity but no Transaction', async () => {
  // WS monthly crypto CSV: one staking reward (amount=0) + one real buy (amount<>0)
  const csv = [
    'date,transaction,description,amount,balance,currency',
    '2025-01-06,CRYPTORWD,0.0000544651 of ETH rewards earned,0,0,CAD',
    '2025-01-06,BUY,Purchase of 1.5 DOT (executed at 2025-01-06),-12.00,0,CAD',
  ].join('\n');
  const preview = await parsePreviewForTest(csv, { accountType: 'investment' });

  // reward → activity only, no transaction
  expect(preview.investmentActivities.some((a) => a.activityType === 'staking_reward')).toBe(true);
  expect(preview.transactions.some((t) => t.amount === 0)).toBe(false);
  // real buy still produces a transaction
  expect(preview.transactions.some((t) => t.amount === -12)).toBe(true);
});
```

> If `parsePreviewForTest` / a preview harness doesn't exist in that file, mirror the existing test's setup helper. The behavioral asserts (no zero-amount transaction; activity present; nonzero buy present) are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/parseStatementFile.test.ts`
Expected: FAIL — a zero-amount transaction IS currently pushed.

- [ ] **Step 3: Implement the guard**

In `parseStatementFile.ts`, replace the `base.transactions.push({...})` block at line 640 with a guarded version:

```ts
        const isInvestment = String(account.accountType) === 'investment';
        if (!(isInvestment && v.amount === 0)) {
          base.transactions.push({
            ...v,
            sourceRowFingerprint: fp,
            ...(overrideTxnType ? { overrideTxnType } : {}),
          });
        }
```

Leave the `previewRows.push(...)` immediately after unchanged (the row still shows in the preview UI; we just don't persist a Transaction for it).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/parseStatementFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/parseStatementFile.ts backend/src/import/parseStatementFile.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "fix(import): stop dual-writing zero-CAD Transaction rows for investment accounts"
```

---

### Task 2: Purge script — delete existing dead-weight investment zero-amount transactions

**Files:**
- Create: `backend/scripts/purge-investment-zero-transactions.ts`

**Interfaces:**
- Consumes: `Transaction`, `Account`, `sequelize` from `../src/models`.
- Produces: an ops script (no code other tasks import).

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Purge dead-weight zero-CAD Transaction rows on INVESTMENT accounts.
 *
 * These are the cash-side mirror of in-kind crypto events (staking
 * reward/fee/stake) that also live — richer, with quantity — in
 * investment_activities. They carry amount=0, are filtered out of every
 * reader (isNonSpend treats txn_type reward/fee/investment AND
 * account_type='investment' as non-spend), and produce spurious
 * date+amount dupe collisions. Safe to delete; no report/tax/dashboard
 * number depends on them. The import guard (parseStatementFile) stops
 * new ones being created — run that change FIRST so these don't regrow.
 *
 * Usage:
 *   cd backend && npx tsx scripts/purge-investment-zero-transactions.ts --dry-run
 *   cd backend && npx tsx scripts/purge-investment-zero-transactions.ts            # commits
 * Flags: --dry-run (report only), --account-id N, --household-id N, --verbose
 */
import { Op } from 'sequelize';
import { Transaction, Account, sequelize } from '../src/models';

type Flags = { dryRun: boolean; verbose: boolean; accountId: number | null; householdId: number | null };

function numFlag(argv: string[], name: string): number | null {
  const i = argv.indexOf(name);
  const v = i !== -1 && i < argv.length - 1 ? Number(argv[i + 1]) : null;
  return Number.isFinite(v as number) ? (v as number) : null;
}
function parseFlags(argv: string[]): Flags {
  return {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    accountId: numFlag(argv, '--account-id'),
    householdId: numFlag(argv, '--household-id'),
  };
}
class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const accountWhere: Record<string, unknown> = { accountType: 'investment' };
  if (flags.accountId != null) accountWhere.id = flags.accountId;
  if (flags.householdId != null) accountWhere.householdId = flags.householdId;

  const rows = await Transaction.findAll({
    where: { amount: 0 },
    include: [{ model: Account, as: 'account', where: accountWhere, attributes: ['id', 'name', 'accountType'] }],
  });

  // Group counts for the confirmation gate.
  const byAccount = new Map<string, number>();
  for (const r of rows) {
    const a = (r as unknown as { account?: { name?: string } }).account;
    const key = a?.name ?? `acct ${(r as unknown as { accountId: number }).accountId}`;
    byAccount.set(key, (byAccount.get(key) ?? 0) + 1);
  }
  console.log(`Matched ${rows.length} zero-CAD transactions on investment accounts:`);
  for (const [k, n] of byAccount) console.log(`  ${k}: ${n}`);
  if (flags.verbose) for (const r of rows) console.log(`  id=${(r as unknown as { id: number }).id}`);

  const ids = rows.map((r) => (r as unknown as { id: number }).id);
  await sequelize.transaction(async (t) => {
    if (ids.length > 0) {
      await Transaction.destroy({ where: { id: { [Op.in]: ids } }, transaction: t });
    }
    if (flags.dryRun) throw new DryRunRollback();
  }).catch((err) => { if (!(err instanceof DryRunRollback)) throw err; });

  console.log(flags.dryRun ? 'DRY RUN — nothing deleted.' : `Deleted ${ids.length} rows.`);
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Verify dry-run locally (no external services)**

Run: `cd backend && npx tsx scripts/purge-investment-zero-transactions.ts --dry-run`
Expected: prints a match count + per-account breakdown, ends `DRY RUN — nothing deleted.`, exits 0. (Local SQLite is empty/dev — count may be 0; the assertion is the script runs clean and rolls back.)

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/purge-investment-zero-transactions.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "chore(import): add purge script for dead-weight investment zero-amount transactions"
```

> Prod execution is Task 7 (gated on Connor confirming counts).

---

### Task 3: ACB engine — recognize valued staking_reward as a cost-basis inflow

**Files:**
- Modify: `backend/src/portfolio/acb.ts` (add a `staking_reward` branch alongside `transfer_in`, before the "all other types ignored" comment at :371)
- Test: `backend/src/portfolio/acb.test.ts`

**Interfaces:**
- Consumes: existing loop locals `type` (= `activity.activityType`), `state` (`{ asOf, quantity, totalCost, acbPerUnit }`), `EPS`, `timeline`, and `activity` (`{ id, tradeDate, quantity: number|null, amount: number|null, currency }`).
- Produces: corrected `finalState`/`timeline` for streams containing valued `staking_reward` rows.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/portfolio/acb.test.ts` (mirror the existing buy/sell test setup in that file for how activities are constructed and `computeAcb` is called):

```ts
test('valued staking_reward adds quantity at FMV cost (weighted-average ACB)', () => {
  // Buy 10 @ $2 (cost 20), reward 2 units valued $6, then check pool.
  const result = computeAcb([
    mkActivity({ activityType: 'buy', quantity: 10, amount: -20, tradeDate: '2025-01-01' }),
    mkActivity({ activityType: 'staking_reward', quantity: 2, amount: 6, tradeDate: '2025-02-01' }),
  ]);
  // pool: qty 12, totalCost 26, acb 26/12
  expect(result.finalState.quantity).toBeCloseTo(12, 8);
  expect(result.finalState.totalCost).toBeCloseTo(26, 8);
  expect(result.finalState.acbPerUnit).toBeCloseTo(26 / 12, 8);
});

test('unvalued staking_reward (amount 0/null) is ignored by ACB', () => {
  const result = computeAcb([
    mkActivity({ activityType: 'buy', quantity: 10, amount: -20, tradeDate: '2025-01-01' }),
    mkActivity({ activityType: 'staking_reward', quantity: 2, amount: 0, tradeDate: '2025-02-01' }),
  ]);
  expect(result.finalState.quantity).toBeCloseTo(10, 8);
  expect(result.finalState.totalCost).toBeCloseTo(20, 8);
});
```

> Use the file's existing activity-builder helper (e.g. `mkActivity`) and `computeAcb` export name. If the helper/export names differ, match the file's actual names — the two numeric contracts above are what must hold.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/portfolio/acb.test.ts`
Expected: FAIL — staking_reward currently ignored, so qty stays 10/cost 20 in the first test.

- [ ] **Step 3: Implement the branch**

In `acb.ts`, add before the closing "All other activity types … intentionally ignored" comment (~:371), as a new `else if`:

```ts
    } else if (type === 'staking_reward') {
      // CRA: a staking reward is income at FMV on receipt, and that FMV
      // becomes the ACB cost base of the newly-received coins. Treat a
      // VALUED reward (quantity>0 AND amount>0) as a BUY at cost = FMV.
      // Unvalued rewards (amount null/0, e.g. pre-backfill) are ignored so
      // the engine degrades safely when a historical price is missing.
      if (
        activity.quantity != null &&
        activity.quantity > EPS &&
        activity.amount != null &&
        Math.abs(activity.amount) > EPS
      ) {
        const qty = activity.quantity;
        const cost = Math.abs(activity.amount);
        const newQuantity = state.quantity + qty;
        const newTotalCost = state.totalCost + cost;
        const newAcb = newQuantity > EPS ? newTotalCost / newQuantity : 0;
        state = {
          asOf: activity.tradeDate,
          quantity: newQuantity,
          totalCost: newTotalCost,
          acbPerUnit: newAcb,
        };
        timeline.push(state);
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/portfolio/acb.test.ts`
Expected: PASS (both new tests + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/acb.ts backend/src/portfolio/acb.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(portfolio): valued staking_reward feeds ACB as cost-basis inflow"
```

---

### Task 4: Pure valuation helper — compute reward CAD value from qty + price + fx

**Files:**
- Create: `backend/src/portfolio/stakingValuation.ts`
- Test: `backend/src/portfolio/stakingValuation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function valueStakingReward(input: {
    quantity: number;
    closePrice: number;       // close on trade_date, in priceCurrency
    priceCurrency: string;    // 'CAD' or 'USD'
    usdCadRate: number | null;// required iff priceCurrency==='USD'
  }): { amountCad: number; pricePerUnitCad: number } | { error: string };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueStakingReward } from './stakingValuation';

test('CAD-priced reward: amount = qty * close, no FX', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'CAD', usdCadRate: null });
  assert.deepEqual(r, { amountCad: 6, pricePerUnitCad: 3 });
});

test('USD-priced reward: applies USD->CAD rate', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'USD', usdCadRate: 1.4 });
  assert.deepEqual(r, { amountCad: 8.4, pricePerUnitCad: 4.2 });
});

test('USD-priced reward without rate is an error', () => {
  const r = valueStakingReward({ quantity: 2, closePrice: 3, priceCurrency: 'USD', usdCadRate: null });
  assert.ok('error' in r);
});

test('rounds amount to 4dp and price to 8dp', () => {
  const r = valueStakingReward({ quantity: 0.0000544651, closePrice: 3500, priceCurrency: 'CAD', usdCadRate: null });
  assert.deepEqual(r, { amountCad: 0.1906, pricePerUnitCad: 3500 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/portfolio/stakingValuation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export function valueStakingReward(input: {
  quantity: number;
  closePrice: number;
  priceCurrency: string;
  usdCadRate: number | null;
}): { amountCad: number; pricePerUnitCad: number } | { error: string } {
  const cur = input.priceCurrency.toUpperCase();
  let perUnitCad: number;
  if (cur === 'CAD') {
    perUnitCad = input.closePrice;
  } else if (cur === 'USD') {
    if (input.usdCadRate == null) return { error: 'USD price requires usdCadRate' };
    perUnitCad = input.closePrice * input.usdCadRate;
  } else {
    return { error: `unsupported price currency ${cur}` };
  }
  return {
    amountCad: round(input.quantity * perUnitCad, 4),
    pricePerUnitCad: round(perUnitCad, 8),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/portfolio/stakingValuation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/stakingValuation.ts backend/src/portfolio/stakingValuation.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(portfolio): pure helper to value a staking reward in CAD"
```

---

### Task 5: Price backfill script — DOT/ETH daily close into security_daily_prices

**Files:**
- Create: `backend/scripts/backfill-crypto-daily-prices.ts`

**Interfaces:**
- Consumes: `fetchDailyHistory(yahooSymbol, { period1 })` from `../src/integrations/yahoo/client` (returns `DailyBar[] | null`, each bar `{ date, close, adjClose, ... }`); `Security`, `SecurityDailyPrice`, `sequelize` from `../src/models`.
- Produces: rows in `security_daily_prices` with `source='yahoo-cad'` so the valuation script knows they're CAD. (`SecurityDailyPrice` has no currency column — we encode currency in `source` and always fetch the `-CAD` ticker.)

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Backfill daily CLOSE prices (in CAD) for crypto securities that have
 * staking rewards needing valuation. Fetches the `<SYMBOL>-CAD` Yahoo
 * ticker so close is already CAD (DOT/ETH both have CAD pairs); rows are
 * tagged source='yahoo-cad'. Idempotent: upsert on (security_id, date).
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01 --dry-run
 *   cd backend && npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01
 */
import { Security, SecurityDailyPrice, sequelize } from '../src/models';
import { fetchDailyHistory } from '../src/integrations/yahoo/client';

function strFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 && i < argv.length - 1 ? argv[i + 1] : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const symbols = (strFlag(argv, '--symbols') ?? 'DOT,ETH').split(',').map((s) => s.trim().toUpperCase());
  const since = strFlag(argv, '--since') ?? '2024-10-01';

  for (const symbol of symbols) {
    const sec = await Security.findOne({ where: { symbol, assetType: 'cryptocurrency' } });
    if (!sec) { console.warn(`no cryptocurrency security for ${symbol}; skipping`); continue; }
    const ticker = `${symbol}-CAD`;
    const bars = await fetchDailyHistory(ticker, { period1: since });
    if (!bars || bars.length === 0) { console.warn(`no bars for ${ticker}`); continue; }
    console.log(`${ticker}: ${bars.length} daily bars from ${bars[0].date} to ${bars[bars.length - 1].date}`);
    if (dryRun) continue;
    for (const b of bars) {
      await SecurityDailyPrice.upsert({
        securityId: (sec as unknown as { id: number }).id,
        date: b.date,
        open: b.open == null ? null : String(b.open),
        high: b.high == null ? null : String(b.high),
        low: b.low == null ? null : String(b.low),
        close: String(b.close),
        adjClose: String(b.adjClose),
        volume: b.volume,
        source: 'yahoo-cad',
        fetchedAt: new Date(),
      });
    }
    console.log(`${ticker}: upserted ${bars.length} rows`);
  }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

> Confirm `security_daily_prices` has a unique index on `(security_id, date)` for `upsert` to update-not-duplicate. If not, the valuation script's lookup still works (it reads the latest matching row), but add the unique index via a migration first. Check: `grep -ri "security_daily_prices" backend/src/migrations`.

- [ ] **Step 2: Verify dry-run (hits Yahoo, no DB write)**

Run: `cd backend && npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01 --dry-run`
Expected: prints bar counts + date spans for `DOT-CAD` and `ETH-CAD`. If a `-CAD` ticker returns no bars, note it for Connor (fallback would be `-USD` + FX in Task 6).

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/backfill-crypto-daily-prices.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(portfolio): backfill script for crypto daily CAD prices"
```

---

### Task 6: Reward valuation backfill script — write amount+price onto staking_reward rows

**Files:**
- Create: `backend/scripts/backfill-staking-reward-values.ts`

**Interfaces:**
- Consumes: `valueStakingReward` (Task 4); `ensureFxRate(from, to, asOfDate)` from `../src/fx/bankOfCanada` (`{ rate, ratedDate } | null`); `InvestmentActivity`, `Security`, `SecurityDailyPrice`, `Account`, `sequelize` from `../src/models`.
- Produces: `amount` + `price` written onto `investment_activities` staking_reward rows.

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Value already-imported crypto staking rewards in CAD at FMV on trade_date.
 * For each staking_reward row (quantity>0, amount null/0): look up the CAD
 * daily close (security_daily_prices, source='yahoo-cad') on/just-before
 * trade_date and write amount = qty*close and price = close. Rows priced in
 * USD would FX via ensureFxRate; with -CAD prices this path is unused.
 * Idempotent, --dry-run default, single transaction. Reports unvalued rows.
 *
 * Run Task 5 (price backfill) FIRST.
 * Usage:
 *   cd backend && npx tsx scripts/backfill-staking-reward-values.ts --account-id 10 --dry-run
 *   cd backend && npx tsx scripts/backfill-staking-reward-values.ts --account-id 10           # commits
 */
import { Op } from 'sequelize';
import { InvestmentActivity, Security, SecurityDailyPrice, Account, sequelize } from '../src/models';
import { valueStakingReward } from '../src/portfolio/stakingValuation';
import { ensureFxRate } from '../src/fx/bankOfCanada';

function numFlag(argv: string[], name: string): number | null {
  const i = argv.indexOf(name);
  const v = i !== -1 && i < argv.length - 1 ? Number(argv[i + 1]) : null;
  return Number.isFinite(v as number) ? (v as number) : null;
}
class DryRunRollback extends Error {}

async function closeOnOrBefore(securityId: number, date: string): Promise<{ close: number; currency: string } | null> {
  const row = await SecurityDailyPrice.findOne({
    where: { securityId, date: { [Op.lte]: date } },
    order: [['date', 'DESC']],
  });
  if (!row) return null;
  const r = row as unknown as { close: string; source: string };
  const currency = r.source === 'yahoo-cad' ? 'CAD' : 'USD';
  return { close: Number(r.close), currency };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');
  const accountId = numFlag(argv, '--account-id');

  const where: Record<string, unknown> = {
    activityType: 'staking_reward',
    quantity: { [Op.gt]: 0 },
    [Op.or]: [{ amount: null }, { amount: 0 }],
  };
  if (accountId != null) where.accountId = accountId;

  const rows = await InvestmentActivity.findAll({ where, order: [['tradeDate', 'ASC']] });
  console.log(`Found ${rows.length} staking_reward rows to value`);

  let valued = 0;
  const unvalued: string[] = [];

  await sequelize.transaction(async (t) => {
    for (const row of rows) {
      const r = row as unknown as { id: number; securityId: number | null; quantity: string; tradeDate: string };
      if (r.securityId == null) { unvalued.push(`id=${r.id} (no security)`); continue; }
      const price = await closeOnOrBefore(r.securityId, r.tradeDate);
      if (!price) { unvalued.push(`id=${r.id} (no price on/before ${r.tradeDate})`); continue; }

      let usdCadRate: number | null = null;
      if (price.currency === 'USD') {
        const fx = await ensureFxRate('USD', 'CAD', r.tradeDate);
        if (!fx) { unvalued.push(`id=${r.id} (no USD->CAD on ${r.tradeDate})`); continue; }
        usdCadRate = fx.rate;
      }

      const result = valueStakingReward({
        quantity: Number(r.quantity), closePrice: price.close, priceCurrency: price.currency, usdCadRate,
      });
      if ('error' in result) { unvalued.push(`id=${r.id} (${result.error})`); continue; }

      if (verbose) console.log(`  id=${r.id} ${r.tradeDate}: qty=${r.quantity} -> $${result.amountCad} @ $${result.pricePerUnitCad}`);
      await InvestmentActivity.update(
        { amount: String(result.amountCad), price: String(result.pricePerUnitCad) },
        { where: { id: r.id }, transaction: t },
      );
      valued += 1;
    }
    if (dryRun) throw new DryRunRollback();
  }).catch((err) => { if (!(err instanceof DryRunRollback)) throw err; });

  console.log(`${dryRun ? '[DRY RUN] would value' : 'Valued'} ${valued} rows; ${unvalued.length} unvalued`);
  if (unvalued.length) { console.log('Unvalued:'); for (const u of unvalued) console.log(`  ${u}`); }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Verify dry-run locally**

Run: `cd backend && npx tsx scripts/backfill-staking-reward-values.ts --account-id 10 --dry-run`
Expected: runs clean, ends with a `[DRY RUN] would value N rows; M unvalued` line, rolls back. (Local SQLite likely has 0 rows — the assertion is clean execution + rollback.)

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/backfill-staking-reward-values.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(portfolio): backfill script to value crypto staking rewards in CAD"
```

---

### Task 7: Prod execution (gated) + full CI

**Files:** none (ops). **Prerequisite:** Tasks 1–6 merged or on-branch; `DATABASE_URL` = Railway public URL (via cashflow-prod-db skill).

- [ ] **Step 1: Run full CI green**

Run: `yarn ci`
Expected: typecheck + all tests + both builds pass. Fix anything red before touching prod.

- [ ] **Step 2: Price backfill (prod, writes price rows only — safe)**

Run: `cd backend && DATABASE_URL=<railway-public-url> npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01`
Expected: upserts DOT-CAD + ETH-CAD daily bars. Re-runnable.

- [ ] **Step 3: Valuation dry-run (prod) → show Connor**

Run: `cd backend && DATABASE_URL=<railway-public-url> npx tsx scripts/backfill-staking-reward-values.ts --account-id 10 --dry-run --verbose`
Expected: `would value ~673 rows; ~33 unvalued (no quantity/security)`. **Paste the summary to Connor; get explicit go before Step 4.**

- [ ] **Step 4: Valuation commit (prod write — only after Connor confirms)**

Run: `cd backend && DATABASE_URL=<railway-public-url> npx tsx scripts/backfill-staking-reward-values.ts --account-id 10 --verbose`

- [ ] **Step 5: Purge dry-run (prod) → show Connor exact counts**

Run: `cd backend && DATABASE_URL=<railway-public-url> npx tsx scripts/purge-investment-zero-transactions.ts --dry-run`
Expected: `Matched 358 ... Wealthsimple Crypto: 358` (verify the per-account breakdown lists only investment accounts). **Paste to Connor; get explicit go.**

- [ ] **Step 6: Purge commit (prod delete — only after Connor confirms)**

Run: `cd backend && DATABASE_URL=<railway-public-url> npx tsx scripts/purge-investment-zero-transactions.ts`

- [ ] **Step 7: Post-verify**

Run a prod check: zero-amount investment transactions now 0; staking_reward rows now carry amount>0; the dupe-collision flag for WS Crypto is gone. Report numbers to Connor.

---

## Self-Review

**Spec coverage:**
- Defect 1 (zero value) → Tasks 4,5,6 (helper, prices, valuation) + Task 7 exec. ✓
- Defect 2 (dual-write) → Task 1 (guard) + Task 2/Task 7 (purge). ✓
- Income recognition fix → valued `amount` on staking_reward (Task 6) consumed by existing `buildPersonalFacts`. ✓
- ACB inflow (Income+ACB scope) → Task 3. ✓
- Non-goals (fee/transfer_in qty) → excluded; not in any task. ✓
- Prod-write confirmation gate → Task 7 Steps 3–6. ✓

**Placeholder scan:** No TBD/TODO; all code blocks concrete. Two explicit "match the file's actual helper name" notes (Task 1 preview harness, Task 3 `mkActivity`/`computeAcb`) where the existing test file owns the name — contracts stated numerically so they're unambiguous. ✓

**Type consistency:** `valueStakingReward` signature identical in Task 4 (def) and Task 6 (consume); `closeOnOrBefore` returns `{close, currency}` matching the helper input; `ensureFxRate` returns `{rate, ratedDate}` per source. `source='yahoo-cad'` written in Task 5, read in Task 6's `closeOnOrBefore`. ✓

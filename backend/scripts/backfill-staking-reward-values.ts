#!/usr/bin/env tsx
/**
 * Value already-imported crypto staking rewards in CAD at FMV on trade_date.
 * For each staking_reward row (quantity>0, amount null/0): look up the CAD
 * daily close (security_daily_prices, source='yahoo-cad') on/just-before
 * trade_date and write amount = qty*close and price = close. Rows priced in
 * USD would FX via ensureFxRate; with -CAD prices this path is unused.
 * Idempotent, single transaction. Reports unvalued rows.
 *
 * Run Task 5 (price backfill) FIRST.
 *
 * Usage (PROD Postgres — NEVER local sqlite):
 *   PUB=$(railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL)
 *   cd backend
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-staking-reward-values.ts --account-id 10            # dry-run (default)
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-staking-reward-values.ts --account-id 10 --commit   # apply
 *
 * Do NOT use `railway run` — it injects the internal-only DATABASE_URL
 * (*.railway.internal) which is unreachable from a laptop.
 *
 * Flags:
 *   --commit          Actually write. Default is dry-run (report only).
 *   --account-id N    Restrict to one account.
 *   --verbose         Log each row's computed valuation before writing.
 */
import { Op } from 'sequelize';
import { InvestmentActivity, SecurityDailyPrice, sequelize } from '../src/models';
import { valueStakingReward } from '../src/portfolio/stakingValuation';
import { ensureFxRate } from '../src/fx/bankOfCanada';
import { databaseUrl } from '../src/config/env';

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
  const commit = argv.includes('--commit');
  const verbose = argv.includes('--verbose');
  const accountId = numFlag(argv, '--account-id');
  const mode = commit ? 'COMMIT (writing)' : 'DRY RUN (report only)';

  if (databaseUrl) {
    console.log(`Target DB: postgres (${new URL(databaseUrl).host})`);
  } else {
    console.log('Target DB: LOCAL SQLITE (no DATABASE_URL set)');
    if (commit) {
      console.error(
        'Refusing to --commit against local sqlite. Set DATABASE_URL to the prod Postgres URL ' +
          '(DATABASE_PUBLIC_URL from `railway variables --service Postgres`).',
      );
      process.exit(1);
    }
  }
  console.log(`mode: ${mode}`);

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
    if (!commit) throw new DryRunRollback();
  }).catch((err) => { if (!(err instanceof DryRunRollback)) throw err; });

  console.log(`${commit ? 'Valued' : '[DRY RUN] would value'} ${valued} rows; ${unvalued.length} unvalued`);
  if (unvalued.length) { console.log('Unvalued:'); for (const u of unvalued) console.log(`  ${u}`); }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

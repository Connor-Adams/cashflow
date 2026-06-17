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

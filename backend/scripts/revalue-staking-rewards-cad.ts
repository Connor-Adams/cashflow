#!/usr/bin/env tsx
/**
 * One-time correction: WS crypto staking_reward rows imported via the
 * activities-export path (commit 86a643d0, 2026-05-25) landed with
 * USD price/amount and currency='USD' — the parser persisted the CSV's
 * unit_price / net_cash_amount verbatim without USD->CAD conversion, while
 * the rest of the (CAD) account stores CAD. This converts those rows to CAD
 * at the Bank-of-Canada USD->CAD rate on trade_date and sets currency='CAD',
 * making the account currency-consistent.
 *
 * Faithful to WS's reported dollar value: CAD = USD_value * FX(trade_date).
 * Converting the amount AND flipping currency to CAD is self-consistent
 * regardless of whether downstream FX-converts (no double-conversion).
 *
 * Idempotent: only touches currency='USD' staking_reward rows, so a re-run
 * after a successful commit finds nothing.
 *
 * Usage (PROD Postgres — NEVER local sqlite):
 *   PUB=$(railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL)
 *   cd backend
 *   DATABASE_URL="$PUB" npx tsx scripts/revalue-staking-rewards-cad.ts --account-id 10            # dry-run (default)
 *   DATABASE_URL="$PUB" npx tsx scripts/revalue-staking-rewards-cad.ts --account-id 10 --commit   # apply
 *
 * Flags: --commit (write; default dry-run), --account-id N, --verbose
 */
import { Op } from 'sequelize';
import { InvestmentActivity, sequelize } from '../src/models';
import { ensureFxRate } from '../src/fx/bankOfCanada';
import { numFlag, hasFlag, guardWriteTarget, DryRunRollback } from './lib/opsFlags';

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, '--commit');
  const verbose = hasFlag(argv, '--verbose');
  const accountId = numFlag(argv, '--account-id');

  guardWriteTarget(commit);
  console.log(`mode: ${commit ? 'COMMIT (writing)' : 'DRY RUN (report only)'}`);

  const where: Record<string, unknown> = {
    activityType: 'staking_reward',
    currency: 'USD',
  };
  if (accountId != null) where.accountId = accountId;

  const rows = await InvestmentActivity.findAll({ where, order: [['tradeDate', 'ASC']] });
  console.log(`Found ${rows.length} USD-valued staking_reward rows to convert to CAD`);

  let converted = 0;
  const skipped: string[] = [];

  await sequelize.transaction(async (t) => {
    for (const row of rows) {
      const r = row as unknown as {
        id: number; tradeDate: string; amount: string | null; price: string | null;
      };
      const fx = await ensureFxRate('USD', 'CAD', r.tradeDate);
      if (!fx) { skipped.push(`id=${r.id} (no USD->CAD on ${r.tradeDate})`); continue; }

      const usdAmount = r.amount == null ? 0 : Number(r.amount);
      const usdPrice = r.price == null ? null : Number(r.price);
      const cadAmount = round(usdAmount * fx.rate, 4);
      const cadPrice = usdPrice == null ? null : round(usdPrice * fx.rate, 8);

      if (verbose) {
        console.log(`  id=${r.id} ${r.tradeDate}: $${usdAmount} USD @ ${fx.rate} -> $${cadAmount} CAD` +
          (cadPrice != null ? ` (price ${usdPrice}->${cadPrice})` : ''));
      }
      await InvestmentActivity.update(
        { amount: String(cadAmount), currency: 'CAD', ...(cadPrice != null ? { price: String(cadPrice) } : {}) },
        { where: { id: r.id }, transaction: t },
      );
      converted += 1;
    }
    if (!commit) throw new DryRunRollback();
  }).catch((err) => { if (!(err instanceof DryRunRollback)) throw err; });

  console.log(`${commit ? 'Converted' : '[DRY RUN] would convert'} ${converted} rows; ${skipped.length} skipped`);
  if (skipped.length) { console.log('Skipped:'); for (const s of skipped) console.log(`  ${s}`); }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

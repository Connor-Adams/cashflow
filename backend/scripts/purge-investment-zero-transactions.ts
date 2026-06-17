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

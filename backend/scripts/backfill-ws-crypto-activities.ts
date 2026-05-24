#!/usr/bin/env tsx
/**
 * Backfill InvestmentActivity rows for Wealthsimple crypto BUY/SELL records
 * that were imported BEFORE the parser learned the
 * "Purchase of <qty> <SYMBOL> (executed at <date>)" / "Sale of ..." formats.
 * Those rows landed with security_id=NULL and quantity=NULL, which made them
 * invisible to the portfolio v2 ACB / Realized P&L engine.
 *
 * For each affected row this script:
 *   1. Re-parses the description with the same crypto regex the parser now
 *      uses at import time.
 *   2. `findOrCreateSecurity` for the symbol (asset_type='cryptocurrency').
 *   3. UPDATEs the row: security_id, quantity, trade_date (= exec-at), and
 *      source_row_fingerprint (recomputed so re-imports of the same CSV are
 *      still deduplicated).
 *
 * Selection criteria:
 *   - activity_type IN ('buy','sell')
 *   - security_id IS NULL
 *   - description matches /^(Purchase|Sale)\s+of\s+[\d.]+\s+[A-Z0-9]+\s*\(executed at/
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-ws-crypto-activities.ts --dry-run
 *   cd backend && npx tsx scripts/backfill-ws-crypto-activities.ts
 *
 * Flags:
 *   --dry-run        Report changes without writing.
 *   --household-id N Restrict to one household.
 *   --verbose        Print every row's parsed values.
 */
import { Op } from 'sequelize';
import { InvestmentActivity, sequelize } from '../src/models';
import { findOrCreateSecurity } from '../src/import/commitStatementImport';
import { stableFingerprint } from '../src/import/fingerprint';

const CRYPTO_BUYSELL_RE =
  /^(Purchase|Sale)\s+of\s+([\d.]+)\s+([A-Z0-9]+)\s*\(executed at (\d{4}-\d{2}-\d{2})\)/i;
const CRYPTO_TRADING_FEE_RE =
  /^Trading fee for (?:purchase|sale)\s+of\s+[\d.]+\s+([A-Z0-9]+)\s*\(executed at (\d{4}-\d{2}-\d{2})\)/i;
const CRYPTO_STAKING_FEE_RE = /^Fee paid on ([A-Z0-9]+)-([^:]+) staking reward:/i;

type Flags = {
  dryRun: boolean;
  verbose: boolean;
  householdId: number | null;
};

function parseFlags(argv: string[]): Flags {
  const idx = argv.indexOf('--household-id');
  const hh = idx !== -1 && idx < argv.length - 1 ? Number(argv[idx + 1]) : null;
  return {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    householdId: Number.isFinite(hh as number) ? (hh as number) : null,
  };
}

class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[crypto-backfill] flags:', flags);

  const where: Record<string, unknown> = {
    activityType: { [Op.in]: ['buy', 'sell', 'fee'] },
    securityId: null,
    description: {
      [Op.iRegexp]:
        '^(Purchase of |Sale of |Trading fee for |Fee paid on [A-Z0-9]+-)',
    },
  };
  if (flags.householdId != null) where.householdId = flags.householdId;

  let processed = 0;
  let updated = 0;
  let noMatch = 0;
  let dateShifted = 0;
  const bySymbol: Record<string, number> = {};

  await sequelize
    .transaction(async (t) => {
      const rows = (await InvestmentActivity.findAll({
        where,
        attributes: [
          'id',
          'accountId',
          'householdId',
          'activityType',
          'tradeDate',
          'description',
          'amount',
          'currency',
          'sourceRowFingerprint',
        ],
        order: [['id', 'ASC']],
        transaction: t,
        raw: true,
      })) as unknown as Array<{
        id: number;
        accountId: number;
        householdId: number | null;
        activityType: 'buy' | 'sell';
        tradeDate: string;
        description: string;
        amount: string | null;
        currency: string;
        sourceRowFingerprint: string;
      }>;

      console.log(`[crypto-backfill] candidate rows: ${rows.length}`);

      for (const row of rows) {
        processed += 1;

        let symbol: string | null = null;
        let name: string | null = null;
        let newQty: number | null = null;
        let newTradeDate: string = row.tradeDate;

        if (row.activityType === 'buy' || row.activityType === 'sell') {
          const m = row.description.match(CRYPTO_BUYSELL_RE);
          if (m) {
            newQty = parseFloat(m[2]);
            symbol = m[3].trim().toUpperCase();
            newTradeDate = m[4];
          }
        } else if (row.activityType === 'fee') {
          const t1 = row.description.match(CRYPTO_TRADING_FEE_RE);
          if (t1) {
            symbol = t1[1].trim().toUpperCase();
            newTradeDate = t1[2];
          } else {
            const t2 = row.description.match(CRYPTO_STAKING_FEE_RE);
            if (t2) {
              symbol = t2[1].trim().toUpperCase();
              name = t2[2].trim();
            }
          }
        }

        if (!symbol) {
          noMatch += 1;
          continue;
        }

        const amountNum = row.amount == null ? 0 : parseFloat(String(row.amount));
        const txCode =
          row.activityType === 'buy' ? 'BUY' : row.activityType === 'sell' ? 'SELL' : 'FEE';

        const newFingerprint = stableFingerprint({
          kind: 'ws_invest',
          accountId: row.accountId,
          tradeDate: newTradeDate,
          txCode,
          description: row.description,
          amount: amountNum,
        });

        bySymbol[symbol] = (bySymbol[symbol] ?? 0) + 1;
        if (row.tradeDate !== newTradeDate) dateShifted += 1;

        if (flags.verbose) {
          console.log(
            `[crypto-backfill] row ${row.id} (${row.tradeDate} ${row.activityType}) -> sym=${symbol} qty=${newQty ?? '-'} date=${newTradeDate} fp=${newFingerprint.slice(0, 8)}`,
          );
        }

        if (!flags.dryRun) {
          const sec = await findOrCreateSecurity(
            {
              symbol,
              name: name ?? symbol,
              assetType: 'cryptocurrency',
              currency: row.currency,
            },
            row.householdId,
            t,
          );
          const update: Record<string, unknown> = {
            securityId: sec.id,
            sourceRowFingerprint: newFingerprint,
          };
          if (newQty != null) update.quantity = String(newQty);
          if (newTradeDate !== row.tradeDate) update.tradeDate = newTradeDate;
          await InvestmentActivity.update(update, {
            where: { id: row.id },
            transaction: t,
          });
        }
        updated += 1;
      }

      if (flags.dryRun) throw new DryRunRollback();
    })
    .catch((e) => {
      if (e instanceof DryRunRollback) return;
      throw e;
    });

  console.log('[crypto-backfill] === summary ===');
  console.log(`  processed:    ${processed}`);
  console.log(`  updated:      ${updated}${flags.dryRun ? ' (DRY RUN — not written)' : ''}`);
  console.log(`  no-match:     ${noMatch}`);
  console.log(`  date-shifted: ${dateShifted} (tradeDate differed from exec-at)`);
  console.log('  by-symbol:');
  for (const [sym, n] of Object.entries(bySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${sym.padEnd(8)} ${n}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[crypto-backfill] fatal:', err);
  process.exit(1);
});

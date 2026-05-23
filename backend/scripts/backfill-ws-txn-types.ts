#!/usr/bin/env tsx
/**
 * Backfill `txnType` on Transactions that were imported from a Wealthsimple
 * monthly statement bundle BEFORE PR #59 wired up the `overrideTxnType`
 * pipeline. Those rows were stamped `txnType='purchase'` for every negative
 * amount, which inflated the dashboard `totalSpend` metric ~10x because
 * BUY/AFT_OUT/CONT/P2P_SENT/FEE rows all leaked into it.
 *
 * Selection criteria:
 *   - importBatch begins with "Wealthsimple ", OR
 *   - the account's shortCode looks like a WS WSID:
 *     - monthly:     ^(WK|HQ|C[0-9])[A-Z0-9]+CAD$
 *     - credit card: ^oaa[A-Za-z0-9]+$
 *
 * For each matching Transaction, infer the correct txnType from `merchantRaw`
 * using the same narrative rules the import pipeline now applies, then UPDATE
 * the row.  No other field is touched.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-ws-txn-types.ts            # apply
 *   cd backend && npx tsx scripts/backfill-ws-txn-types.ts --dry-run  # report only
 *
 * Flags:
 *   --dry-run        Report counts per old→new migration. Write nothing.
 *   --household-id N Restrict to one household (default: all).
 *   --verbose        Print every row's old→new transition.
 */
import { Op } from 'sequelize';
import { Account, Transaction, sequelize } from '../src/models';
import { inferWsTxnTypeFromNarrative } from '../src/import/wealthsimpleTxnType';

type Flags = {
  dryRun: boolean;
  verbose: boolean;
  householdId: number | null;
};

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    householdId: intFlag('--household-id'),
  };
}

const WS_SHORTCODE_RE = /^(?:(?:WK|HQ|C\d)[A-Z0-9]+CAD|oaa[A-Za-z0-9]+)$/;

async function loadWsAccountIds(householdId: number | null): Promise<number[]> {
  const where: Record<string, unknown> = {};
  if (householdId != null) where.householdId = householdId;
  const accounts = (await Account.findAll({
    where,
    attributes: ['id', 'shortCode'],
    raw: true,
  })) as unknown as Array<{ id: number; shortCode: string | null }>;
  return accounts
    .filter((a) => a.shortCode && WS_SHORTCODE_RE.test(a.shortCode))
    .map((a) => a.id);
}

type Counters = Record<string, number>;
type Migration = { from: string; to: string };

function migrationKey(m: Migration): string {
  return `${m.from || '(null)'} -> ${m.to}`;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[ws-backfill] starting with flags:', flags);

  const wsAccountIds = await loadWsAccountIds(flags.householdId);
  console.log(`[ws-backfill] matched ${wsAccountIds.length} WS account(s) by shortCode`);

  // OR clause: importBatch starts with "Wealthsimple " (some early
  // imports used an explicit label), OR accountId is in the matched WS
  // account set. The bundle importer's default batch label is actually
  // `<YYYY-MM> <shortCode>` (see parseStatementFile.ts) so the second
  // clause does most of the work; the first is belt-and-suspenders for
  // any historic upload that did pass a label.
  const baseWhere: Record<string, unknown> = {
    [Op.or]: [
      { importBatch: { [Op.like]: 'Wealthsimple %' } },
      ...(wsAccountIds.length > 0 ? [{ accountId: { [Op.in]: wsAccountIds } }] : []),
    ],
  };
  if (flags.householdId != null) baseWhere.householdId = flags.householdId;

  const counters: Counters = {};
  const migrations: Counters = {};
  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  let noMatch = 0;

  // Stream in batches so we don't load every WS transaction into memory.
  const BATCH_SIZE = 500;
  let offset = 0;

  // Outer transaction so the whole backfill is atomic — if anything goes
  // wrong partway through, no rows are touched. `--dry-run` rolls back at
  // the end regardless.
  await sequelize.transaction(async (t) => {
    for (;;) {
      const rows = (await Transaction.findAll({
        where: baseWhere,
        attributes: ['id', 'merchantRaw', 'txnType', 'amount', 'date'],
        order: [['id', 'ASC']],
        limit: BATCH_SIZE,
        offset,
        transaction: t,
        raw: true,
      })) as unknown as Array<{
        id: number;
        merchantRaw: string;
        txnType: string | null;
        amount: string;
        date: string;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        processed += 1;
        counters[row.txnType ?? '(null)'] = (counters[row.txnType ?? '(null)'] ?? 0) + 1;

        const inferred = inferWsTxnTypeFromNarrative(row.merchantRaw);
        if (!inferred) {
          noMatch += 1;
          continue;
        }
        if (inferred === row.txnType) {
          unchanged += 1;
          continue;
        }

        const mig: Migration = { from: row.txnType ?? '(null)', to: inferred };
        migrations[migrationKey(mig)] = (migrations[migrationKey(mig)] ?? 0) + 1;

        if (flags.verbose) {
          console.log(
            `[ws-backfill] txn ${row.id} (${row.date} "${row.merchantRaw.slice(0, 80)}"): ${mig.from} -> ${mig.to}`,
          );
        }

        if (!flags.dryRun) {
          await Transaction.update(
            { txnType: inferred },
            { where: { id: row.id }, transaction: t },
          );
        }
        updated += 1;
      }

      offset += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    if (flags.dryRun) {
      // Force rollback so we don't accidentally persist anything (we
      // didn't UPDATE inside the loop, but rollback is the safe default).
      throw new DryRunRollback();
    }
  }).catch((e) => {
    if (e instanceof DryRunRollback) return;
    throw e;
  });

  console.log('[ws-backfill] === summary ===');
  console.log(`  processed:  ${processed}`);
  console.log(`  updated:    ${updated}${flags.dryRun ? ' (DRY RUN — not written)' : ''}`);
  console.log(`  unchanged:  ${unchanged}  (already had correct type)`);
  console.log(`  no-match:   ${noMatch}    (no narrative cue)`);
  console.log('[ws-backfill] before-state txnType counts:');
  for (const [k, v] of Object.entries(counters).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`);
  }
  console.log('[ws-backfill] migrations (old -> new):');
  for (const [k, v] of Object.entries(migrations).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(30)} ${v}`);
  }

  await sequelize.close();
}

/** Sentinel used to force a Sequelize transaction rollback on --dry-run. */
class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

main().catch((e) => {
  console.error('[ws-backfill] failed:', e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * One-off backfill: re-tag historical recurring employer direct deposits as
 * `txnType='income'`.
 *
 * Why: the live importer heuristic (`runDetectTypeStage` → `detectsIncome`)
 * was taught (2026-06-01) to tag external direct deposits as income, but it
 * keys on the narration "direct deposit from <X>" / payroll words. Employer
 * deposits imported BEFORE that — and from banks that label them differently
 * (e.g. RBC "Misc Payment CDG LABS INC", "Online transfer received - NNNN CDG
 * LABS INC") — were left as `unknown`/`transfer`, skewing the dashboard's
 * Income vs Payments buckets even though it is the same recurring income.
 *
 * Approach (payer-anchored — see incomePayerBackfill.ts): the heuristic is the
 * source of truth for WHO is an income payer.
 *   Pass 1: derive the set of external income payers from rows the heuristic
 *           already tags income via "direct deposit from <X>".
 *   Pass 2: re-tag positive-amount `unknown`/`transfer` rows that either the
 *           heuristic itself calls income, or whose narration names one of
 *           those same payers. Own-name self-deposits are excluded for free
 *           (they never enter the payer set).
 * Only `txn_type` is written. No narration is hand-matched.
 *
 * Usage (PROD Postgres — NEVER local sqlite):
 *   PUB=$(railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL)
 *   cd backend
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-income-payer-anchored.ts            # dry-run (default)
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-income-payer-anchored.ts --commit   # apply
 *
 * Do NOT use `railway run` — it injects the internal-only DATABASE_URL
 * (*.railway.internal) which is unreachable from a laptop.
 *
 * Flags:
 *   --commit          Actually write. Default is dry-run (report only).
 *   --household-id N   Restrict to one household (default: 1).
 *   --verbose          (changes are always listed; reserved for extra detail)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Op } from 'sequelize';
import { Transaction, sequelize } from '../src/models';
import { loadHouseholdOwnerNames } from '../src/import/enrichment/loaders';
import { databaseUrl } from '../src/config/env';
import {
  decideRetag,
  deriveIncomePayers,
  normalizeText,
  type CandidateRow,
} from './incomePayerBackfill';

type Flags = {
  commit: boolean;
  householdId: number;
  verbose: boolean;
};

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string, fallback: number): number {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return fallback;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : fallback;
  }
  return {
    commit: argv.includes('--commit'),
    householdId: intFlag('--household-id', 1),
    verbose: argv.includes('--verbose'),
  };
}

type RawRow = {
  id: number;
  date: string;
  accountId: number;
  merchantRaw: string;
  merchantClean: string | null;
  txnType: string | null;
  amount: string;
};

type Change = {
  id: number;
  date: string;
  accountId: number;
  amount: number;
  merchantRaw: string;
  from: string;
  reason: 'heuristic' | 'payer-anchored';
};

/** Sentinel used to force a Sequelize transaction rollback on dry-run. */
class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const mode = flags.commit ? 'COMMIT (writing)' : 'DRY RUN (report only)';

  // --- Safety: never let a write hit local sqlite. ---
  if (databaseUrl) {
    console.log(`Target DB: postgres (${new URL(databaseUrl).host})`);
  } else {
    console.log('Target DB: LOCAL SQLITE (no DATABASE_URL set)');
    if (flags.commit) {
      console.error(
        'Refusing to --commit against local sqlite. Set DATABASE_URL to the prod Postgres URL ' +
          '(DATABASE_PUBLIC_URL from `railway variables --service Postgres`).',
      );
      process.exit(1);
    }
  }
  console.log(`mode: ${mode} | household: ${flags.householdId}`);

  const ownerNames = await loadHouseholdOwnerNames(flags.householdId);
  console.log(`owner names (own-name exclusion): ${JSON.stringify(ownerNames)}`);
  if (ownerNames.length === 0) {
    console.warn(
      'WARNING: no household member names resolved — the own-name self-deposit exclusion ' +
        'cannot fire, so a self-deposit could be mis-tagged as income.',
    );
    if (flags.commit) {
      console.error('Refusing to --commit with an empty owner-name set. Verify --household-id.');
      process.exit(1);
    }
  }

  // --- Pass 1: derive the income-payer set from "direct deposit from <X>" rows. ---
  const anchorRows = (await Transaction.findAll({
    where: {
      householdId: flags.householdId,
      amount: { [Op.gt]: 0 },
      merchantRaw: { [Op.iLike]: '%direct deposit from%' },
    },
    attributes: ['merchantRaw', 'merchantClean', 'amount'],
    raw: true,
  })) as unknown as Array<{ merchantRaw: string; merchantClean: string | null; amount: string }>;

  const payers = deriveIncomePayers(
    anchorRows.map((r) => ({
      merchantRaw: r.merchantRaw,
      merchantClean: r.merchantClean ?? '',
      amount: Number(r.amount),
    })),
    ownerNames,
  );
  console.log(
    `\nderived ${payers.size} income payer(s) from ${anchorRows.length} "direct deposit from" row(s):`,
  );
  for (const p of [...payers].sort()) console.log(`    • ${p}`);

  // --- Pass 2: scan eligible candidates and decide. ---
  const changes: Change[] = [];
  const beforeCounts: Record<string, number> = {};
  const byAccount: Record<number, { n: number; total: number }> = {};
  let scanned = 0;

  const BATCH_SIZE = 500;
  let offset = 0;

  await sequelize
    .transaction(async (t) => {
      for (;;) {
        const rows = (await Transaction.findAll({
          where: {
            householdId: flags.householdId,
            amount: { [Op.gt]: 0 },
            txnType: { [Op.in]: ['unknown', 'transfer'] },
          },
          attributes: ['id', 'date', 'accountId', 'merchantRaw', 'merchantClean', 'txnType', 'amount'],
          order: [['id', 'ASC']],
          limit: BATCH_SIZE,
          offset,
          transaction: t,
          raw: true,
        })) as unknown as RawRow[];
        if (rows.length === 0) break;

        for (const row of rows) {
          scanned += 1;
          const txnType = row.txnType ?? 'unknown';
          beforeCounts[txnType] = (beforeCounts[txnType] ?? 0) + 1;

          const candidate: CandidateRow = {
            merchantRaw: row.merchantRaw,
            merchantClean: row.merchantClean ?? '',
            amount: Number(row.amount),
            txnType,
          };
          if (!decideRetag(candidate, payers, ownerNames)) continue;

          const narr = normalizeText(`${candidate.merchantRaw} ${candidate.merchantClean}`);
          const reason: Change['reason'] = [...payers].some((p) => narr.includes(p))
            ? 'payer-anchored'
            : 'heuristic';

          changes.push({
            id: row.id,
            date: row.date,
            accountId: row.accountId,
            amount: candidate.amount,
            merchantRaw: row.merchantRaw,
            from: txnType,
            reason,
          });
          byAccount[row.accountId] ??= { n: 0, total: 0 };
          byAccount[row.accountId].n += 1;
          byAccount[row.accountId].total += candidate.amount;

          if (flags.commit) {
            await Transaction.update(
              { txnType: 'income' },
              { where: { id: row.id }, transaction: t },
            );
          }
        }

        offset += rows.length;
        if (rows.length < BATCH_SIZE) break;
      }

      if (!flags.commit) throw new DryRunRollback();
    })
    .catch((e) => {
      if (e instanceof DryRunRollback) return;
      throw e;
    });

  // --- Report. ---
  const fromCounts: Record<string, number> = {};
  let totalMoved = 0;
  for (const c of changes) {
    fromCounts[c.from] = (fromCounts[c.from] ?? 0) + 1;
    totalMoved += c.amount;
  }

  console.log(`\n=== changes (${changes.length} row(s) -> income) ===`);
  console.log(
    [
      'id'.padStart(7),
      'date'.padEnd(10),
      'acct'.padStart(4),
      'amount'.padStart(12),
      'from'.padEnd(8),
      'reason'.padEnd(14),
      'merchant_raw',
    ].join('  '),
  );
  for (const c of changes.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(
      [
        String(c.id).padStart(7),
        c.date.padEnd(10),
        String(c.accountId).padStart(4),
        c.amount.toFixed(2).padStart(12),
        c.from.padEnd(8),
        c.reason.padEnd(14),
        c.merchantRaw.slice(0, 48),
      ].join('  '),
    );
  }

  console.log('\n=== summary ===');
  console.log(`  scanned (positive unknown/transfer): ${scanned}`);
  console.log(`  would re-tag -> income:              ${changes.length}${flags.commit ? ' (WRITTEN)' : ' (DRY RUN — not written)'}`);
  console.log(`  total amount moved into income:      ${totalMoved.toFixed(2)}`);
  console.log('  by previous txn_type:');
  for (const [k, v] of Object.entries(fromCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(10)} ${v}`);
  }
  console.log('  by account (count / total $):');
  for (const [acct, v] of Object.entries(byAccount).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`      acct ${acct.padEnd(5)} ${String(v.n).padStart(4)}  ${v.total.toFixed(2)}`);
  }

  // --- Audit file (rollback list). ---
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const auditPath = path.join(process.cwd(), `income-backfill-report-${stamp}.json`);
  fs.writeFileSync(
    auditPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode,
        householdId: flags.householdId,
        ownerNames,
        derivedPayers: [...payers].sort(),
        scanned,
        totalMoved,
        changes,
      },
      null,
      2,
    ),
  );
  console.log(`\naudit report written: ${auditPath}`);
  console.log(
    flags.commit
      ? '\nDONE — changes committed. The audit report lists every changed id for rollback.'
      : '\nDRY RUN complete — nothing written. Review the diff above, then re-run with --commit.',
  );

  await sequelize.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[income-backfill] failed:', e);
    process.exit(1);
  });
}

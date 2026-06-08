#!/usr/bin/env tsx
/**
 * Backfill stale txnType on low-confidence fallback rows.
 *
 * Re-runs the CURRENT runDetectTypeStage classifier over every transaction whose
 * txnType is a low-confidence fallback ('unknown' or 'purchase') and re-types
 * the ones that now resolve to a specific type (income / transfer / payment /
 * refund / etc.). This fixes:
 *   - positive 'unknown' inflows (EI CANADA -> income, WS Deposit/Cash
 *     correction -> transfer) that pre-harden deflated net spend via the
 *     credit bucket, and
 *   - negative 'purchase' rows whose narrative now matches a money-movement
 *     pattern added after they were imported (e.g. "ONLINE BANKING TRANSFER"),
 *     which were inflating totalSpend.
 *
 * Rows that still resolve to 'unknown'/'purchase' are left untouched. Rows
 * already typed something specific are NOT considered (we never clobber a
 * higher-confidence type).
 *
 * DRY-RUN by default — prints the proposed changes and writes nothing.
 * Pass --apply to write. Prod Postgres via:
 *   railway run --service Postgres -- sh -c \
 *     'cd backend && DATABASE_URL="$DATABASE_PUBLIC_URL" ../node_modules/.bin/tsx \
 *      scripts/backfill-unknown-inflow-txntypes.ts [--household=1|--all] [--only-unknown] [--apply]'
 */
import { Op } from 'sequelize';
import { Transaction, sequelize } from '../src/models';
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';
import { loadHouseholdOwnerNames } from '../src/import/enrichment/loaders';
import { num } from '../src/util/numbers';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const ONLY_UNKNOWN = process.argv.includes('--only-unknown');
const hhArg = process.argv.find((a) => a.startsWith('--household='));
const HOUSEHOLD = hhArg ? Number(hhArg.split('=')[1]) : 1;

const FALLBACK_TYPES = ONLY_UNKNOWN ? ['unknown'] : ['unknown', 'purchase'];
const FALLBACK_SET = new Set(FALLBACK_TYPES);

type Row = {
  id: number;
  householdId: number | null;
  date: string;
  currency: string;
  amount: unknown;
  txnType: string | null;
  merchantRaw: string | null;
  merchantClean: string | null;
};

function fmt(n: number): string {
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const where: Record<string, unknown> = { txnType: { [Op.in]: FALLBACK_TYPES } };
  if (!ALL) where.householdId = HOUSEHOLD;

  const rows = (await Transaction.findAll({
    where,
    attributes: ['id', 'householdId', 'date', 'currency', 'amount', 'txnType', 'merchantRaw', 'merchantClean'],
    raw: true,
  })) as unknown as Row[];

  console.log(`Scanned ${rows.length} fallback rows (txnType in [${FALLBACK_TYPES.join(', ')}]${ALL ? ', all households' : `, household ${HOUSEHOLD}`}).`);

  const ownerCache = new Map<number | null, string[]>();
  async function owners(hh: number | null): Promise<string[]> {
    if (!ownerCache.has(hh)) ownerCache.set(hh, await loadHouseholdOwnerNames(hh));
    return ownerCache.get(hh)!;
  }

  type Change = { id: number; old: string | null; next: string; amount: number; date: string; merchant: string };
  const changes: Change[] = [];
  for (const r of rows) {
    const amount = num(r.amount);
    if (amount == null) continue;
    const ownerNames = await owners(r.householdId);
    const sig = runDetectTypeStage({
      merchantRaw: r.merchantRaw ?? '',
      merchantClean: r.merchantClean ?? '',
      amount,
      ownerNames,
    });
    const next = sig[0]?.fields.txnType;
    if (next && next !== r.txnType && !FALLBACK_SET.has(next)) {
      changes.push({
        id: r.id,
        old: r.txnType,
        next,
        amount,
        date: r.date,
        merchant: (r.merchantRaw ?? '').slice(0, 48),
      });
    }
  }

  // Group by old -> new transition.
  const byTransition = new Map<string, Change[]>();
  for (const c of changes) {
    const key = `${c.old} -> ${c.next}`;
    (byTransition.get(key) ?? byTransition.set(key, []).get(key)!).push(c);
  }

  console.log(`\n=== Proposed retypes: ${changes.length} rows ===`);
  for (const [key, list] of [...byTransition.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sum = list.reduce((s, c) => s + Math.abs(c.amount), 0);
    console.log(`\n  ${key}  (${list.length} rows, |Σ|=${fmt(sum)})`);
    for (const c of list.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 10)) {
      console.log(`    #${c.id} ${c.date} ${fmt(c.amount).padStart(12)} :: ${c.merchant}`);
    }
    if (list.length > 10) console.log(`    … +${list.length - 10} more`);
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — wrote nothing. Re-run with --apply to write these ${changes.length} retypes.`);
    await sequelize.close();
    return;
  }

  // Apply, grouped by target type, inside one transaction.
  const byTarget = new Map<string, number[]>();
  for (const c of changes) (byTarget.get(c.next) ?? byTarget.set(c.next, []).get(c.next)!).push(c.id);
  await sequelize.transaction(async (t) => {
    for (const [nextType, ids] of byTarget) {
      await Transaction.update({ txnType: nextType }, { where: { id: { [Op.in]: ids } }, transaction: t });
    }
  });
  console.log(`\nAPPLIED — updated txnType on ${changes.length} rows.`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

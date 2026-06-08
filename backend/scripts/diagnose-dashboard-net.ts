#!/usr/bin/env tsx
/**
 * READ-ONLY diagnostic: reconcile the Dashboard "Net" (net spend) figure.
 *
 * Replays the EXACT production aggregator (aggregateDashboard) against prod
 * Postgres for the default dashboard window (last 30 days) and all-time, per
 * currency, per household — then dumps every row that feeds totalCredits /
 * totalPayments (the buckets that move Net = totalSpend - totalCredits) so a
 * misclassified row is obvious.
 *
 * Writes NOTHING. Prod Postgres only (per project convention):
 *   railway run --service backend -- sh -c 'cd backend && npx tsx scripts/diagnose-dashboard-net.ts'
 */
import { Op } from 'sequelize';
import { Account, Transaction, sequelize } from '../src/models';
import {
  aggregateDashboard,
  type AccountRow,
  type SummaryTxnRow,
} from '../src/summary/aggregateDashboard';
import {
  classifyPositiveAmount,
  isNonSpend,
} from '../src/summary/classifyTransactionFlow';
import { num } from '../src/util/numbers';

const ATTRS = [
  'id', 'accountId', 'date', 'currency', 'finalCategory', 'finalBusiness',
  'finalSplitType', 'merchantRaw', 'merchantClean', 'merchantCanonical',
  'amount', 'businessAmount', 'reviewFlag', 'txnType', 'linkedTransactionId',
  'householdId',
] as const;

function fmt(n: number): string {
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function last30(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function main() {
  const CURRENCY = (process.argv[2] || 'CAD').toUpperCase();

  // 1. Household landscape.
  const hh = (await Transaction.findAll({
    attributes: ['householdId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    group: ['householdId'],
    raw: true,
  })) as unknown as Array<{ householdId: number | null; n: string }>;
  console.log('=== Households (txn counts) ===');
  hh.sort((a, b) => Number(b.n) - Number(a.n)).forEach((h) => console.log(`  household ${h.householdId}: ${h.n} txns`));
  const mainHousehold = hh.length ? hh.sort((a, b) => Number(b.n) - Number(a.n))[0].householdId : null;
  console.log(`  -> main household = ${mainHousehold}`);

  const accounts = (await Account.findAll({
    where: mainHousehold == null ? {} : { householdId: mainHousehold },
    attributes: ['id', 'name', 'shortCode', 'accountType'],
    raw: true,
  })) as unknown as AccountRow[];
  const accountById = new Map<number, AccountRow>(accounts.map((a) => [a.id, a]));

  const windows: Array<{ label: string; where: Record<string, unknown> }> = [];
  const w30 = last30();
  const base: Record<string, unknown> = { currency: CURRENCY };
  if (mainHousehold != null) base.householdId = mainHousehold;
  windows.push({ label: `last30 (${w30.from}..${w30.to})`, where: { ...base, date: { [Op.gte]: w30.from, [Op.lte]: w30.to } } });
  windows.push({ label: 'all-time', where: { ...base } });

  for (const win of windows) {
    const rows = (await Transaction.findAll({
      where: win.where,
      attributes: ATTRS as unknown as string[],
      raw: true,
    })) as unknown as Array<SummaryTxnRow & { householdId: number | null }>;

    const agg = aggregateDashboard(rows as unknown as SummaryTxnRow[], accountById, undefined);
    const m = agg.metricsByCurrency.get(CURRENCY);
    console.log(`\n=== ${CURRENCY} | ${win.label} ===`);
    if (!m) { console.log('  (no rows)'); continue; }
    console.log(`  totalSpend   = ${fmt(m.totalSpend)}`);
    console.log(`  totalCredits = ${fmt(m.totalCredits)}   <- subtracted from Net`);
    console.log(`  totalIncome  = ${fmt(m.totalIncome)}   (peeled out, NOT in Net)`);
    console.log(`  totalPayments= ${fmt(m.totalPayments)}  (excluded)`);
    console.log(`  NET SPEND    = ${fmt(m.netSpend)}   = totalSpend - totalCredits  <-- the hero "Net"`);
    console.log(`  refundCredits= ${fmt(m.refundCredits)} (${m.linkedRefundCount} linked refunds)`);
    console.log(`  txnCount     = ${m.transactionCount}`);

    // Re-derive each row's bucket to dump credit / payment / suspicious rows.
    type Tagged = { id: number; date: string; amount: number; merchant: string; txnType: string | null; cat: string | null; linked: number | null; acct: string | null; bucket: string; suspicious: boolean };
    const tagged: Tagged[] = [];
    for (const r of rows) {
      const amount = num(r.amount);
      if (amount == null) continue;
      const acct = accountById.get(r.accountId);
      const nonSpend = isNonSpend(r.txnType, acct?.accountType);
      let bucket: string;
      if (amount < 0 && !nonSpend) bucket = 'spend';
      else if (amount < 0) bucket = 'skip(neg-nonspend)';
      else {
        const pb = classifyPositiveAmount({ txnType: r.txnType, accountType: acct?.accountType, merchantRaw: r.merchantRaw, merchantClean: r.merchantClean, category: r.finalCategory });
        if (pb === 'payment') bucket = 'payment';
        else if (pb === 'credit' && r.txnType === 'income') bucket = 'income';
        else if (pb === 'credit') bucket = 'credit';
        else bucket = 'skip';
      }
      const merchant = r.merchantCanonical?.trim() || r.merchantClean?.trim() || r.merchantRaw?.trim() || '(unknown)';
      // Suspicious: positive row counted as 'credit' (deflates Net) with NO
      // explicit money-back txnType — i.e. routed via merchant-text fallback.
      const suspicious = bucket === 'credit' && (r.txnType == null || r.txnType === '' || (r.txnType !== 'refund' && r.txnType !== 'reward'));
      tagged.push({ id: r.id, date: r.date, amount, merchant, txnType: r.txnType ?? null, cat: r.finalCategory ?? null, linked: r.linkedTransactionId ?? null, acct: acct?.shortCode ?? acct?.name ?? null, bucket, suspicious });
    }

    const credits = tagged.filter((t) => t.bucket === 'credit').sort((a, b) => b.amount - a.amount);
    console.log(`\n  -- top credit rows (subtract from Net), ${credits.length} total --`);
    credits.slice(0, 20).forEach((t) => console.log(`    ${t.suspicious ? '⚠ ' : '  '}#${t.id} ${t.date} ${fmt(t.amount).padStart(12)} ${t.acct ?? '?'} [type=${t.txnType ?? 'null'}] link=${t.linked ?? '-'} cat=${t.cat ?? '-'} :: ${t.merchant}`));
    const suspCredits = credits.filter((t) => t.suspicious);
    console.log(`  -- ⚠ suspicious credits (positive, no refund/reward type, fell to credit via merchant fallback): ${suspCredits.length} rows, sum=${fmt(suspCredits.reduce((s, t) => s + t.amount, 0))} --`);

    const payments = tagged.filter((t) => t.bucket === 'payment').sort((a, b) => b.amount - a.amount);
    console.log(`  -- top payment rows (excluded entirely), ${payments.length} total, sum=${fmt(payments.reduce((s, t) => s + t.amount, 0))} --`);
    payments.slice(0, 8).forEach((t) => console.log(`      #${t.id} ${t.date} ${fmt(t.amount).padStart(12)} ${t.acct ?? '?'} [type=${t.txnType ?? 'null'}] :: ${t.merchant}`));

    const income = tagged.filter((t) => t.bucket === 'income');
    console.log(`  -- income rows (peeled to totalIncome), ${income.length} total, sum=${fmt(income.reduce((s, t) => s + t.amount, 0))} --`);
  }

  await sequelize.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

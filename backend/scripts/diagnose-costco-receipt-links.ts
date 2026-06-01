#!/usr/bin/env tsx
/**
 * Read-only diagnostic: why aren't Costco receipts linking to transactions?
 *
 * For every Costco ExternalOrder it prints the order, its tenders, any existing
 * TransactionOrderLink rows, and then replays the REAL matcher logic
 * (txnMatchesVendor + scoreReceiptMatch from import/matchReceiptToTransactions)
 * against candidate transactions — so the verdict matches production exactly.
 *
 * It also widens the scan to ±45 days and prints each candidate's created_at vs
 * the order's created_at, which settles the ordering hypothesis: if the matching
 * transaction was imported AFTER the receipt, the matcher (which only runs at
 * receipt-import time) never saw it and no re-match ever fired.
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/diagnose-costco-receipt-links.ts
 *
 * Writes nothing. Prod Postgres only (per project convention).
 */
import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderTender,
  Transaction,
  TransactionOrderLink,
  sequelize,
} from '../src/models';
import {
  txnMatchesVendor,
  scoreReceiptMatch,
  type CandidatePayment,
} from '../src/import/matchReceiptToTransactions';

const DATE_WINDOW_DAYS = 7;
const THRESHOLD = 70;

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmt(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 19).replace('T', ' ') : '—';
}

async function main() {
  const orders = await ExternalOrder.findAll({
    where: { [Op.or]: [{ vendor: { [Op.iLike]: '%costco%' } }] },
    order: [['id', 'ASC']],
  });

  console.log(`Found ${orders.length} Costco external order(s).\n`);
  if (orders.length === 0) {
    console.log('No order has vendor LIKE costco — the receipt may have parsed');
    console.log('under a different vendor string, which fails the vendor gate.');
    await sequelize.close();
    return;
  }

  for (const order of orders) {
    console.log('═'.repeat(72));
    console.log(
      `ExternalOrder id=${order.id} vendor="${order.vendor}" orderDate=${order.orderDate ?? 'NULL'} ` +
        `total=${order.total ?? 'NULL'} last4=${order.paymentLast4 ?? '—'} ` +
        `household=${(order as unknown as { householdId: number }).householdId} created=${fmt(order.createdAt)}`,
    );

    if (order.orderDate == null) {
      console.log('  ✗ orderDate is NULL → matcher bails immediately at line 141. No link possible.');
      continue;
    }

    const tenders = await ExternalOrderTender.findAll({
      where: { externalOrderId: order.id },
      order: [['sequence', 'ASC']],
    });
    const payments: CandidatePayment[] =
      tenders.length > 0
        ? tenders.map((t) => ({ paymentLast4: t.paymentLast4, amount: Number(t.amount), tenderId: t.id }))
        : order.total != null
          ? [{ paymentLast4: order.paymentLast4, amount: Number(order.total), tenderId: null }]
          : [];
    console.log(
      `  tenders: ${tenders.length === 0 ? `none → synthesized [total=${order.total}, last4=${order.paymentLast4 ?? '—'}]` : tenders.map((t) => `${t.amount}/${t.paymentLast4 ?? '—'}`).join(', ')}`,
    );
    if (payments.length === 0) {
      console.log('  ✗ no payment amount (no tenders and total NULL) → matcher returns 0.');
      continue;
    }

    const links = await TransactionOrderLink.findAll({ where: { externalOrderId: order.id } });
    console.log(
      `  existing links: ${links.length === 0 ? 'NONE' : links.map((l) => `txn=${l.transactionId} conf=${l.confidence} status=${l.status}`).join(', ')}`,
    );

    const householdId = (order as unknown as { householdId: number }).householdId;

    // Exact matcher window.
    const from = shiftDate(order.orderDate, -DATE_WINDOW_DAYS);
    const to = shiftDate(order.orderDate, DATE_WINDOW_DAYS);
    const inWindow = await Transaction.findAll({
      where: { householdId, date: { [Op.between]: [from, to] } },
      order: [['date', 'ASC']],
    });
    const costcoInWindow = inWindow.filter((t) => txnMatchesVendor('costco', t));
    console.log(`  in-window ±7d [${from}..${to}]: ${inWindow.length} txns, ${costcoInWindow.length} match costco merchant`);

    for (const payment of payments) {
      console.log(`  ── scoring payment amount=${payment.amount} last4=${payment.paymentLast4 ?? '—'}`);
      if (costcoInWindow.length === 0) {
        console.log('     (no costco-merchant txn in window — nothing to score)');
      }
      for (const txn of costcoInWindow) {
        const s = scoreReceiptMatch(txn, order, payment);
        const verdict = s.confidence >= THRESHOLD ? '✓ LINKS' : '✗ below 70';
        console.log(
          `     txn=${txn.id} ${txn.date} amt=${txn.amount} "${txn.merchantRaw}" → conf=${s.confidence} ${verdict} | ${s.matchReason}`,
        );
      }
    }

    // Wider scan to expose ordering / out-of-window cases.
    const wideFrom = shiftDate(order.orderDate, -45);
    const wideTo = shiftDate(order.orderDate, 45);
    const wide = await Transaction.findAll({
      where: {
        householdId,
        date: { [Op.between]: [wideFrom, wideTo] },
        [Op.or]: [{ merchantRaw: { [Op.iLike]: '%costco%' } }, { merchantClean: { [Op.iLike]: '%costco%' } }],
      },
      order: [['date', 'ASC']],
    });
    console.log(`  costco txns within ±45d: ${wide.length}`);
    for (const t of wide) {
      const gap = Math.round(
        (new Date(`${t.date}T00:00:00Z`).getTime() - new Date(`${order.orderDate}T00:00:00Z`).getTime()) / 86400000,
      );
      const inWin = gap >= -DATE_WINDOW_DAYS && gap <= DATE_WINDOW_DAYS;
      const importedAfter = t.createdAt && order.createdAt && t.createdAt > order.createdAt;
      console.log(
        `     txn=${t.id} ${t.date} amt=${t.amount} "${t.merchantRaw}" gap=${gap}d ` +
          `${inWin ? 'IN-window' : 'OUT-window'} created=${fmt(t.createdAt)} ${importedAfter ? '⚠ imported AFTER receipt' : ''}`,
      );
    }
    console.log('');
  }

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

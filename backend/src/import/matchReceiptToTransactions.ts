/**
 * Vendor-generic, tender-aware matching of an ExternalOrder (receipt) to
 * card transactions. Creates TransactionOrderLink rows with `linkedAmount`
 * populated per tender, so a single split-tender receipt links to N
 * transactions across N cards.
 *
 * Parallels backend/src/amazon/matcher.ts but:
 *   - works for any vendor (Amazon, Costco, ...)
 *   - scores per-tender amount when ExternalOrderTender rows exist
 *   - falls back to order.total + order.paymentLast4 when no tenders
 */
import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderTender,
  Transaction,
  TransactionOrderLink,
} from '../models';

const MATCH_CONFIDENCE_THRESHOLD = 70;
const DATE_WINDOW_DAYS = 7;

type CandidatePayment = {
  paymentLast4: string | null;
  amount: number;
  /** null when the synthesized single payment is used (no tenders rows). */
  tenderId: number | null;
};

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(a: string, b: string): number {
  const one = new Date(`${a}T00:00:00Z`).getTime();
  const two = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((one - two) / 86400000);
}

function last4FromText(text: string | null | undefined): string | null {
  return String(text || '').match(/\b(\d{4})\b/)?.[1] ?? null;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const VENDOR_MERCHANT_PATTERNS: Record<string, RegExp> = {
  amazon: /\b(amazon(?:\.(?:com|ca|co\.uk))?|amzn|prime\s*video)\b/i,
  apple: /\b(apple(?:\.com)?|itunes|app\s*store|apple\s*music|apple\s*tv|icloud)\b/i,
  google: /\b(google(?:\s*play)?|googlepay|youtube\s*premium)\b/i,
  costco: /\bcostco\b/i,
};

export function txnMatchesVendor(vendor: string, txn: Transaction): boolean {
  const pat = VENDOR_MERCHANT_PATTERNS[vendor];
  if (!pat) return false;
  return pat.test(`${txn.merchantRaw} ${txn.merchantClean}`);
}

export type ReceiptMatchScore = {
  confidence: number;
  matchReason: string;
};

export function scoreReceiptMatch(
  txn: Transaction,
  order: ExternalOrder,
  payment: CandidatePayment,
): ReceiptMatchScore {
  let score = 0;
  const reasons: string[] = [];

  const txnAmount = Math.abs(Number(txn.amount));
  const payAmount = Math.abs(payment.amount);
  const diff = Math.abs(txnAmount - payAmount);
  if (diff <= 0.5) {
    score += 50;
    reasons.push(`amount within $0.50 (${diff.toFixed(2)})`);
  } else if (diff <= 2) {
    score += 35;
    reasons.push(`amount within $2.00 (${diff.toFixed(2)})`);
  } else {
    score -= 25;
    reasons.push(`amount mismatch over $2.00 (${diff.toFixed(2)})`);
  }

  if (order.orderDate) {
    const gap = daysBetween(txn.date, order.orderDate);
    if (gap >= 0 && gap <= 5) {
      score += 25;
      reasons.push(`txn ${gap} day(s) after receipt`);
    } else if (Math.abs(gap) <= 2) {
      // negative gap (txn before receipt date) — POS lag can put txn date
      // a day earlier than the printed receipt date in some banks
      score += 15;
      reasons.push(`txn ${gap} day(s) from receipt`);
    } else if (Math.abs(gap) > 10) {
      score -= 15;
      reasons.push(`date gap over 10 days (${Math.abs(gap)} days)`);
    }
  }

  if (txnMatchesVendor(order.vendor, txn)) {
    score += 15;
    reasons.push(`merchant matches ${order.vendor}`);
  }

  if (payment.paymentLast4) {
    const txnLast4 = last4FromText(`${txn.notes || ''} ${txn.sourceReference || ''}`);
    if (txnLast4 && txnLast4 === payment.paymentLast4) {
      score += 20;
      reasons.push(`payment last4 matches (${payment.paymentLast4})`);
    }
  }

  return {
    confidence: Math.max(0, Math.min(100, score)),
    matchReason: reasons.join('; ') || `candidate ${order.vendor} order`,
  };
}

/**
 * For the given ExternalOrder, find matching transactions and create
 * TransactionOrderLink rows. Each tender (or the single order.total if no
 * tenders rows exist) gets at most one link.
 *
 * Returns counts useful for the upload-response payload.
 */
export async function matchReceiptOrderToTransactions(args: {
  externalOrderId: number;
  householdId: number;
}): Promise<{ created: number; updated: number; tendersProcessed: number; candidatesScanned: number }> {
  const order = await ExternalOrder.findByPk(args.externalOrderId);
  if (!order || order.orderDate == null) {
    return { created: 0, updated: 0, tendersProcessed: 0, candidatesScanned: 0 };
  }

  const tenderRows = await ExternalOrderTender.findAll({
    where: { externalOrderId: order.id },
    order: [['sequence', 'ASC']],
  });

  const payments: CandidatePayment[] = tenderRows.length > 0
    ? tenderRows.map((t) => ({
        paymentLast4: t.paymentLast4,
        amount: Number(t.amount),
        tenderId: t.id,
      }))
    : (() => {
        const total = numberOrNull(order.total);
        if (total == null) return [];
        return [{ paymentLast4: order.paymentLast4, amount: total, tenderId: null }];
      })();

  if (payments.length === 0) {
    return { created: 0, updated: 0, tendersProcessed: 0, candidatesScanned: 0 };
  }

  const from = shiftDate(order.orderDate, -DATE_WINDOW_DAYS);
  const to = shiftDate(order.orderDate, DATE_WINDOW_DAYS);
  const candidates = await Transaction.findAll({
    where: {
      householdId: args.householdId,
      date: { [Op.between]: [from, to] },
    },
    order: [['date', 'ASC']],
  });

  let created = 0;
  let updated = 0;
  const claimed = new Set<number>();

  for (const payment of payments) {
    const scored = candidates
      .filter((txn) => !claimed.has(txn.id))
      .filter((txn) => txnMatchesVendor(order.vendor, txn))
      .map((txn) => ({ txn, ...scoreReceiptMatch(txn, order, payment) }))
      .filter((s) => s.confidence >= MATCH_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence);

    if (scored.length === 0) continue;
    const best = scored[0];

    const [link, isNew] = await TransactionOrderLink.findOrCreate({
      where: { transactionId: best.txn.id, externalOrderId: order.id },
      defaults: {
        transactionId: best.txn.id,
        externalOrderId: order.id,
        confidence: String(best.confidence),
        matchReason: best.matchReason,
        status: 'suggested',
        linkedAmount: String(payment.amount),
      },
    });

    if (isNew) {
      created += 1;
    } else if (link.status === 'suggested') {
      await link.update({
        confidence: String(best.confidence),
        matchReason: best.matchReason,
        linkedAmount: String(payment.amount),
      });
      updated += 1;
    }
    claimed.add(best.txn.id);
  }

  return {
    created,
    updated,
    tendersProcessed: payments.length,
    candidatesScanned: candidates.length,
  };
}

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
// Tiny date/number/last4 helpers intentionally mirror amazon/matcher.ts; consolidating into a shared util is out of scope here.
// fallow-ignore-file code-duplication
import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderTender,
  Transaction,
  TransactionOrderLink,
} from '../models';

const MATCH_CONFIDENCE_THRESHOLD = 70;
const DATE_WINDOW_DAYS = 7;
const AUTO_ACCEPT_THRESHOLD = 85; // exact-amount match baseline is 90 (50 amount + 25 date + 15 vendor)
const AUTO_ACCEPT_MARGIN = 10;    // best must lead runner-up by MORE than this to be unambiguous

/**
 * Decide whether the top-scored candidate for a single payment is safe to
 * auto-accept: high enough confidence AND unambiguous (sole qualifier, or a
 * clear margin over the runner-up). `sortedConfidences` is the per-payment
 * candidate confidences, already filtered to >= MATCH_CONFIDENCE_THRESHOLD and
 * sorted descending. Pure — no DB, no model coupling.
 */
export function decideAutoAccept(sortedConfidences: number[]): boolean {
  if (sortedConfidences.length === 0) return false;
  if (sortedConfidences[0] < AUTO_ACCEPT_THRESHOLD) return false;
  if (sortedConfidences.length === 1) return true;
  return sortedConfidences[0] - sortedConfidences[1] > AUTO_ACCEPT_MARGIN;
}

export type CandidatePayment = {
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

type Component = { points: number; reason: string | null };

function scoreAmountComponent(txnAmount: number, payAmount: number): Component {
  const diff = Math.abs(Math.abs(txnAmount) - Math.abs(payAmount));
  if (diff <= 0.5) return { points: 50, reason: `amount within $0.50 (${diff.toFixed(2)})` };
  if (diff <= 2) return { points: 35, reason: `amount within $2.00 (${diff.toFixed(2)})` };
  return { points: -25, reason: `amount mismatch over $2.00 (${diff.toFixed(2)})` };
}

// Piecewise date-gap scoring; covered by scoreReceiptMatch tests.
// fallow-ignore-next-line complexity
function scoreDateComponent(txnDate: string, orderDate: string | null): Component {
  if (!orderDate) return { points: 0, reason: null };
  const gap = daysBetween(txnDate, orderDate);
  if (gap >= 0 && gap <= 5) return { points: 25, reason: `txn ${gap} day(s) after receipt` };
  if (Math.abs(gap) <= 2) return { points: 15, reason: `txn ${gap} day(s) from receipt` };
  if (Math.abs(gap) > 10) return { points: -15, reason: `date gap over 10 days (${Math.abs(gap)} days)` };
  return { points: 0, reason: null };
}

function scoreVendorComponent(order: ExternalOrder, txn: Transaction): Component {
  return txnMatchesVendor(order.vendor, txn)
    ? { points: 15, reason: `merchant matches ${order.vendor}` }
    : { points: 0, reason: null };
}

// Short-circuit chain; covered by scoreReceiptMatch tests.
// fallow-ignore-next-line complexity
function scoreLast4Component(payment: CandidatePayment, txn: Transaction): Component {
  if (!payment.paymentLast4) return { points: 0, reason: null };
  const txnLast4 = last4FromText(`${txn.notes || ''} ${txn.sourceReference || ''}`);
  return txnLast4 && txnLast4 === payment.paymentLast4
    ? { points: 20, reason: `payment last4 matches (${payment.paymentLast4})` }
    : { points: 0, reason: null };
}

export function scoreReceiptMatch(
  txn: Transaction,
  order: ExternalOrder,
  payment: CandidatePayment,
): ReceiptMatchScore {
  const components = [
    scoreAmountComponent(Number(txn.amount), payment.amount),
    scoreDateComponent(txn.date, order.orderDate),
    scoreVendorComponent(order, txn),
    scoreLast4Component(payment, txn),
  ];
  const score = components.reduce((a, c) => a + c.points, 0);
  const reasons = components.map((c) => c.reason).filter((r): r is string => r != null);
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
// Per-tender claim/upsert orchestration; covered by integration tests.
// fallow-ignore-next-line complexity
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

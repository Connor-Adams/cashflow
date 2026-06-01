import { Op, type Transaction as DbTransaction } from 'sequelize';
import { ExternalOrder, Transaction, TransactionOrderLink } from '../models';

export function isAmazonLikeMerchant(merchant: string): boolean {
  return /\b(amazon(?:\.ca)?|amzn|amzn\s*mktp|amazon marketplace|prime)\b/i.test(merchant);
}

function daysBetween(a: string, b: string): number {
  const one = new Date(`${a}T00:00:00Z`).getTime();
  const two = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((one - two) / 86400000);
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function last4FromText(text: string | null | undefined): string | null {
  return String(text || '').match(/\b(\d{4})\b/)?.[1] ?? null;
}

export type MatchScore = {
  confidence: number;
  matchReason: string;
};

export function scoreAmazonOrderMatch(txn: Transaction, order: ExternalOrder): MatchScore {
  let score = 0;
  const reasons: string[] = [];
  const txnAmount = Math.abs(Number(txn.amount));
  const orderTotal = numberOrNull(order.total);
  if (orderTotal != null) {
    const diff = Math.abs(txnAmount - Math.abs(orderTotal));
    if (diff <= 0.5) {
      score += 50;
      reasons.push(`amount within $0.50 (${diff.toFixed(2)})`);
    } else if (diff <= 2) {
      score += 35;
      reasons.push(`amount within $2.00 (${diff.toFixed(2)})`);
    } else {
      score -= 25;
      reasons.push(`total mismatch over $2.00 (${diff.toFixed(2)})`);
    }
  }

  const orderDate = order.shipmentDate || order.orderDate;
  if (orderDate) {
    const gap = daysBetween(txn.date, orderDate);
    if (gap >= 0 && gap <= 5) {
      score += 25;
      reasons.push(`order/shipment date ${gap} day(s) before transaction`);
    } else if (Math.abs(gap) > 10) {
      score -= 15;
      reasons.push(`date gap over 10 days (${Math.abs(gap)} days)`);
    }
  }

  if (isAmazonLikeMerchant(`${txn.merchantRaw} ${txn.merchantClean}`)) {
    score += 15;
    reasons.push('merchant indicates Amazon');
  }

  const txnLast4 = last4FromText(`${txn.notes || ''} ${txn.sourceReference || ''}`);
  if (txnLast4 && order.paymentLast4 && txnLast4 === order.paymentLast4) {
    score += 20;
    reasons.push('payment last4 matches');
  }

  return {
    confidence: Math.max(0, Math.min(100, score)),
    matchReason: reasons.join('; ') || 'candidate Amazon order',
  };
}

/**
 * Create — or refresh — a *suggested* link between a transaction and an external
 * order. Idempotent: an existing link for the same (transaction, order) pair is
 * never duplicated, and a link the user has already accepted or rejected is left
 * untouched — only a still-'suggested' row gets its score/reason refreshed.
 * Pass `transaction` to enlist the write in a surrounding DB transaction.
 * Returns whether a new row was created.
 */
export async function upsertSuggestedOrderLink(args: {
  transactionId: number;
  externalOrderId: number;
  confidence: number;
  matchReason: string;
  transaction?: DbTransaction;
}): Promise<boolean> {
  const { transactionId, externalOrderId, confidence, matchReason, transaction } = args;
  const [link, created] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId },
    defaults: {
      transactionId,
      externalOrderId,
      confidence: String(confidence),
      matchReason,
      status: 'suggested',
    },
    transaction,
  });
  if (!created && link.status === 'suggested') {
    await link.update({ confidence: String(confidence), matchReason }, { transaction });
  }
  return created;
}

export async function runAmazonMatching(args: {
  householdId: number;
}): Promise<{
  suggested: number;
  scannedTransactions: number;
  /** Earliest txn date that received a newly-suggested link, or null if none. */
  matchedDateFrom: string | null;
  /** Latest txn date that received a newly-suggested link, or null if none. */
  matchedDateTo: string | null;
}> {
  const txns = await Transaction.findAll({
    where: {
      householdId: args.householdId,
      [Op.or]: [
        { merchantRaw: { [Op.like]: '%AMAZON%' } },
        { merchantRaw: { [Op.like]: '%Amazon%' } },
        { merchantRaw: { [Op.like]: '%AMZN%' } },
        { merchantRaw: { [Op.like]: '%Prime%' } },
        { merchantClean: { [Op.like]: '%AMAZON%' } },
        { merchantClean: { [Op.like]: '%Amazon%' } },
        { merchantClean: { [Op.like]: '%AMZN%' } },
        { merchantClean: { [Op.like]: '%Prime%' } },
      ],
    },
    order: [['date', 'DESC']],
  });
  const orders = await ExternalOrder.findAll({
    where: { householdId: args.householdId, vendor: 'amazon' },
  });
  let suggested = 0;
  let matchedDateFrom: string | null = null;
  let matchedDateTo: string | null = null;

  for (const txn of txns.filter((row) => isAmazonLikeMerchant(`${row.merchantRaw} ${row.merchantClean}`))) {
    const scores = orders
      .map((order) => ({ order, ...scoreAmazonOrderMatch(txn, order) }))
      .sort((a, b) => b.confidence - a.confidence);
    const best = scores[0]?.confidence ?? 0;
    const candidates = scores.filter((candidate) =>
      candidate.confidence >= 70 || (best < 70 && candidate.confidence === best && best > 0),
    );
    for (const candidate of candidates) {
      const created = await upsertSuggestedOrderLink({
        transactionId: txn.id,
        externalOrderId: candidate.order.id,
        confidence: candidate.confidence,
        matchReason: candidate.matchReason,
      });
      if (created) {
        suggested += 1;
        if (matchedDateFrom == null || txn.date < matchedDateFrom) matchedDateFrom = txn.date;
        if (matchedDateTo == null || txn.date > matchedDateTo) matchedDateTo = txn.date;
      }
    }
  }

  return { suggested, scannedTransactions: txns.length, matchedDateFrom, matchedDateTo };
}

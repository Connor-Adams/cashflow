import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Op } from 'sequelize';
import { Transaction } from '../models';
import { logger } from '../observability/logger';
import type { TransactionStatus } from '../transactions/types';

export type DedupOutcome =
  | { kind: 'no-match' }
  | { kind: 'duplicate'; existingId: number }
  | { kind: 'duplicate-backfilled'; existingId: number }
  | { kind: 'pending-promoted'; existingId: number };

function normalizeRef(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normalizePendingMatchText(v: string | null | undefined): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function promotePending(existing: InstanceType<typeof Transaction>, incomingRef: string | null, t: SequelizeTransaction): Promise<DedupOutcome> {
  existing.status = 'posted';
  if (incomingRef != null) existing.sourceReference = incomingRef;
  await existing.save({
    transaction: t,
    fields: incomingRef == null ? ['status'] : ['status', 'sourceReference'],
  });
  logger.info(
    {
      transactionId: existing.id,
      accountId: existing.accountId,
      sourceReferenceBackfilled: incomingRef != null,
    },
    'import_pending_transaction_promoted',
  );
  return { kind: 'pending-promoted', existingId: existing.id };
}

/**
 * Look for an already-imported transaction that should be considered the same
 * as the incoming row, using `sourceIdentityFingerprint` (a hash over
 * accountId + date + amount + currency + merchantRaw) as the dedup key.
 *
 * The identity fingerprint deliberately excludes `merchantClean` and
 * `sourceReference`, both of which drift over time:
 *   - `merchantClean` changes whenever `normalizeMerchant` rules evolve
 *   - `sourceReference` flips NULL → AT… when Amex pending txns clear
 * Either change would otherwise produce a "new" fingerprint and cause a
 * re-imported CSV to insert duplicates.
 *
 * NULL-as-wildcard semantics on `source_reference` are preserved so we
 * don't collapse legitimate same-merchant/same-day/same-amount repeats
 * (e.g., two $25 Starbucks runs on 2025-12-08):
 *   - same identity, same source_reference (incl. both NULL) → duplicate
 *   - same identity, incoming NULL + existing populated      → duplicate
 *   - same identity, incoming populated + existing NULL      → duplicate-backfilled
 *       (we write incoming.source_reference onto the existing row, scoped
 *        save so the audit-only sourceRowFingerprint stays untouched)
 *   - same identity, both populated and different            → no-match
 *       (legitimate distinct charges — preserved as in the prior dedup)
 */
export async function findExistingForDedup(args: {
  accountId: number;
  sourceIdentityFingerprint: string;
  sourceReference: string | null;
  t: SequelizeTransaction;
  incomingStatus?: TransactionStatus;
  incomingDate?: string;
  incomingAmount?: number;
  incomingMerchantRaw?: string;
}): Promise<DedupOutcome> {
  const incomingRef = normalizeRef(args.sourceReference);
  const candidates = await Transaction.findAll({
    where: {
      accountId: args.accountId,
      sourceIdentityFingerprint: args.sourceIdentityFingerprint,
    },
    transaction: args.t,
  });
  for (const existing of candidates) {
    if (normalizeRef(existing.sourceReference) === incomingRef) {
      if (existing.status === 'pending' && args.incomingStatus === 'posted') {
        return promotePending(existing, incomingRef, args.t);
      }
      return { kind: 'duplicate', existingId: existing.id };
    }
  }

  if (incomingRef == null) {
    const anyPopulated = candidates.find(
      (c) => normalizeRef(c.sourceReference) != null,
    );
    if (anyPopulated) return { kind: 'duplicate', existingId: anyPopulated.id };
  }

  if (incomingRef != null) {
    const nullExisting = candidates.find(
      (c) => normalizeRef(c.sourceReference) == null,
    );
    if (nullExisting) {
      if (nullExisting.status === 'pending' && args.incomingStatus === 'posted') {
        return promotePending(nullExisting, incomingRef, args.t);
      }
      nullExisting.sourceReference = incomingRef;
      // Scoped save: only persist the sourceReference column. The audit-hash
      // `sourceRowFingerprint` is intentionally left as the null-era hash —
      // a mild mismatch is acceptable on backfill-arm rows, and rewriting it
      // would risk colliding with the existing
      // transactions_account_fingerprint_unique safety-net index.
      await nullExisting.save({
        transaction: args.t,
        fields: ['sourceReference'],
      });
      return { kind: 'duplicate-backfilled', existingId: nullExisting.id };
    }
  }

  if (
    args.incomingStatus === 'posted' &&
    args.incomingDate &&
    typeof args.incomingAmount === 'number'
  ) {
    const windowCandidates = await Transaction.findAll({
      where: {
        accountId: args.accountId,
        status: 'pending',
        date: {
          [Op.between]: [addDays(args.incomingDate, -3), addDays(args.incomingDate, 3)],
        },
      },
      transaction: args.t,
    });
    const incomingText = normalizePendingMatchText(args.incomingMerchantRaw);
    const match = windowCandidates.find(
      (row) =>
        Number(row.amount) === args.incomingAmount &&
        (normalizePendingMatchText(row.merchantRaw) === incomingText ||
          normalizePendingMatchText(row.merchantClean) === incomingText),
    );
    if (match) {
      return promotePending(match, incomingRef, args.t);
    }
  }

  return { kind: 'no-match' };
}

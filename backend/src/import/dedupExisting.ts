import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Transaction } from '../models';
import { rowFingerprint } from './fingerprint';

export type DedupOutcome =
  | { kind: 'no-match' }
  | { kind: 'duplicate'; existingId: number }
  | { kind: 'duplicate-backfilled'; existingId: number };

function normalizeRef(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Look for an already-imported transaction that should be considered the same
 * as the incoming row, applying NULL-as-wildcard semantics on `source_reference`.
 *
 * Matching key: (accountId, date, amount, currency, merchantRaw). Within that key:
 *   - exact source_reference match (incl. both NULL) → duplicate
 *   - incoming NULL, any existing populated     → duplicate (incoming has no new info)
 *   - incoming populated, existing NULL         → duplicate-backfilled
 *       (we write incoming.source_reference + new fingerprint onto the existing row)
 *   - both populated and different              → not a match (legitimate distinct charge)
 */
export async function findExistingForDedup(args: {
  accountId: number;
  date: string;
  amount: string | number;
  currency: string;
  merchantRaw: string;
  sourceReference: string | null;
  t: SequelizeTransaction;
}): Promise<DedupOutcome> {
  const incomingRef = normalizeRef(args.sourceReference);
  const candidates = await Transaction.findAll({
    where: {
      accountId: args.accountId,
      date: args.date,
      amount: String(args.amount),
      currency: args.currency,
      merchantRaw: args.merchantRaw,
    },
    transaction: args.t,
  });
  if (candidates.length === 0) return { kind: 'no-match' };

  for (const existing of candidates) {
    if (normalizeRef(existing.sourceReference) === incomingRef) {
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
      nullExisting.sourceReference = incomingRef;
      nullExisting.sourceRowFingerprint = rowFingerprint({
        accountId: nullExisting.accountId,
        date: nullExisting.date,
        amount: Number(nullExisting.amount),
        currency: nullExisting.currency,
        merchantRaw: nullExisting.merchantRaw,
        sourceReference: incomingRef,
      });
      await nullExisting.save({ transaction: args.t });
      return { kind: 'duplicate-backfilled', existingId: nullExisting.id };
    }
  }

  return { kind: 'no-match' };
}

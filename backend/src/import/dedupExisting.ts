import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Transaction } from '../models';

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
}): Promise<DedupOutcome> {
  const incomingRef = normalizeRef(args.sourceReference);
  const candidates = await Transaction.findAll({
    where: {
      accountId: args.accountId,
      sourceIdentityFingerprint: args.sourceIdentityFingerprint,
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

  return { kind: 'no-match' };
}

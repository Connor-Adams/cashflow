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

function exactRefMatch(
  candidates: Transaction[],
  incomingRef: string | null,
): Transaction | null {
  return candidates.find((c) => normalizeRef(c.sourceReference) === incomingRef) ?? null;
}

function existingPopulatedWhenIncomingNull(
  candidates: Transaction[],
  incomingRef: string | null,
): Transaction | null {
  if (incomingRef != null) return null;
  return candidates.find((c) => normalizeRef(c.sourceReference) != null) ?? null;
}

function existingNullWhenIncomingPopulated(
  candidates: Transaction[],
  incomingRef: string | null,
): Transaction | null {
  if (incomingRef == null) return null;
  return candidates.find((c) => normalizeRef(c.sourceReference) == null) ?? null;
}

function normalizePendingMatchText(v: string | null | undefined): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

/**
 * Aggressive merchant normalization for the cross-parser-drift fallback:
 * lowercase, then strip ALL non-alphanumeric characters. Collapses parser
 * reconstructions of the same bank merchant that differ only in internal
 * whitespace/punctuation, e.g. "PIZZAVILLE #118" (CSV) and "PIZZAVILLE #1 18"
 * (Wealthsimple PDF) both → "pizzaville118"; "DAIRY QUEEN #11989 GRI" and
 * "DAIRY QUEEN #1 1989 GRI" both → "dairyqueen11989gri". Genuinely distinct
 * merchants ("starbucks" vs "mcdonalds") stay distinct.
 */
function aggressiveMerchantKey(v: string | null | undefined): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
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
 *   - `sourceReference` flips NULL -> AT... when Amex pending txns clear
 * Either change would otherwise produce a "new" fingerprint and cause a
 * re-imported CSV to insert duplicates.
 *
 * NULL-as-wildcard semantics on `source_reference` are preserved so we
 * don't collapse legitimate same-merchant/same-day/same-amount repeats
 * (e.g., two $25 Starbucks runs on 2025-12-08):
 *   - same identity, same source_reference (incl. both NULL) -> duplicate
 *   - same identity, incoming NULL + existing populated      -> duplicate
 *   - same identity, incoming populated + existing NULL      -> duplicate-backfilled
 *       (we write incoming.source_reference onto the existing row, scoped
 *        save so the audit-only sourceRowFingerprint stays untouched)
 *   - same identity, both populated and different            -> no-match
 *       (legitimate distinct charges -- preserved as in the prior dedup)
 */
export async function findExistingForDedup(args: {
  accountId: number;
  sourceIdentityFingerprint: string;
  sourceReference: string | null;
  t: SequelizeTransaction;
  incomingStatus?: TransactionStatus;
  incomingDate?: string;
  incomingAmount?: number;
  incomingCurrency?: string;
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
  const exact = exactRefMatch(candidates, incomingRef);
  if (exact) {
    if (exact.status === 'pending' && args.incomingStatus === 'posted') {
      return promotePending(exact, incomingRef, args.t);
    }
    return { kind: 'duplicate', existingId: exact.id };
  }

  const wildcardHit = existingPopulatedWhenIncomingNull(candidates, incomingRef);
  if (wildcardHit) return { kind: 'duplicate', existingId: wildcardHit.id };

  const toBackfill = existingNullWhenIncomingPopulated(candidates, incomingRef);
  if (toBackfill && incomingRef != null) {
    if (toBackfill.status === 'pending' && args.incomingStatus === 'posted') {
      return promotePending(toBackfill, incomingRef, args.t);
    }
    toBackfill.sourceReference = incomingRef;
    // Scoped save: only persist the sourceReference column. The audit-hash
    // `sourceRowFingerprint` is intentionally left as the null-era hash --
    // a mild mismatch is acceptable on backfill-arm rows, and rewriting it
    // would risk colliding with the existing
    // transactions_account_fingerprint_unique safety-net index.
    await toBackfill.save({
      transaction: args.t,
      fields: ['sourceReference'],
    });
    return { kind: 'duplicate-backfilled', existingId: toBackfill.id };
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

  // Final fallback tier: cross-parser merchant drift. The same statement
  // re-imported in a different format (e.g. CSV first, then the Wealthsimple
  // credit-card PDF parser) can reconstruct `merchantRaw` differently for some
  // rows -- "PIZZAVILLE #118" vs "PIZZAVILLE #1 18", "DAIRY QUEEN #11989 GRI"
  // vs "DAIRY QUEEN #1 1989 GRI". That flips the identity fingerprint, so every
  // tier above misses and the row gets inserted again, double-counting balance.
  //
  // For a posted incoming row, look for an existing POSTED row in the same
  // account with the same date/amount/currency whose merchant -- after
  // aggressive normalization (lowercase + strip all non-alphanumerics) --
  // equals the incoming merchant's. Same date+amount+currency keeps this tight;
  // the aggressive key keeps genuinely-different merchants apart.
  if (
    args.incomingStatus === 'posted' &&
    args.incomingDate &&
    typeof args.incomingAmount === 'number'
  ) {
    const incomingKey = aggressiveMerchantKey(args.incomingMerchantRaw);
    if (incomingKey !== '') {
      const driftWhere: Record<string, unknown> = {
        accountId: args.accountId,
        status: 'posted',
        date: args.incomingDate,
      };
      if (args.incomingCurrency != null) {
        driftWhere.currency = String(args.incomingCurrency).toUpperCase();
      }
      const driftCandidates = await Transaction.findAll({
        where: driftWhere,
        transaction: args.t,
      });
      const driftMatch = driftCandidates.find(
        (row) =>
          Number(row.amount) === args.incomingAmount &&
          (aggressiveMerchantKey(row.merchantRaw) === incomingKey ||
            aggressiveMerchantKey(row.merchantClean) === incomingKey),
      );
      if (driftMatch) {
        // Keep this tier minimal: do NOT backfill source_reference here. Treat
        // as a duplicate when refs are compatible (both null, or incoming null,
        // or equal). If incoming has a ref and existing is null, we still skip
        // the re-insert (the dedup goal) rather than mutate the existing row.
        const existingRef = normalizeRef(driftMatch.sourceReference);
        if (incomingRef == null || existingRef == null || existingRef === incomingRef) {
          return { kind: 'duplicate', existingId: driftMatch.id };
        }
      }
    }
  }

  return { kind: 'no-match' };
}

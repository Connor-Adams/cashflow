import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Op } from 'sequelize';
import { Transaction } from '../models';
import { logger } from '../observability/logger';
import type { TransactionStatus } from '../transactions/types';

export type DedupOutcome =
  | {
      kind: 'no-match';
      /**
       * Existing rows that look like this row under the narrative-rename key
       * but sit one day off, so dedup deliberately declined them. Live dedup
       * stays on an exact date match — a ±1-day window would also collapse two
       * genuine consecutive-day movements of equal size, which on a deposit
       * account carry a generic narrative on both sides and so pass the gate.
       * Reporting them lets the import warn instead of losing the signal.
       */
      nearMissCandidateIds?: number[];
    }
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
export function aggressiveMerchantKey(v: string | null | undefined): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Statement narratives that carry no merchant identity — a provider's own
 * bookkeeping label for a cash movement rather than a payee. Wealthsimple's
 * brokerage-layout statements word every cash row this way, which is why the
 * same charge reads "Pre-authorized Debit to AMEX BILL PYMT" in the activities
 * export and "Cash correction (executed at 2026-02-17)" in the monthly PDF.
 *
 * The list is CLOSED on purpose. It gates the narrative-rename dedup tier, and
 * that tier matches without regard to merchant text, so the gate is the only
 * thing standing between it and a false positive: two genuinely distinct $5
 * charges on one card on one day share (account, date, amount, currency), and
 * "STARBUCKS #123" beside "MCDONALDS #99" must never collapse into one row.
 * Two specific merchants never describe one event; a generic narrative beside
 * anything is the rename case. Every entry here was observed on one side of a
 * confirmed duplicate pair in prod (2026-09-29 audit) — adding a string that a
 * real merchant could also produce would reopen the hole, so extend it only
 * from evidence.
 */
const GENERIC_STATEMENT_NARRATIVES = new Set<string>([
  'withdrawal',
  'deposit',
  'contribution',
  'cash correction',
  'cash received',
  'cash sent',
  'transfer in',
  'transfer out',
  'money transfer into the account',
  'money transfer out of the account',
]);

/**
 * True when the text is a bare provider bookkeeping label. Wealthsimple suffixes
 * most of them with "(executed at YYYY-MM-DD)", which is stripped first; a
 * narrative carrying any OTHER trailing text (a merchant name, a reference)
 * fails the check, so only the pure labels qualify.
 */
export function isGenericStatementNarrative(v: string | null | undefined): boolean {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/\s*\(executed at \d{4}-\d{2}-\d{2}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return GENERIC_STATEMENT_NARRATIVES.has(s);
}

/**
 * The execution date Wealthsimple stamps into a narrative ("Contribution
 * (executed at 2025-07-16)"), or null when the text carries none.
 *
 * The monthly CSV dates a row by the day it POSTED and stamps the day it
 * EXECUTED into the text, while the brokerage PDF dates the same row by that
 * execution day — so prod id 917 reads "2025-07-15 ... (executed at
 * 2025-07-16)" and its PDF twin is dated 2025-07-16. The stamp is the
 * provider's own record of when the event happened, so it is the date two
 * formats can agree on.
 */
export function executedAtDate(v: string | null | undefined): string | null {
  const m = String(v ?? '').match(/\(executed at (\d{4}-\d{2}-\d{2})\)\s*$/i);
  return m ? m[1] : null;
}

/**
 * True when two rows of one account describe a cash event on the same day:
 * either their row dates agree, or their EVENT dates do — a row's event date
 * being its executed-at stamp when it has one, its row date otherwise.
 *
 * Deliberately not a ±1-day window. Two different stamps are two different
 * events even a day apart, and an unstamped row one day off a stamped one is
 * left to the near-miss report: a window would also collapse two genuine
 * consecutive-day movements of equal size.
 */
function sameEventDay(
  row: { date: string; merchantRaw: string | null },
  incomingDate: string,
  incomingMerchantRaw: string | undefined,
): boolean {
  if (row.date === incomingDate) return true;
  const rowEvent = executedAtDate(row.merchantRaw) ?? row.date;
  const incomingEvent = executedAtDate(incomingMerchantRaw) ?? incomingDate;
  return rowEvent === incomingEvent;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function promotePending(
  existing: InstanceType<typeof Transaction>,
  incomingRef: string | null,
  t: SequelizeTransaction,
  // The settled identity the incoming posted row presents. Promotion must
  // adopt it (date + identity fingerprint): the row was matched via the
  // pending-window tier precisely because its pending-era hold date (and the
  // fingerprint hashed from it) differ from the settled charge. If we left
  // them in place, a SECOND source re-presenting the same settled transaction
  // (CSV first, then the same statement as PDF) would miss every tier — the
  // fingerprint lookup (pending-date hash), the pending window (row is now
  // 'posted'), and the drift tier (exact-date match) — and insert a
  // duplicate, double-counting spend.
  incomingIdentity?: { sourceIdentityFingerprint: string; date?: string },
): Promise<DedupOutcome> {
  existing.status = 'posted';
  const fields: string[] = ['status'];
  if (incomingRef != null) {
    existing.sourceReference = incomingRef;
    fields.push('sourceReference');
  }
  if (incomingIdentity) {
    if (incomingIdentity.date != null && existing.date !== incomingIdentity.date) {
      existing.date = incomingIdentity.date;
      fields.push('date');
    }
    if (existing.sourceIdentityFingerprint !== incomingIdentity.sourceIdentityFingerprint) {
      existing.sourceIdentityFingerprint = incomingIdentity.sourceIdentityFingerprint;
      fields.push('sourceIdentityFingerprint');
    }
  }
  await existing.save({ transaction: t, fields: fields as never });
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
 * Render the date-shifted near-misses an import collected into a warning for
 * the caller's result. Live dedup declines these on purpose (see
 * `nearMissCandidateIds`), so the rows DO import — the warning is what keeps a
 * re-import of an already-covered range from passing silently.
 */
export function nearDuplicateWarnings(candidateIdsPerRow: number[][]): string[] {
  if (candidateIdsPerRow.length === 0) return [];
  const ids = [...new Set(candidateIdsPerRow.flat())].sort((a, b) => a - b);
  return [
    `${candidateIdsPerRow.length} imported row(s) match an existing transaction on an ` +
      `adjacent date (transaction id(s) ${ids.join(', ')}). The same charge may already be ` +
      'present under a different narrative — review these before trusting period totals.',
  ];
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
  /**
   * Existing transaction ids already claimed by an earlier row of this same
   * import. Only the narrative-rename tier honours it: that tier matches on
   * (account, date, amount, currency) alone, so without a consumed set two
   * incoming rows sharing that key would both absorb into the SAME existing
   * row and the second — a genuinely distinct charge — would be silently
   * dropped. Same reason `fuzzyDedupInvestmentActivity` takes `excludeIds`.
   */
  consumedExistingIds?: ReadonlySet<number>;
}): Promise<DedupOutcome> {
  const incomingRef = normalizeRef(args.sourceReference);

  // Tier 0 — bank-issued reference. A provider's own transaction id identifies
  // a row more reliably than anything we parse out of its description, and the
  // identity fingerprint hashes `merchantRaw`: any change to a parser's text
  // output (a fixed line wrap, a new normalisation rule, a reworded memo) gives
  // every previously imported row a "new" fingerprint, so the tiers below find
  // no candidates at all and a re-import inserts duplicates.
  //
  // Scoped to the account, because one reference legitimately appears on both
  // sides of an FX conversion (Wise prints the same BALANCE-* id on the USD and
  // CAD statements). The amount must agree too, so a provider that recycles an
  // id across genuinely distinct charges cannot collapse them.
  if (incomingRef != null) {
    const refMatches = await Transaction.findAll({
      where: { accountId: args.accountId, sourceReference: incomingRef },
      transaction: args.t,
    });
    const byRef = refMatches.find(
      (row) => args.incomingAmount == null || Number(row.amount) === args.incomingAmount,
    );
    if (byRef) {
      if (byRef.status === 'pending' && args.incomingStatus === 'posted') {
        return promotePending(byRef, incomingRef, args.t, {
          sourceIdentityFingerprint: args.sourceIdentityFingerprint,
          date: args.incomingDate,
        });
      }
      return { kind: 'duplicate', existingId: byRef.id };
    }
  }

  const candidates = await Transaction.findAll({
    where: {
      accountId: args.accountId,
      sourceIdentityFingerprint: args.sourceIdentityFingerprint,
    },
    transaction: args.t,
  });
  const incomingIdentity = {
    sourceIdentityFingerprint: args.sourceIdentityFingerprint,
    date: args.incomingDate,
  };
  const exact = exactRefMatch(candidates, incomingRef);
  if (exact) {
    if (exact.status === 'pending' && args.incomingStatus === 'posted') {
      return promotePending(exact, incomingRef, args.t, incomingIdentity);
    }
    return { kind: 'duplicate', existingId: exact.id };
  }

  const wildcardHit = existingPopulatedWhenIncomingNull(candidates, incomingRef);
  if (wildcardHit) return { kind: 'duplicate', existingId: wildcardHit.id };

  const toBackfill = existingNullWhenIncomingPopulated(candidates, incomingRef);
  if (toBackfill && incomingRef != null) {
    if (toBackfill.status === 'pending' && args.incomingStatus === 'posted') {
      return promotePending(toBackfill, incomingRef, args.t, incomingIdentity);
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
    const incomingCcy =
      args.incomingCurrency != null ? String(args.incomingCurrency).toUpperCase() : null;
    const match = windowCandidates.find(
      (row) =>
        Number(row.amount) === args.incomingAmount &&
        // Currency must match: a posted USD row must not promote/absorb a
        // pending CAD hold that happens to share the same numeric amount +
        // merchant. The window SQL doesn't filter currency, so guard here.
        (incomingCcy == null || String(row.currency).toUpperCase() === incomingCcy) &&
        (normalizePendingMatchText(row.merchantRaw) === incomingText ||
          normalizePendingMatchText(row.merchantClean) === incomingText),
    );
    if (match) {
      return promotePending(match, incomingRef, args.t, incomingIdentity);
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


  // Tier 5 — cross-source NARRATIVE RENAME. Every tier above is anchored on the
  // merchant text (the drift tier included: `aggressiveMerchantKey` only
  // survives punctuation drift), and tier 0 needs a bank-issued reference the
  // provider may not supply — no Wealthsimple batch populates `source_reference`
  // at all. So when two exports of the same account word the same cash event
  // with unrelated strings -- WS bills one charge as "Pre-authorized Debit to
  // AMEX BILL PYMT" in the activities export and "Cash correction (executed at
  // ...)" in the brokerage PDF -- nothing above matches, and a re-import of an
  // already-covered range inserts the whole range again. That happened in prod:
  // 40 pairs, Feb-Mar 2026 spend inflated ~$19k and inflow ~$79k.
  //
  // This tier therefore ignores the merchant text and keys on
  // (account, date, amount, currency). That key is NOT unique on its own -- two
  // genuinely distinct $5 charges on one card on one day share it -- so it
  // carries two guards:
  //
  //   GATE       at least one side must be a bare provider bookkeeping label
  //              (GENERIC_STATEMENT_NARRATIVES). Two specific merchants never
  //              describe one event, so "STARBUCKS #123" beside "MCDONALDS #99"
  //              can never collapse.
  //   AMBIGUITY  exactly ONE unconsumed row may hold the key. 0 or 2+ declines.
  //              Declining leaves a duplicate, recoverable by deleting a row;
  //              guessing wrong absorbs a real transaction into an unrelated
  //              one, which is not. That asymmetry sets the direction.
  //
  // "Date" here is the EVENT day (`sameEventDay`): a row's Wealthsimple
  // "(executed at ...)" stamp when it carries one. The monthly CSV dates a row
  // by its posting day and the brokerage PDF by its execution day, so on an
  // exact row-date match the same deposit missed by a day. Both candidate kinds
  // count toward the ambiguity gate together.
  let nearMissCandidateIds: number[] | undefined;
  if (
    args.incomingStatus === 'posted' &&
    args.incomingDate &&
    typeof args.incomingAmount === 'number'
  ) {
    const renameWhere: Record<string, unknown> = {
      accountId: args.accountId,
      status: 'posted',
      // One day either side, so the same scan yields both the exact-date
      // matches this tier acts on and the date-shifted near-misses it reports.
      date: { [Op.between]: [addDays(args.incomingDate, -1), addDays(args.incomingDate, 1)] },
    };
    if (args.incomingCurrency != null) {
      renameWhere.currency = String(args.incomingCurrency).toUpperCase();
    }
    const incomingIsGeneric = isGenericStatementNarrative(args.incomingMerchantRaw);
    const inWindow = (
      await Transaction.findAll({ where: renameWhere, transaction: args.t })
    ).filter(
      (row) =>
        Number(row.amount) === args.incomingAmount &&
        !(args.consumedExistingIds?.has(row.id) ?? false) &&
        (incomingIsGeneric ||
          isGenericStatementNarrative(row.merchantRaw) ||
          isGenericStatementNarrative(row.merchantClean)) &&
        // Two populated, differing bank references mean the provider itself
        // calls these distinct charges. Same rule as the drift tier.
        (incomingRef == null ||
          normalizeRef(row.sourceReference) == null ||
          normalizeRef(row.sourceReference) === incomingRef),
    );
    const incomingDate = args.incomingDate;
    const sameDate = inWindow.filter((row) =>
      sameEventDay(row, incomingDate, args.incomingMerchantRaw),
    );
    if (sameDate.length === 1) {
      return { kind: 'duplicate', existingId: sameDate[0].id };
    }
    if (sameDate.length > 1) {
      // Flag rather than guess. The row gets inserted (the caller treats
      // no-match as "insert"), so nothing is lost, and this log is how an
      // ambiguous re-import surfaces for review.
      logger.warn(
        {
          accountId: args.accountId,
          date: args.incomingDate,
          amount: args.incomingAmount,
          currency: args.incomingCurrency ?? null,
          candidateIds: sameDate.map((row) => row.id),
        },
        'import_narrative_rename_dedup_ambiguous',
      );
    } else {
      const shifted = inWindow.filter((row) => !sameDate.includes(row));
      if (shifted.length > 0) nearMissCandidateIds = shifted.map((row) => row.id);
    }
  }

  return nearMissCandidateIds ? { kind: 'no-match', nearMissCandidateIds } : { kind: 'no-match' };
}

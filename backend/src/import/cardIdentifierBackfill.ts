/**
 * One-time backfill of `account_card_identifiers` off receipt data that
 * predates the import-time harvest hooks
 * (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md,
 * Part 3).
 *
 * Walks every `ExternalOrder` whose `source` is on the existing
 * `DETERMINISTIC_RECEIPT_SOURCES` allowlist (backend/src/amazon/cardOwnership.ts
 * — the same allowlist the live receipt-tender harvest hook in
 * matchReceiptToTransactions.ts already gates on), follows its
 * `TransactionOrderLink` rows to the linked transactions' accounts, and
 * upserts an identifier for each (account, last4) pair with
 * `source: 'backfill:<original source>'`.
 *
 * The allowlist is what makes this safe: it is the same rule that stops the
 * live hook from trusting an AI-extracted last4 (`gmail-scan:ai`), so the
 * backfill cannot manufacture the one known-bad production datum either
 * (a `9907` misparse on an Uber Eats receipt). Every other account's last-4
 * is already recoverable from `short_code` — a backfill run that writes more
 * than the handful of genuinely new rows has over-harvested, which is the
 * failure mode to watch for, not under-harvesting.
 *
 * `linkedAccountsForOrder` only follows `TransactionOrderLink` rows whose
 * `status` is `'accepted'` -- a `'suggested'` link is the system's own
 * statement that the match is not confident, and a `'rejected'` one is a
 * confirmed non-match; neither is a basis for recording a card identifier.
 *
 * Against production this is expected to write exactly TWO new rows, both
 * legitimate: `(5, '3114')` (Costco MC, from order 399's tender on an
 * accepted link) and `(14, '3812')` (Wealthsimple Chequing, from order 398's
 * tender `3812`/$1863.72, paired by `linked_amount` to an accepted link on
 * account 14 -- a split-tender Costco purchase). A run reporting more than
 * these two has over-harvested and should be investigated before applying.
 *
 * Idempotent: `upsertAccountCardIdentifier` is a find-or-create keyed on
 * (accountId, last4), so re-running writes nothing new and never duplicates.
 *
 * Mirrors the `dryRun`-supporting-function-plus-manually-triggered-script
 * shape used elsewhere for one-time data operations (see
 * backend/src/import/wsDepositActivityMigration.ts and its wrapper
 * backend/scripts/migrate-ws-deposit-activities.ts) rather than inventing a
 * new convention. Deliberately NOT wired to a cron.
 */
import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderTender,
  Transaction,
  TransactionOrderLink,
} from '../models';
import { DETERMINISTIC_RECEIPT_SOURCES } from '../amazon/cardOwnership';
import { AccountCardIdentifier, upsertAccountCardIdentifier } from '../models/AccountCardIdentifier';

export type BackfillCandidate = {
  externalOrderId: number;
  source: string;
  accountId: number;
  last4: string;
  /** Whether an identifier row for (accountId, last4) already existed before this run. */
  alreadyExists: boolean;
};

export type BackfillReport = {
  /** Every (account, last4) pair the deterministic sources yield, existing or not. */
  candidates: BackfillCandidate[];
  /** The subset that did not already have an identifier row when this run started. */
  newRows: BackfillCandidate[];
  dryRun: boolean;
};

function amountsMatch(a: string | null, b: string | number | null): boolean {
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.005;
}

type LinkedAccount = { last4: string; accountId: number };

/**
 * Pair this order's tenders (or its own paymentLast4, when it has no tender
 * rows) with the account each claimed transaction belongs to.
 *
 * A single-tender order needs no pairing logic -- its one tender's last4
 * goes with every one of its links. A split-tender order pairs each tender
 * to the link whose `linkedAmount` matches that tender's amount (the same
 * amount that was used to claim the transaction when the link was created).
 * A tender that cannot be matched to a link by amount is skipped rather than
 * guessed at -- over-attribution is the failure mode this backfill exists to
 * avoid.
 */
async function linkedAccountsForOrder(order: ExternalOrder): Promise<LinkedAccount[]> {
  // status: 'accepted' -- a 'suggested' link is the system's own statement
  // that the match is NOT confident, and a 'rejected' link is a confirmed
  // non-match. Neither is a basis for recording a card identifier. Without
  // this filter, a suggested link is skipped today only by accident (its
  // linked_amount is often still NULL, which fails amountsMatch below) --
  // the moment it gets an amount, or for the no-tender fallback further
  // down (which has no amount check at all), this would harvest off an
  // unconfirmed or rejected match. See FIX 2 in the 2026-09-11 card
  // identifiers review.
  const links = await TransactionOrderLink.findAll({
    where: { externalOrderId: order.id, status: 'accepted' },
  });
  if (links.length === 0) return [];

  const txns = await Transaction.findAll({
    where: { id: { [Op.in]: links.map((l) => l.transactionId) } },
    attributes: ['id', 'accountId'],
  });
  const accountByTxnId = new Map(txns.map((t) => [t.id, t.accountId]));

  const tenders = await ExternalOrderTender.findAll({
    where: { externalOrderId: order.id },
    order: [['sequence', 'ASC']],
  });

  const results: LinkedAccount[] = [];

  if (tenders.length === 0) {
    if (!order.paymentLast4) return [];
    for (const link of links) {
      const accountId = accountByTxnId.get(link.transactionId);
      if (accountId == null) continue;
      results.push({ last4: order.paymentLast4, accountId });
    }
    return results;
  }

  const claimedLinkIds = new Set<number>();
  for (const tender of tenders) {
    if (!tender.paymentLast4) continue;
    const link = links.find(
      (l) => !claimedLinkIds.has(l.id) && amountsMatch(l.linkedAmount, tender.amount),
    );
    if (!link) continue;
    claimedLinkIds.add(link.id);
    const accountId = accountByTxnId.get(link.transactionId);
    if (accountId == null) continue;
    results.push({ last4: tender.paymentLast4, accountId });
  }
  return results;
}

/**
 * Run the backfill. `dryRun` is REQUIRED — there is deliberately no default.
 *
 * The sibling one-time operations here (`migrateWsDepositActivities`,
 * `restoreBundle`, `interacCounterparty`) all default `dryRun` to `false`, i.e.
 * a no-argument call writes. Following that convention would be consistent but
 * wrong for this function specifically: an `account_card_identifiers` row
 * grants a card permanent identity that feeds `buildLast4Map`, ownership
 * classification and match scoring, and NOTHING in the app can delete one once
 * written. Inverting the default instead would make this the odd one out among
 * four siblings, which is its own trap. So the caller must state intent and
 * cannot get it wrong by omission.
 */
export async function backfillAccountCardIdentifiers(
  opts: { dryRun: boolean },
): Promise<BackfillReport> {
  const { dryRun } = opts;

  const orders = await ExternalOrder.findAll({
    where: { source: { [Op.in]: Array.from(DETERMINISTIC_RECEIPT_SOURCES) } },
    order: [['id', 'ASC']],
  });

  const candidates: BackfillCandidate[] = [];
  // Pairs already resolved by an earlier order in this same run -- tracked
  // independently of dryRun so the report counts a (account, last4) pair as
  // "new" exactly once even when many orders corroborate it (production has
  // 29 more Costco orders behind the one 3114 identifier), whether or not
  // anything is actually being written.
  const resolvedThisRun = new Set<string>();

  for (const order of orders) {
    if (order.householdId == null) continue;
    const pairs = await linkedAccountsForOrder(order);
    for (const { last4, accountId } of pairs) {
      const key = `${accountId}:${last4}`;
      const existing =
        resolvedThisRun.has(key) ||
        (await AccountCardIdentifier.findOne({ where: { accountId, last4 } })) != null;
      candidates.push({
        externalOrderId: order.id,
        source: order.source,
        accountId,
        last4,
        alreadyExists: existing,
      });
      if (existing) continue;
      resolvedThisRun.add(key);

      if (dryRun) continue;
      await upsertAccountCardIdentifier({
        householdId: order.householdId,
        accountId,
        last4,
        source: `backfill:${order.source}`,
        seenAt: order.orderDate ? new Date(`${order.orderDate}T00:00:00Z`) : undefined,
      });
    }
  }

  return {
    candidates,
    newRows: candidates.filter((c) => !c.alreadyExists),
    dryRun,
  };
}

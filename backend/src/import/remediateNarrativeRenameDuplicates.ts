/**
 * Remediation of narrative-rename duplicate transactions already in the ledger.
 *
 * Tier 5 of `findExistingForDedup` stops NEW duplicates of this shape. It cannot
 * undo the ones already written. A 2026-09-29 read-only audit of prod found 40
 * confirmed duplicate pairs under an exact date match and 64 under ±1 day,
 * inflating Feb–Mar 2026 spend by ~$19k and inflow by ~$79k. Two Wealthsimple
 * re-import batches are almost entirely duplicate: `2026-06 HQ8H0GZ07CAD` at
 * 10/12 rows and `2026-06 WK3DD9X35CAD` at 28/45.
 *
 * WHY THIS IS NOT `rollbackImportBatch`: those batches also brought in
 * legitimately-new rows (17 of 45 on the chequing account), so rolling the batch
 * back would delete real transactions. The unit of corruption is the row, not
 * the batch.
 *
 * WHY THE CLASSIFIER IS LOOSER THAN LIVE DEDUP: it runs once, over a bounded
 * set, against a pairing table a human reads before anything is deleted. Live
 * dedup must be conservative because it fires unattended on every import — a
 * ±1-day window there would also collapse two genuine consecutive-day
 * withdrawals of equal size, which on a deposit account carry a generic
 * narrative on both sides. Here a human adjudicates, so the ±1-day cluster (the
 * settlement-vs-execution offset on the `WS deposit ledger cleanup` batch) is
 * remediated rather than left behind. Same posture as
 * `wsDepositActivityMigration`.
 *
 * WHICH SIDE IS DROPPED is settled by evidence, not preference. In every
 * confirmed prod pair the duplicate is the LATER-written row, and it carries
 * worse metadata: `import_confidence='needs_review'` on 28 of 40 duplicate rows
 * versus 8 of 40 originals, `txn_type` flattened to 'transfer', category reset
 * to 'Uncategorized'. Rows are therefore ordered by (created_at, id) and the
 * earliest is kept.
 *
 * SAFETY POSTURE — nothing is deleted on a guess:
 *   - a date-window cluster holding anything other than exactly two rows is
 *     reported AMBIGUOUS and left alone (prod has one such case: id 12123 at
 *     -200 sits one day from both 1427 and 1430);
 *   - two rows from the SAME import batch are never a re-import of each other,
 *     so they are not a pair;
 *   - a row a human has touched (any override column set), or that owns a
 *     receipt or an external-order link, is reported BLOCKED and left alone —
 *     the same conservative refusal `rollbackImportBatch` applies;
 *   - `classify` is read-only. `apply` deletes only inside a single SQL
 *     transaction, and re-classifies within it so a racing edit cannot land
 *     between the report a human approved and the delete.
 *
 * The dependent-row deletion order below mirrors `executeRollback` in
 * rollbackImportBatch.ts, scoped to ids rather than a batch label. The
 * duplication is deliberate: extracting a shared helper would mean editing an
 * audited destructive path, which is not worth doing in the same change as a
 * prod cleanup.
 */
import { Op, type Transaction as SequelizeTransaction } from 'sequelize';
import {
  AiSuggestion,
  BudgetExclusion,
  PlannedEvent,
  Receipt,
  Transaction,
  TransactionOrderLink,
  TransactionSignal,
  TransactionTaxMetadata,
  sequelize,
} from '../models';
import { logger } from '../observability/logger';
import { aggressiveMerchantKey, isGenericStatementNarrative } from './dedupExisting';

export type MatchReason = 'generic-narrative' | 'whitespace-drift';

export type DuplicatePair = {
  accountId: number;
  amount: number;
  currency: string;
  /** Kept row — the earlier-written one. */
  keepId: number;
  keepBatch: string | null;
  keepDate: string;
  keepMerchantRaw: string;
  /** Row to delete — the later-written one. */
  dropId: number;
  dropBatch: string | null;
  dropDate: string;
  dropMerchantRaw: string;
  /** 0 for an exact date match, 1 when the pair sits one day apart. */
  dateShiftDays: number;
  matchReason: MatchReason;
};

export type AmbiguousGroup = {
  accountId: number;
  amount: number;
  currency: string;
  ids: number[];
  dates: string[];
  reason: string;
};

export type BlockedRow = {
  dropId: number;
  keepId: number;
  reason: string;
};

export type RemediationReport = {
  pairs: DuplicatePair[];
  ambiguous: AmbiguousGroup[];
  blocked: BlockedRow[];
};

export type ClassifyOptions = {
  /** 0 = exact date only. 1 = also pair rows one day apart. */
  windowDays?: 0 | 1;
  /** Restrict to one household; omit to sweep every row. */
  householdId?: number | null;
  /** Restrict to these accounts; omit for all. */
  accountIds?: number[];
  /**
   * Run inside an existing SQL transaction. `apply` threads its own so the
   * classification a delete acts on is the one taken under the same lock — a
   * racing edit cannot land between the report a human approved and the delete.
   */
  t?: SequelizeTransaction;
};

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`);
  return Math.abs(Math.round(ms / 86_400_000));
}

/**
 * Why one row of a pair looks like the other's rename, or null when it does not.
 * `generic-narrative` is the Wealthsimple case — one side is a bare provider
 * bookkeeping label. `whitespace-drift` is the Amex Reserve case, where the two
 * exports differ only in internal spacing of `merchant_raw` (3 spaces vs 4).
 */
function matchReasonFor(
  a: { merchantRaw: string; merchantClean: string | null },
  b: { merchantRaw: string; merchantClean: string | null },
): MatchReason | null {
  const keyA = aggressiveMerchantKey(a.merchantRaw);
  const keyB = aggressiveMerchantKey(b.merchantRaw);
  if (keyA !== '' && keyA === keyB) return 'whitespace-drift';
  const generic =
    isGenericStatementNarrative(a.merchantRaw) ||
    isGenericStatementNarrative(a.merchantClean) ||
    isGenericStatementNarrative(b.merchantRaw) ||
    isGenericStatementNarrative(b.merchantClean);
  return generic ? 'generic-narrative' : null;
}

/** Overrides whose presence means a human edited the row. */
function humanEdited(row: InstanceType<typeof Transaction>): string | null {
  if (row.categoryOverrideId != null) return 'category_override_id is set';
  if (row.splitOverride != null) return 'split_override is set';
  if (row.businessOverride != null) return 'business_override is set';
  if (row.taxTreatmentOverride != null) return 'tax_treatment_override is set';
  return null;
}

/**
 * Read-only. Produces the pairing table a human reads before anything is
 * deleted, plus everything deliberately left alone and why.
 */
export async function classifyNarrativeRenameDuplicates(
  opts: ClassifyOptions = {},
): Promise<RemediationReport> {
  const windowDays = opts.windowDays ?? 0;
  const where: Record<string, unknown> = { status: 'posted' };
  if (opts.householdId != null) where.householdId = opts.householdId;
  if (opts.accountIds && opts.accountIds.length > 0) {
    where.accountId = { [Op.in]: opts.accountIds };
  }
  const rows = await Transaction.findAll({
    where,
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction: opts.t,
  });

  // Group on the only tuple prod proved stable across the two exports:
  // account + signed amount + currency. `source_reference` is NULL on both
  // sides of all 40 confirmed pairs and no Wealthsimple batch populates it, so
  // there is no provider id to key on.
  const groups = new Map<string, InstanceType<typeof Transaction>[]>();
  for (const row of rows) {
    const key = `${row.accountId}|${Number(row.amount)}|${String(row.currency).toUpperCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const report: RemediationReport = { pairs: [], ambiguous: [], blocked: [] };

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    // Cluster by date proximity. Rows are chained, so a run of near dates stays
    // one cluster and is judged as a whole rather than paired off greedily.
    const byDate = [...bucket].sort((a, b) => a.date.localeCompare(b.date));
    let cluster: InstanceType<typeof Transaction>[] = [byDate[0]];
    const clusters: InstanceType<typeof Transaction>[][] = [];
    for (let i = 1; i < byDate.length; i++) {
      if (daysBetween(byDate[i - 1].date, byDate[i].date) <= windowDays) {
        cluster.push(byDate[i]);
      } else {
        clusters.push(cluster);
        cluster = [byDate[i]];
      }
    }
    clusters.push(cluster);

    for (const group of clusters) {
      if (group.length < 2) continue;
      const first = group[0];
      const describe = (): AmbiguousGroup => ({
        accountId: first.accountId,
        amount: Number(first.amount),
        currency: String(first.currency).toUpperCase(),
        ids: group.map((r) => r.id),
        dates: group.map((r) => r.date),
        reason: '',
      });
      if (group.length > 2) {
        // Only clusters that could plausibly HOLD a rename pair are worth a
        // human's time. Two filters, both load-bearing at windowDays 1:
        //
        //  - a cluster confined to one import batch cannot be a re-import of
        //    itself. Prod has hundreds of these — recurring weekly
        //    "TO FIND & SAVE" transfers of equal size on consecutive days;
        //  - a cluster in which no two rows could be each other's rename is
        //    just several distinct charges that collide on amount.
        //
        // Without these, 94 irrelevant clusters buried the 61 real pairs.
        const batches = new Set(group.map((r) => r.importBatch ?? ''));
        const couldRename = group.some((a, i) =>
          group.some(
            (b, j) => i !== j && a.importBatch !== b.importBatch && matchReasonFor(a, b) != null,
          ),
        );
        if (batches.size > 1 && couldRename) {
          report.ambiguous.push({
            ...describe(),
            reason:
              `${group.length} rows share (account, amount, currency) within ${windowDays} day(s); ` +
              'which is the duplicate of which cannot be settled automatically',
          });
        }
        continue;
      }
      // Order by write time — the duplicate is always the later-written row.
      const [keep, drop] = [...group].sort(
        (a, b) =>
          (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id,
      );
      if (keep.importBatch === drop.importBatch) continue; // one file; not a re-import
      const matchReason = matchReasonFor(keep, drop);
      if (matchReason == null) continue;

      const edited = humanEdited(drop);
      if (edited) {
        report.blocked.push({ dropId: drop.id, keepId: keep.id, reason: edited });
        continue;
      }
      const [receiptCount, orderLinkCount] = await Promise.all([
        Receipt.count({ where: { transactionId: drop.id }, transaction: opts.t }),
        TransactionOrderLink.count({ where: { transactionId: drop.id }, transaction: opts.t }),
      ]);
      if (receiptCount > 0) {
        report.blocked.push({
          dropId: drop.id,
          keepId: keep.id,
          reason: `${receiptCount} receipt(s) attached`,
        });
        continue;
      }
      if (orderLinkCount > 0) {
        report.blocked.push({
          dropId: drop.id,
          keepId: keep.id,
          reason: `${orderLinkCount} external-order link(s) attached`,
        });
        continue;
      }

      report.pairs.push({
        accountId: keep.accountId,
        amount: Number(keep.amount),
        currency: String(keep.currency).toUpperCase(),
        keepId: keep.id,
        keepBatch: keep.importBatch ?? null,
        keepDate: keep.date,
        keepMerchantRaw: keep.merchantRaw,
        dropId: drop.id,
        dropBatch: drop.importBatch ?? null,
        dropDate: drop.date,
        dropMerchantRaw: drop.merchantRaw,
        dateShiftDays: daysBetween(keep.date, drop.date),
        matchReason,
      });
    }
  }

  return report;
}

export type RemediationResult = {
  /** The classification the delete acted on, taken under the same lock. */
  report: RemediationReport;
  deletedIds: number[];
  deletedTransactions: number;
  /** Rows whose `linked_transaction_id` pointed at a deleted row and was nulled. */
  unlinkedTransactions: number;
  deletedReceipts: number;
  deletedAiSuggestions: number;
  deletedTransactionSignals: number;
  deletedTransactionTaxMetadata: number;
  deletedBudgetExclusions: number;
  unlinkedPlannedEvents: number;
};

/**
 * DESTRUCTIVE. Deletes the duplicate side of every pair
 * `classifyNarrativeRenameDuplicates` reports, and nothing else — ambiguous
 * clusters and blocked rows are left in place for a human.
 *
 * Deliberately a separate function rather than an `apply: true` flag on the
 * classifier: a caller cannot delete prod rows by mistyping an option.
 *
 * Idempotent. Once a duplicate is gone its group holds one row, so a second run
 * finds no pair and deletes nothing.
 */
export async function applyNarrativeRenameRemediation(
  opts: ClassifyOptions = {},
): Promise<RemediationResult> {
  return sequelize.transaction(async (t) => {
    const report = await classifyNarrativeRenameDuplicates({ ...opts, t });
    const deletedIds = report.pairs.map((p) => p.dropId);
    const empty: RemediationResult = {
      report,
      deletedIds: [],
      deletedTransactions: 0,
      unlinkedTransactions: 0,
      deletedReceipts: 0,
      deletedAiSuggestions: 0,
      deletedTransactionSignals: 0,
      deletedTransactionTaxMetadata: 0,
      deletedBudgetExclusions: 0,
      unlinkedPlannedEvents: 0,
    };
    if (deletedIds.length === 0) return empty;

    const idFilter = { transactionId: { [Op.in]: deletedIds } };

    // Inbound transfer links FIRST. The linker wired duplicates into transfer
    // pairs (18 of the 40 prod duplicates carry a linked_transaction_id), and a
    // surviving row pointing at a deleted one is a dangling reference that
    // would break transfer rendering. The kept row keeps its own links.
    const unlinkedTransactions = await Transaction.update(
      { linkedTransactionId: null },
      { where: { linkedTransactionId: { [Op.in]: deletedIds } }, transaction: t },
    ).then(([count]) => count);

    // Dependent rows, in the same order as executeRollback.
    const deletedReceipts = await Receipt.destroy({ where: idFilter, transaction: t });
    const deletedAiSuggestions = await AiSuggestion.destroy({ where: idFilter, transaction: t });
    const deletedTransactionSignals = await TransactionSignal.destroy({
      where: idFilter,
      transaction: t,
    });
    const deletedTransactionTaxMetadata = await TransactionTaxMetadata.destroy({
      where: idFilter,
      transaction: t,
    });
    const deletedBudgetExclusions = await BudgetExclusion.destroy({
      where: idFilter,
      transaction: t,
    });
    // PlannedEvents outlive transactions by design — unlink, never delete.
    const unlinkedPlannedEvents = await PlannedEvent.update(
      { linkedTransactionId: null },
      {
        where: { kind: 'planned', linkedTransactionId: { [Op.in]: deletedIds } },
        transaction: t,
      },
    ).then(([count]) => count);

    const deletedTransactions = await Transaction.destroy({
      where: { id: { [Op.in]: deletedIds } },
      transaction: t,
    });

    logger.warn(
      {
        deletedIds,
        deletedTransactions,
        unlinkedTransactions,
        ambiguousGroups: report.ambiguous.length,
        blockedRows: report.blocked.length,
        windowDays: opts.windowDays ?? 0,
      },
      'import_narrative_rename_remediation_applied',
    );

    return {
      report,
      deletedIds,
      deletedTransactions,
      unlinkedTransactions,
      deletedReceipts,
      deletedAiSuggestions,
      deletedTransactionSignals,
      deletedTransactionTaxMetadata,
      deletedBudgetExclusions,
      unlinkedPlannedEvents,
    };
  });
}

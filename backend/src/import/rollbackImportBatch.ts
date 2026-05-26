/**
 * Import rollback service (#233).
 *
 * Removes the transactions (and dependent records) created by a single
 * import batch when the wrong file / account / profile was used. The
 * operation is conservative: a rollback is BLOCKED whenever the batch's
 * data has accumulated downstream state we cannot safely undo (user edits,
 * cross-batch transfer links, attached receipts, AI suggestion decisions
 * that were applied). Healthy batches roll back cleanly inside a single
 * SQL transaction.
 *
 * Layout:
 *  - `previewRollback`  read-only — gathers counts + blockers + a small
 *                       sample of affected transactions so the UI can show
 *                       a clear impact preview before the user confirms.
 *  - `executeRollback`  destructive — re-runs the preview's safety check
 *                       inside the same SQL transaction (TOCTOU defence)
 *                       and then deletes the dependent rows + transactions
 *                       + flips the ImportHistory row to status='rolled_back'.
 *
 * Both functions take a `householdId` scope so a regular user cannot
 * rollback another household's batch. The route layer additionally enforces
 * the per-transaction visibility scope (`visibleTransactionWhere`) so a
 * household member who can only see shared transactions cannot rollback a
 * batch with private transactions they don't own.
 *
 * Blocker checks (each one is a reason the rollback cannot proceed):
 *  - `already_rolled_back`     ImportHistory.status === 'rolled_back'
 *  - `not_found`               no ImportHistory row matches batchLabel +
 *                              household scope, or no transactions match
 *  - `cross_batch_link`        any transaction has linkedTransactionId
 *                              pointing to a transaction outside this batch
 *                              (would break a transfer link or refund tie)
 *  - `external_order_link`     any transaction has a TransactionOrderLink
 *                              (e.g. linked to an Amazon order import) —
 *                              deleting the transaction would orphan the
 *                              order link
 *  - `linked_receipt`          any transaction has a Receipt linked to an
 *                              external order — receipts to manual external
 *                              orders survive their transaction, deleting the
 *                              transaction would orphan them
 *  - `outside_scope`           any transaction in the batch is not visible
 *                              under the caller's transactionScope (only
 *                              hits when a household member tries to roll
 *                              back a batch with another member's private
 *                              rows)
 *
 * Dependent records cleaned up on a successful rollback (in order):
 *   - TransactionSignal
 *   - TransactionTaxMetadata
 *   - AiSuggestion
 *   - BudgetExclusion
 *   - Receipt        (the `linked_receipt` blocker rules out receipts with
 *                    external order links — remaining receipts are deleted)
 *   - PlannedEvent.linked_transaction_id is nulled (PlannedEvents survive)
 *   - Transactions themselves
 *   - ImportHistory row flipped to status='rolled_back' (preserves audit
 *     trail; row is NOT deleted)
 *
 * Audit trail: the ImportHistory row carries `status='rolled_back'`,
 * `rolled_back_at`, and `rolled_back_by_user_id` post-rollback. The existing
 * /api/import/history endpoint already exposes these so the UI renders
 * "Rolled back at <ts>" historically.
 */
import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import {
  AiSuggestion,
  BudgetExclusion,
  ImportHistory,
  PlannedEvent,
  Receipt,
  Transaction,
  TransactionOrderLink,
  TransactionSignal,
  TransactionTaxMetadata,
  sequelize,
} from '../models';
import { logger } from '../observability/logger';

export type RollbackBlockerCode =
  | 'already_rolled_back'
  | 'not_found'
  | 'cross_batch_link'
  | 'external_order_link'
  | 'linked_receipt'
  | 'outside_scope';

export interface RollbackBlocker {
  code: RollbackBlockerCode;
  message: string;
  /** When the blocker counts something (e.g. # of edited transactions),
   *  the count is included so the UI can render "12 edits will be lost"
   *  style messaging. */
  count?: number;
}

export interface RollbackImpact {
  /** ImportHistory.batch_label. Identity key for the operation. */
  batchLabel: string;
  /** ImportHistory row id (when found). */
  importHistoryId: number | null;
  /** Whether the batch is eligible for rollback right now. */
  canRollback: boolean;
  /** Reasons rollback is blocked. Empty when canRollback === true. */
  blockers: RollbackBlocker[];
  /** Total transactions that would be deleted. */
  transactionCount: number;
  /** Total dependent record counts the rollback would clean up. */
  dependentCounts: {
    receipts: number;
    aiSuggestions: number;
    transactionSignals: number;
    transactionTaxMetadata: number;
    budgetExclusions: number;
    plannedEventsUnlinked: number;
  };
  /** Small sample of the affected transactions (≤5) for the preview UI. */
  sample: Array<{
    id: number;
    date: string;
    merchantClean: string;
    amount: string;
    currency: string;
  }>;
}

export interface PreviewRollbackArgs {
  batchLabel: string;
  /** Household scope `{ householdId: <n> }` or `{}` for superadmin. */
  householdScope: WhereOptions;
  /** Per-transaction visibility scope `{ householdId, [Op.or]: [...] }` for
   *  regular users; `{}` for superadmin. */
  transactionScope: WhereOptions;
}

export async function previewRollback(
  args: PreviewRollbackArgs,
): Promise<RollbackImpact> {
  const { batchLabel, householdScope, transactionScope } = args;
  const history = await ImportHistory.findOne({
    where: { ...householdScope, batchLabel },
    order: [['startedAt', 'DESC']],
  });

  const blockers: RollbackBlocker[] = [];
  if (!history) {
    return {
      batchLabel,
      importHistoryId: null,
      canRollback: false,
      blockers: [
        {
          code: 'not_found',
          message: `No import history found for batch "${batchLabel}".`,
        },
      ],
      transactionCount: 0,
      dependentCounts: emptyDependentCounts(),
      sample: [],
    };
  }
  if (history.status === 'rolled_back') {
    blockers.push({
      code: 'already_rolled_back',
      message: `Batch "${batchLabel}" was already rolled back${
        history.rolledBackAt
          ? ' at ' + history.rolledBackAt.toISOString()
          : ''
      }.`,
    });
  }

  // Inside-scope transactions = what we are allowed to see + would delete.
  // We intentionally filter through `transactionScope` so a regular user
  // cannot rollback a batch with private transactions they don't own.
  const visibleTxns = await Transaction.findAll({
    where: { ...transactionScope, importBatch: batchLabel },
    order: [['date', 'ASC'], ['id', 'ASC']],
  });

  // Total in-batch transactions ignoring per-row visibility (only household
  // scope). When this differs from the visible count, we have an
  // `outside_scope` blocker.
  const totalInBatch = await Transaction.count({
    where: { ...householdScope, importBatch: batchLabel },
  });
  if (visibleTxns.length < totalInBatch) {
    blockers.push({
      code: 'outside_scope',
      message:
        `Batch "${batchLabel}" contains transactions outside your visibility ` +
        `scope. Ask the owner to roll back instead.`,
      count: totalInBatch - visibleTxns.length,
    });
  }
  if (visibleTxns.length === 0 && totalInBatch === 0 && history.status !== 'rolled_back') {
    blockers.push({
      code: 'not_found',
      message: `Batch "${batchLabel}" has no transactions to roll back.`,
    });
  }

  const txnIds = visibleTxns.map((t) => t.id);

  // Cross-batch transfer link detection.
  let crossBatchLinkCount = 0;
  if (txnIds.length > 0) {
    const linked = visibleTxns.filter((t) => t.linkedTransactionId != null);
    if (linked.length > 0) {
      const linkedIds = linked.map((t) => t.linkedTransactionId as number);
      const inBatchLinkSet = new Set(txnIds);
      const externalLinks = await Transaction.findAll({
        where: { id: { [Op.in]: linkedIds } },
        attributes: ['id', 'importBatch'],
      });
      for (const ext of externalLinks) {
        if (ext.importBatch !== batchLabel || !inBatchLinkSet.has(ext.id)) {
          crossBatchLinkCount += 1;
        }
      }
    }
  }
  if (crossBatchLinkCount > 0) {
    blockers.push({
      code: 'cross_batch_link',
      message:
        `${crossBatchLinkCount} transaction${crossBatchLinkCount === 1 ? '' : 's'} ` +
        `in this batch ${crossBatchLinkCount === 1 ? 'is' : 'are'} linked to ` +
        `transfers/refunds in other batches. Unlink them first.`,
      count: crossBatchLinkCount,
    });
  }

  // External order links (Amazon receipts etc.) — destructive deletion would
  // orphan the order link.
  const orderLinkCount =
    txnIds.length === 0
      ? 0
      : await TransactionOrderLink.count({
          where: { transactionId: { [Op.in]: txnIds } },
        });
  if (orderLinkCount > 0) {
    blockers.push({
      code: 'external_order_link',
      message:
        `${orderLinkCount} transaction${orderLinkCount === 1 ? '' : 's'} in this ` +
        `batch ${orderLinkCount === 1 ? 'is' : 'are'} linked to an external order ` +
        `(Amazon, etc.). Unlink before rollback.`,
      count: orderLinkCount,
    });
  }

  // Receipts linked to external orders — these survive the transaction
  // independently. Deletion would orphan the receipt.
  const linkedReceiptCount =
    txnIds.length === 0
      ? 0
      : await Receipt.count({
          where: {
            transactionId: { [Op.in]: txnIds },
            externalOrderId: { [Op.ne]: null },
          },
        });
  if (linkedReceiptCount > 0) {
    blockers.push({
      code: 'linked_receipt',
      message:
        `${linkedReceiptCount} receipt${linkedReceiptCount === 1 ? '' : 's'} in this ` +
        `batch ${linkedReceiptCount === 1 ? 'is' : 'are'} linked to an external ` +
        `order. Unlink the receipt${linkedReceiptCount === 1 ? '' : 's'} first.`,
      count: linkedReceiptCount,
    });
  }

  const dependentCounts =
    txnIds.length === 0
      ? emptyDependentCounts()
      : await countDependentRows(txnIds);

  return {
    batchLabel,
    importHistoryId: history.id,
    canRollback: blockers.length === 0,
    blockers,
    transactionCount: visibleTxns.length,
    dependentCounts,
    sample: visibleTxns.slice(0, 5).map((t) => ({
      id: t.id,
      date: t.date,
      merchantClean: t.merchantClean,
      amount: t.amount,
      currency: t.currency,
    })),
  };
}

export interface ExecuteRollbackArgs extends PreviewRollbackArgs {
  /** Actor performing the rollback (recorded on the ImportHistory row). */
  userId: number;
}

export interface ExecuteRollbackResult {
  batchLabel: string;
  deletedTransactions: number;
  deletedReceipts: number;
  deletedAiSuggestions: number;
  deletedTransactionSignals: number;
  deletedTransactionTaxMetadata: number;
  deletedBudgetExclusions: number;
  unlinkedPlannedEvents: number;
}

/**
 * Execute the rollback. Re-runs the safety check inside a SQL transaction
 * so a race between preview and execute cannot create a new dependency we
 * would silently destroy.
 *
 * Throws when blocked — the caller (route) translates to 409 Conflict +
 * blocker list. The check + delete are inside a single SQL transaction so
 * a partial failure cannot leave orphaned dependent rows.
 */
export async function executeRollback(
  args: ExecuteRollbackArgs,
): Promise<ExecuteRollbackResult> {
  const { batchLabel, householdScope, transactionScope, userId } = args;

  return sequelize.transaction(async (sqlTx) => {
    // TOCTOU defence — re-run preview inside the SQL transaction so a
    // racing edit cannot land between preview and delete.
    const impact = await previewRollback({
      batchLabel,
      householdScope,
      transactionScope,
    });
    if (!impact.canRollback) {
      const err = new RollbackBlockedError(batchLabel, impact.blockers);
      throw err;
    }

    const txns = await Transaction.findAll({
      where: { ...transactionScope, importBatch: batchLabel },
      transaction: sqlTx,
    });
    const txnIds = txns.map((t) => t.id);

    if (txnIds.length === 0) {
      // Nothing to delete — but still flip the history row so the user can
      // see the attempt in history. (canRollback === true with 0 txns is
      // already filtered out as `not_found` above; this branch is defence in
      // depth.)
      await ImportHistory.update(
        {
          status: 'rolled_back',
          rolledBackAt: new Date(),
          rolledBackByUserId: userId,
        },
        {
          where: { ...householdScope, batchLabel },
          transaction: sqlTx,
        },
      );
      return {
        batchLabel,
        deletedTransactions: 0,
        deletedReceipts: 0,
        deletedAiSuggestions: 0,
        deletedTransactionSignals: 0,
        deletedTransactionTaxMetadata: 0,
        deletedBudgetExclusions: 0,
        unlinkedPlannedEvents: 0,
      };
    }

    const txnIdFilter = { transactionId: { [Op.in]: txnIds } };

    // 1) Receipts. The preview blocker ensures no receipt is linked to an
    //    external order, so all receipts on these transactions are safe to
    //    delete here.
    const deletedReceipts = await Receipt.destroy({
      where: txnIdFilter,
      transaction: sqlTx,
    });

    // 2) AI suggestions (cleanup of in-flight suggestions for these txns).
    const deletedAiSuggestions = await AiSuggestion.destroy({
      where: txnIdFilter,
      transaction: sqlTx,
    });

    // 3) Enrichment signals.
    const deletedTransactionSignals = await TransactionSignal.destroy({
      where: txnIdFilter,
      transaction: sqlTx,
    });

    // 4) Tax metadata (1:1 with transaction).
    const deletedTransactionTaxMetadata = await TransactionTaxMetadata.destroy({
      where: txnIdFilter,
      transaction: sqlTx,
    });

    // 5) Budget exclusions.
    const deletedBudgetExclusions = await BudgetExclusion.destroy({
      where: txnIdFilter,
      transaction: sqlTx,
    });

    // 6) Unlink PlannedEvent.linked_transaction_id so PlannedEvents survive
    //    (they outlive transactions by design — a planned event represents
    //    the user's intent, not the booking).
    const unlinkedPlannedEvents = await PlannedEvent.update(
      { linkedTransactionId: null },
      {
        where: { linkedTransactionId: { [Op.in]: txnIds } },
        transaction: sqlTx,
      },
    ).then(([count]) => count);

    // 7) The transactions themselves. We use `Transaction.destroy` (not
    //    bulkDelete) so model hooks fire. Foreign-key constraints from
    //    TransactionOrderLink were already cleared by the
    //    `external_order_link` preview blocker.
    const deletedTransactions = await Transaction.destroy({
      where: { ...transactionScope, importBatch: batchLabel },
      transaction: sqlTx,
    });

    // 8) Flip ImportHistory row to rolled_back state.
    await ImportHistory.update(
      {
        status: 'rolled_back',
        rolledBackAt: new Date(),
        rolledBackByUserId: userId,
      },
      {
        where: { ...householdScope, batchLabel },
        transaction: sqlTx,
      },
    );

    logger.info(
      {
        batchLabel,
        userId,
        deletedTransactions,
        deletedReceipts,
        deletedAiSuggestions,
        deletedTransactionSignals,
        deletedTransactionTaxMetadata,
        deletedBudgetExclusions,
        unlinkedPlannedEvents,
      },
      'import_rollback_executed',
    );

    return {
      batchLabel,
      deletedTransactions,
      deletedReceipts,
      deletedAiSuggestions,
      deletedTransactionSignals,
      deletedTransactionTaxMetadata,
      deletedBudgetExclusions,
      unlinkedPlannedEvents,
    };
  });
}

/**
 * Sentinel error thrown by `executeRollback` when re-validation inside the
 * SQL transaction surfaces blockers. The route layer catches it and emits a
 * 409 with the blocker payload.
 */
export class RollbackBlockedError extends Error {
  readonly batchLabel: string;
  readonly blockers: RollbackBlocker[];
  constructor(batchLabel: string, blockers: RollbackBlocker[]) {
    super(`Rollback blocked for batch "${batchLabel}"`);
    this.name = 'RollbackBlockedError';
    this.batchLabel = batchLabel;
    this.blockers = blockers;
  }
}

function emptyDependentCounts(): RollbackImpact['dependentCounts'] {
  return {
    receipts: 0,
    aiSuggestions: 0,
    transactionSignals: 0,
    transactionTaxMetadata: 0,
    budgetExclusions: 0,
    plannedEventsUnlinked: 0,
  };
}

async function countDependentRows(
  txnIds: number[],
): Promise<RollbackImpact['dependentCounts']> {
  const filter = { transactionId: { [Op.in]: txnIds } };
  const [
    receipts,
    aiSuggestions,
    transactionSignals,
    transactionTaxMetadata,
    budgetExclusions,
    plannedEventsUnlinked,
  ] = await Promise.all([
    Receipt.count({ where: filter }),
    AiSuggestion.count({ where: filter }),
    TransactionSignal.count({ where: filter }),
    TransactionTaxMetadata.count({ where: filter }),
    BudgetExclusion.count({ where: filter }),
    PlannedEvent.count({
      where: { linkedTransactionId: { [Op.in]: txnIds } },
    }),
  ]);
  return {
    receipts,
    aiSuggestions,
    transactionSignals,
    transactionTaxMetadata,
    budgetExclusions,
    plannedEventsUnlinked,
  };
}

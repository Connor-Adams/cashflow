/**
 * Apply a matched rule's non-scalar actions (issue #795) as DB side-effects at
 * transaction-persist time — the seam mirrors the orderLink upsert that runs in
 * the same savepoint after `txn.save`.
 *
 *   - `set_label` → attach the referenced household Label to the transaction via
 *     the TransactionLabel join. Idempotent (composite PK; conflict = no-op). A
 *     dangling labelId (label deleted since the rule was authored) is SKIPPED
 *     and logged, never fatal (AC #9).
 *   - `set_alert` → write a `Notification` row of type `rule_action_fired` to
 *     the rule's owner (createdByUserId). Written directly (with the ambient
 *     transaction) rather than via enqueueNotification so it's atomic with the
 *     txn insert and deterministic in tests; rule alerts are explicitly
 *     user-configured so per-type muting is not applied here.
 *
 * Best-effort and non-fatal as a whole: any failure is logged and swallowed so
 * a misconfigured action never aborts an import. Scalar effects
 * (category/business/split) are NOT handled here — they flow through the Signal
 * fields unchanged.
 */
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Label, TransactionLabel, Notification, Rule } from '../models';
import { logger } from '../observability/logger';
import { RULE_ACTION_FIRED_TYPE } from './actions';
import type { Signal } from '../import/enrichment/types';

export interface ApplyRuleSideEffectsInput {
  /** The ruleActions side-channel from the matched rule's Signal. */
  ruleActions: NonNullable<Signal['ruleActions']>;
  transactionId: number;
  householdId: number | null;
  transaction?: SequelizeTransaction;
  /**
   * Whether to fire `set_alert` notifications. Defaults to true (initial
   * import). The re-enrichment backfill passes false: labels are idempotent and
   * safe to re-apply, but re-firing alerts on every nightly re-run would spam
   * the user with notifications for transactions they've already seen.
   */
  applyAlerts?: boolean;
}

export async function applyRuleSideEffects(input: ApplyRuleSideEffectsInput): Promise<void> {
  const { ruleActions, transactionId, householdId, transaction } = input;
  const applyAlerts = input.applyAlerts ?? true;

  // --- set_label: attach labels (idempotent, dangling-safe) ---
  if (ruleActions.labelIds.length > 0) {
    // Only attach labels that still exist and (when scoped) belong to the
    // household. A dangling reference is skipped, not fatal.
    const labels = await Label.findAll({
      where: {
        id: ruleActions.labelIds,
        ...(householdId != null ? { householdId } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    const liveIds = new Set(labels.map((l) => l.id));
    for (const labelId of ruleActions.labelIds) {
      if (!liveIds.has(labelId)) {
        logger.warn(
          { module: 'rule-actions', ruleId: ruleActions.ruleId, labelId, transactionId },
          'rule_action_set_label_skipped_dangling',
        );
        continue;
      }
      try {
        // findOrCreate keeps it idempotent across re-enrichment without
        // relying on dialect-specific upsert semantics.
        await TransactionLabel.findOrCreate({
          where: { transactionId, labelId },
          defaults: { transactionId, labelId },
          transaction,
        });
      } catch (err) {
        logger.warn(
          { err, module: 'rule-actions', ruleId: ruleActions.ruleId, labelId, transactionId },
          'rule_action_set_label_failed',
        );
      }
    }
  }

  // --- set_alert: enqueue Notification(s) to the rule owner ---
  if (applyAlerts && ruleActions.alerts.length > 0) {
    const rule = await Rule.findByPk(ruleActions.ruleId, {
      attributes: ['id', 'createdByUserId', 'merchantPattern'],
      transaction,
    });
    const userId = rule?.createdByUserId ?? null;
    if (userId == null) {
      logger.warn(
        { module: 'rule-actions', ruleId: ruleActions.ruleId, transactionId },
        'rule_action_set_alert_skipped_no_owner',
      );
    } else {
      for (const alert of ruleActions.alerts) {
        try {
          await Notification.create(
            {
              userId,
              type: RULE_ACTION_FIRED_TYPE,
              severity: alert.severity,
              title: alert.title ?? `Rule matched: ${rule?.merchantPattern ?? ''}`.slice(0, 160),
              body: alert.body ?? `A transaction matched rule "${rule?.merchantPattern ?? ''}".`,
              dataJson: { ruleId: ruleActions.ruleId, transactionId },
            },
            { transaction },
          );
        } catch (err) {
          logger.warn(
            { err, module: 'rule-actions', ruleId: ruleActions.ruleId, transactionId },
            'rule_action_set_alert_failed',
          );
        }
      }
    }
  }
}

/** Find the rule-action side-channel in an enrichment signal list, if any. */
export function findRuleActionsSignal(signals: Signal[]): NonNullable<Signal['ruleActions']> | undefined {
  return signals.find((s) => s.ruleActions)?.ruleActions;
}

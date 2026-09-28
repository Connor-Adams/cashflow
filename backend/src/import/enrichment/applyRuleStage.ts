import { findBestRule, applyRuleToAuto, type RuleRow } from '../applyRules';
import type { Signal, TxnType } from './types';

export interface ApplyRuleInput {
  merchantClean: string;
  rules: RuleRow[];
  /** YYYY-MM-DD; used to filter rules by effective_from/effective_to. */
  txnDate: string;
}

export function runApplyRuleStage(input: ApplyRuleInput): Signal[] {
  const { rule, ambiguous } = findBestRule(input.rules, input.merchantClean, input.txnDate);
  if (!rule || ambiguous) return [];

  // Scalar effects (category/business/split) still flow through applyRuleToAuto
  // unchanged — the scalar columns remain authoritative, so this Signal's
  // fields are byte-for-byte what they were before #795 (AC #6).
  const auto = applyRuleToAuto(rule);

  // Collect the non-scalar actions (set_label / set_alert) as a side-channel
  // applied at persist time (mirrors the orderLink seam). set_category /
  // set_business / set_split are already folded into the scalar fields above,
  // so we don't double-apply them here.
  const labelIds: number[] = [];
  const alerts: NonNullable<Signal['ruleActions']>['alerts'] = [];
  // `set_txn_type` is NOT a side-channel action: txnType is a plain column on
  // `transactions` and already a first-class SignalFields key written by all
  // three persist paths, so it rides `fields` like autoCategory does. (Labels
  // and alerts need the side-channel because they write to other tables.)
  // validateActions has already constrained the payload to SETTABLE_TXN_TYPES,
  // which is the TxnType union spelled as strings.
  let txnType: TxnType | undefined;
  for (const a of rule.actions ?? []) {
    if (a.type === 'set_txn_type') txnType = a.payload.txnType as TxnType;
    else if (a.type === 'set_label') labelIds.push(a.payload.labelId);
    else if (a.type === 'set_alert') {
      alerts.push({
        severity: a.payload.severity,
        ...(a.payload.title != null ? { title: a.payload.title } : {}),
        ...(a.payload.body != null ? { body: a.payload.body } : {}),
      });
    }
  }

  const signal: Signal = {
    source: 'rule',
    confidence: 'high',
    fields: {
      autoCategory: auto.autoCategory,
      autoBusiness: auto.autoBusiness,
      autoSplitType: auto.autoSplitType,
      autoPctMe: auto.autoPctMe,
      autoPctPartner: auto.autoPctPartner,
      appliedRuleId: rule.id,
      // Only claim the field when the rule actually sets it — an absent key
      // lets the lower-precedence type-detect stage decide, which is what
      // every rule without this action should keep doing.
      ...(txnType != null ? { txnType } : {}),
    },
    rationale: `matched rule pattern "${rule.merchantPattern}"`,
  };
  if (labelIds.length > 0 || alerts.length > 0) {
    signal.ruleActions = { ruleId: rule.id, labelIds, alerts };
  }
  return [signal];
}

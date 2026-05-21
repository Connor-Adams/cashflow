import { findBestRule, applyRuleToAuto, type RuleRow } from '../applyRules';
import type { Signal } from './types';

export interface ApplyRuleInput {
  merchantClean: string;
  rules: RuleRow[];
}

export function runApplyRuleStage(input: ApplyRuleInput): Signal[] {
  const { rule, ambiguous } = findBestRule(input.rules, input.merchantClean);
  if (!rule || ambiguous) return [];

  const auto = applyRuleToAuto(rule);
  return [
    {
      source: 'rule',
      confidence: 'high',
      fields: {
        autoCategory: auto.autoCategory,
        autoBusiness: auto.autoBusiness,
        autoSplitType: auto.autoSplitType,
        autoPctMe: auto.autoPctMe,
        autoPctPartner: auto.autoPctPartner,
        appliedRuleId: rule.id,
      },
      rationale: `matched rule pattern "${rule.merchantPattern}"`,
    },
  ];
}

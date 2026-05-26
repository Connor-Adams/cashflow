/**
 * Pure helper that produces a structured per-field explanation of why a
 * transaction has its current category, split, business flag, notes, and
 * review state.
 *
 * Issue: #230 (feat: explain transaction categorization decisions).
 *
 * Design notes:
 *  - INPUT-ONLY. This function MUST NOT touch the database. The caller (the
 *    route handler) loads the transaction, the applied rule, the latest
 *    accepted AI suggestion, the enrichment signals, and (optionally) an
 *    actor lookup. Keeping it pure means we can unit-test every branch
 *    without spinning up Postgres, and the route stays a thin shell.
 *  - Per-field independence. Category, split, business, notes, and review
 *    are computed independently — overriding the category does NOT change
 *    the split's explanation. This mirrors how the underlying schema works
 *    (each field has its own auto_/override/final_ triple).
 *  - Override precedence. The DB's "final_*" column is the truth of what
 *    the user sees on the row. We re-derive the source string by looking at:
 *      1. Was there a manual override on this specific column? If yes, was
 *         the override value identical to a freshly-accepted AI suggestion?
 *         If yes → ai. Otherwise → manual.
 *      2. Otherwise, was the auto_* value set by a rule (autoSource='rule'
 *         and appliedRuleId loaded)? → rule.
 *      3. Otherwise, was the auto_* value set by some other enrichment
 *         source (memory, recurring, normalize-learned, …)? → import-default.
 *      4. Otherwise → fallback (legacy row, or no signal ever fired).
 *  - Safe fallback. Every field's `message` is human-readable English and
 *    never raises — the frontend can render the panel without conditional
 *    logic for missing data.
 */

export type ExplanationSource =
  | 'rule'
  | 'manual'
  | 'ai'
  | 'import-default'
  | 'fallback';

export interface AppliedRuleSummary {
  id: number;
  merchantPattern: string;
  category: string | null;
  splitType: string;
}

export interface AcceptedAiSuggestion {
  id: number;
  createdAt: Date;
  status: 'accepted' | 'edited';
  model: string | null;
  /**
   * Output JSON shape from suggestTransactionFields. We only use the fields
   * we care about; everything else is ignored.
   */
  output: {
    category?: string | null;
    business?: boolean | null;
    splitType?: string | null;
    pctMe?: number | string | null;
    pctPartner?: number | string | null;
    notes?: string | null;
  } | null;
}

export interface SignalSummary {
  source: string;
  confidence: string;
  fields: Record<string, unknown>;
  rationale: string | null;
}

export interface ActorSummary {
  id: number;
  displayName: string;
}

export type ActorLookup = (userId: number) => ActorSummary | null;

export interface ExplanationInputs {
  transaction: {
    id: number;
    createdByUserId: number | null;
    createdAt: Date;
    updatedAt: Date;
    appliedRuleId: number | null;
    autoSource: string | null;
    autoCategory: string | null;
    categoryOverride: string | null;
    finalCategory: string | null;
    autoBusiness: boolean | null;
    businessOverride: boolean | null;
    finalBusiness: boolean;
    autoSplitType: string | null;
    splitOverride: string | null;
    finalSplitType: string;
    autoPctMe: string | null;
    pctMeOverride: string | null;
    finalPctMe: string | null;
    autoPctPartner: string | null;
    pctPartnerOverride: string | null;
    finalPctPartner: string | null;
    notes: string | null;
    reviewFlag: boolean;
    reviewedAt: Date | null;
  };
  appliedRule: AppliedRuleSummary | null;
  latestAcceptedAiSuggestion: AcceptedAiSuggestion | null;
  signals: SignalSummary[];
  actorLookup: ActorLookup | null;
}

export interface ManualEdit {
  at: Date;
  actorUserId: number | null;
  actorDisplayName: string | null;
}

export interface AiSuggestionAttribution {
  id: number;
  createdAt: Date;
  status: 'accepted' | 'edited';
  model: string | null;
}

export interface AppliedRuleAttribution {
  id: number;
  merchantPattern: string;
  category: string | null;
}

interface FieldExplanationBase {
  source: ExplanationSource;
  message: string;
  /** Surfaces the auto_* value when relevant (rule winners and import defaults). */
  autoValue?: string | null;
  /** Surfaces the override value when an override was applied. */
  overrideValue?: string | null;
  appliedRule?: AppliedRuleAttribution;
  aiSuggestion?: AiSuggestionAttribution;
  manualEdit?: ManualEdit;
  /** When the source is import-default, the human-readable autoSource token. */
  autoSourceLabel?: string;
  /** When an import signal carried a rationale, surface it. */
  signalRationale?: string;
}

export interface CategoryExplanation extends FieldExplanationBase {
  value: string | null;
}

export interface SplitExplanation extends FieldExplanationBase {
  value: string;
}

export interface BusinessExplanation extends FieldExplanationBase {
  value: boolean;
}

export interface NotesExplanation {
  source: 'manual' | 'none';
  value: string | null;
  message: string;
  manualEdit?: ManualEdit;
}

export interface ReviewExplanation {
  state: 'cleared' | 'needs-review' | 'never-flagged';
  lastChangedAt: Date | null;
  message: string;
}

export interface TransactionExplanation {
  transactionId: number;
  category: CategoryExplanation;
  split: SplitExplanation;
  business: BusinessExplanation;
  notes: NotesExplanation;
  review: ReviewExplanation;
}

// --------- helpers --------------------------------------------------------

function manualEditFor(
  inputs: ExplanationInputs,
): ManualEdit {
  const actorId = inputs.transaction.createdByUserId;
  const lookup = inputs.actorLookup;
  const actor = actorId != null && lookup ? lookup(actorId) : null;
  return {
    at: inputs.transaction.updatedAt,
    actorUserId: actorId,
    actorDisplayName: actor?.displayName ?? null,
  };
}

function ruleAttr(rule: AppliedRuleSummary): AppliedRuleAttribution {
  return {
    id: rule.id,
    merchantPattern: rule.merchantPattern,
    category: rule.category,
  };
}

function aiAttr(s: AcceptedAiSuggestion): AiSuggestionAttribution {
  return {
    id: s.id,
    createdAt: s.createdAt,
    status: s.status,
    model: s.model,
  };
}

/**
 * Look up the most-recent import signal that fired for a given field. We
 * peek into TransactionSignal.fields for the named attribute (e.g.
 * 'autoCategory') and return the latest match.
 */
function latestSignalForField(
  signals: SignalSummary[],
  fieldName: string,
): SignalSummary | null {
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    if (Object.prototype.hasOwnProperty.call(signals[i].fields, fieldName)) {
      return signals[i];
    }
  }
  return null;
}

// --------- category -------------------------------------------------------

function explainCategory(inputs: ExplanationInputs): CategoryExplanation {
  const t = inputs.transaction;
  const value = t.finalCategory;
  const overrideValue = t.categoryOverride;
  const autoValue = t.autoCategory;
  const appliedRule = inputs.appliedRule;
  const ai = inputs.latestAcceptedAiSuggestion;
  const signal = latestSignalForField(inputs.signals, 'autoCategory');

  // Manual edit path. If override matches a recent accepted AI suggestion
  // category, attribute to AI instead — the user effectively endorsed AI.
  if (overrideValue != null) {
    const aiMatchedOverride =
      ai != null &&
      ai.output != null &&
      ai.output.category != null &&
      ai.output.category === overrideValue;
    if (aiMatchedOverride) {
      const out: CategoryExplanation = {
        source: 'ai',
        value,
        overrideValue,
        autoValue,
        aiSuggestion: aiAttr(ai!),
        message: `AI suggested "${overrideValue}" via ${ai!.model ?? 'model'} and you accepted it.`,
      };
      if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
      return out;
    }
    const edit = manualEditFor(inputs);
    const ruleNote = appliedRule
      ? ` (overriding rule "${appliedRule.merchantPattern}" → ${appliedRule.category ?? 'no category'}).`
      : '.';
    const actorTxt = edit.actorDisplayName ? ` by ${edit.actorDisplayName}` : '';
    const out: CategoryExplanation = {
      source: 'manual',
      value,
      overrideValue,
      autoValue,
      manualEdit: edit,
      message: `Manually set to "${overrideValue}"${actorTxt} on ${edit.at.toISOString().slice(0, 10)}${ruleNote}`,
    };
    if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
    return out;
  }

  // No override — derive from autoSource.
  // `autoSource='rule'` is the canonical signal a rule fired. We also treat
  // a loaded `appliedRule` (i.e. appliedRuleId != null) as a rule-source for
  // the category field when the rule actually set a category — even if
  // autoSource ended up 'composite' (rule + another signal merged). Without
  // this, category attribution would silently drop to fallback whenever
  // another signal (e.g. detect-recurring) joined the rule's pass.
  if (
    (t.autoSource === 'rule' || (appliedRule != null && appliedRule.category != null)) &&
    appliedRule
  ) {
    const cat = appliedRule.category ?? autoValue ?? value;
    return {
      source: 'rule',
      value,
      autoValue,
      appliedRule: ruleAttr(appliedRule),
      message: `Applied by rule "${appliedRule.merchantPattern}" → ${cat ?? 'no category'}.`,
    };
  }

  if (t.autoSource === 'ai' && ai != null && ai.output?.category != null) {
    return {
      source: 'ai',
      value,
      autoValue,
      aiSuggestion: aiAttr(ai),
      message: `AI categorised this transaction during enrichment via ${ai.model ?? 'model'}.`,
    };
  }

  if (t.autoSource != null && autoValue != null) {
    return {
      source: 'import-default',
      value,
      autoValue,
      autoSourceLabel: t.autoSource,
      signalRationale: signal?.rationale ?? undefined,
      message: signal?.rationale
        ? `Auto-categorised by import (${t.autoSource}): ${signal.rationale}`
        : `Auto-categorised by import (${t.autoSource}).`,
    };
  }

  return {
    source: 'fallback',
    value,
    message:
      value != null
        ? `Category is set but no source was recorded. Likely a legacy import predating enrichment tracking.`
        : `No category yet — this transaction is not yet categorised. Set one manually or accept an AI suggestion.`,
  };
}

// --------- split (split_type) --------------------------------------------

function explainSplit(inputs: ExplanationInputs): SplitExplanation {
  const t = inputs.transaction;
  const value = t.finalSplitType;
  const overrideValue = t.splitOverride;
  const autoValue = t.autoSplitType;
  const appliedRule = inputs.appliedRule;
  const ai = inputs.latestAcceptedAiSuggestion;

  if (overrideValue != null) {
    const aiMatched =
      ai != null &&
      ai.output != null &&
      ai.output.splitType != null &&
      ai.output.splitType === overrideValue;
    if (aiMatched) {
      const out: SplitExplanation = {
        source: 'ai',
        value,
        overrideValue,
        autoValue,
        aiSuggestion: aiAttr(ai!),
        message: `AI suggested split "${overrideValue}" via ${ai!.model ?? 'model'} and you accepted it.`,
      };
      if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
      return out;
    }
    const edit = manualEditFor(inputs);
    const actorTxt = edit.actorDisplayName ? ` by ${edit.actorDisplayName}` : '';
    const out: SplitExplanation = {
      source: 'manual',
      value,
      overrideValue,
      autoValue,
      manualEdit: edit,
      message: `Manually set to "${overrideValue}"${actorTxt} on ${edit.at.toISOString().slice(0, 10)}.`,
    };
    if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
    return out;
  }

  // See category comment: prefer autoSource='rule' but also accept a loaded
  // appliedRule as evidence the rule fired even if other signals composited.
  if ((t.autoSource === 'rule' || appliedRule != null) && appliedRule) {
    return {
      source: 'rule',
      value,
      autoValue,
      appliedRule: ruleAttr(appliedRule),
      message: `Applied by rule "${appliedRule.merchantPattern}" → ${appliedRule.splitType}.`,
    };
  }

  if (t.autoSource === 'ai' && ai != null && ai.output?.splitType != null) {
    return {
      source: 'ai',
      value,
      autoValue,
      aiSuggestion: aiAttr(ai),
      message: `AI assigned split during enrichment via ${ai.model ?? 'model'}.`,
    };
  }

  if (t.autoSource != null && autoValue != null) {
    return {
      source: 'import-default',
      value,
      autoValue,
      autoSourceLabel: t.autoSource,
      message: `Auto-split by import (${t.autoSource}).`,
    };
  }

  return {
    source: 'fallback',
    value,
    message: `Split type is the default "${value}" — no rule or manual edit set this. Legacy rows fall back to this default.`,
  };
}

// --------- business -------------------------------------------------------

function explainBusiness(inputs: ExplanationInputs): BusinessExplanation {
  const t = inputs.transaction;
  const value = t.finalBusiness;
  const overrideValue = t.businessOverride;
  const autoValue = t.autoBusiness;
  const appliedRule = inputs.appliedRule;
  const ai = inputs.latestAcceptedAiSuggestion;

  if (overrideValue != null) {
    const aiMatched =
      ai != null &&
      ai.output != null &&
      ai.output.business != null &&
      ai.output.business === overrideValue;
    if (aiMatched) {
      const out: BusinessExplanation = {
        source: 'ai',
        value,
        overrideValue: overrideValue ? 'true' : 'false',
        autoValue: autoValue == null ? null : autoValue ? 'true' : 'false',
        aiSuggestion: aiAttr(ai!),
        message: `AI marked this as ${overrideValue ? 'business' : 'personal'} and you accepted it.`,
      };
      if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
      return out;
    }
    const edit = manualEditFor(inputs);
    const actorTxt = edit.actorDisplayName ? ` by ${edit.actorDisplayName}` : '';
    const out: BusinessExplanation = {
      source: 'manual',
      value,
      overrideValue: overrideValue ? 'true' : 'false',
      autoValue: autoValue == null ? null : autoValue ? 'true' : 'false',
      manualEdit: edit,
      message: `Manually marked ${overrideValue ? 'business' : 'personal'}${actorTxt} on ${edit.at.toISOString().slice(0, 10)}.`,
    };
    if (appliedRule) out.appliedRule = ruleAttr(appliedRule);
    return out;
  }

  // See category comment: appliedRule alone (without autoSource='rule') is
  // still strong evidence a rule applied — we attribute it to the rule when
  // present.
  if ((t.autoSource === 'rule' || appliedRule != null) && appliedRule) {
    return {
      source: 'rule',
      value,
      autoValue: autoValue == null ? null : autoValue ? 'true' : 'false',
      appliedRule: ruleAttr(appliedRule),
      message: `Applied by rule "${appliedRule.merchantPattern}" — ${value ? 'business' : 'personal'}.`,
    };
  }

  if (t.autoSource === 'ai' && ai != null && ai.output?.business != null) {
    return {
      source: 'ai',
      value,
      autoValue: autoValue == null ? null : autoValue ? 'true' : 'false',
      aiSuggestion: aiAttr(ai),
      message: `AI assigned business flag during enrichment via ${ai.model ?? 'model'}.`,
    };
  }

  if (t.autoSource != null && autoValue != null) {
    return {
      source: 'import-default',
      value,
      autoValue: autoValue ? 'true' : 'false',
      autoSourceLabel: t.autoSource,
      message: `Auto-classified by import (${t.autoSource}).`,
    };
  }

  return {
    source: 'fallback',
    value,
    message: `Defaults to "personal" — no rule, AI, or manual edit has classified this transaction's business status.`,
  };
}

// --------- notes ----------------------------------------------------------

function explainNotes(inputs: ExplanationInputs): NotesExplanation {
  const t = inputs.transaction;
  if (t.notes != null && t.notes.length > 0) {
    const edit = manualEditFor(inputs);
    const actorTxt = edit.actorDisplayName ? ` by ${edit.actorDisplayName}` : '';
    return {
      source: 'manual',
      value: t.notes,
      manualEdit: edit,
      message: `Note added${actorTxt} on ${edit.at.toISOString().slice(0, 10)}.`,
    };
  }
  return {
    source: 'none',
    value: null,
    message: 'No notes attached.',
  };
}

// --------- review state --------------------------------------------------

function explainReview(inputs: ExplanationInputs): ReviewExplanation {
  const t = inputs.transaction;
  if (t.reviewFlag) {
    return {
      state: 'needs-review',
      lastChangedAt: t.reviewedAt,
      message: 'Flagged for review. Open the row and clear once verified.',
    };
  }
  if (t.reviewedAt != null) {
    return {
      state: 'cleared',
      lastChangedAt: t.reviewedAt,
      message: `Reviewed and cleared on ${t.reviewedAt.toISOString().slice(0, 10)}.`,
    };
  }
  return {
    state: 'never-flagged',
    lastChangedAt: null,
    message:
      'Never required review — enrichment was confident enough on import.',
  };
}

// --------- public API -----------------------------------------------------

export function buildTransactionExplanation(
  inputs: ExplanationInputs,
): TransactionExplanation {
  return {
    transactionId: inputs.transaction.id,
    category: explainCategory(inputs),
    split: explainSplit(inputs),
    business: explainBusiness(inputs),
    notes: explainNotes(inputs),
    review: explainReview(inputs),
  };
}

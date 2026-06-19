/**
 * Rule actions (issue #795) — generalize a Rule's fixed scalar effects
 * (category / business / split) into a composable, additive list so new effect
 * types are *data*, not new columns + pipeline edits.
 *
 * The scalar columns (`category`, `isBusiness`, `splitType`, `pctMe`,
 * `pctPartner`) stay authoritative-and-populated for backward compat: every
 * write derives them from the `set_category` / `set_business` / `set_split`
 * actions (and vice-versa when a legacy scalar-only body arrives). Anything that
 * reads the columns (`applyRuleToAuto`, `ruleToBackfillScope`, export mapping,
 * rule-health SQL) is therefore unaffected.
 *
 * Two new effect types ride on the actions list:
 *   - `set_label` — attach an existing household Label to the matched
 *     transaction via the TransactionLabel join (RETARGETED from the original
 *     "tag" proposal onto the existing Label system — issue #270's models).
 *   - `set_alert` — enqueue an in-app Notification when the rule fires.
 *
 * This module is the single source of truth for the action shape, validation,
 * and the scalar<->actions derivation; the route, the enrichment stage, and the
 * import/export paths all import from here. The forward migration replicates the
 * derivation in plain JS (it can't import TS) — keep the two in lockstep.
 */
import {
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TITLE_MAX_LENGTH,
  type NotificationSeverity,
} from '../models/Notification';

export const RULE_ACTION_TYPES = [
  'set_category',
  'set_business',
  'set_split',
  'set_label',
  'set_alert',
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

/** Action types that each may appear at most once on a rule (they map 1:1 to a
 * scalar column triplet). `set_label` and `set_alert` may repeat. */
export const SINGLETON_ACTION_TYPES: readonly RuleActionType[] = [
  'set_category',
  'set_business',
  'set_split',
];

export type SetCategoryAction = {
  type: 'set_category';
  payload: { category: string | null };
};
export type SetBusinessAction = {
  type: 'set_business';
  payload: { isBusiness: boolean };
};
export type SetSplitAction = {
  type: 'set_split';
  payload: { splitType: string; pctMe: string | null; pctPartner: string | null };
};
export type SetLabelAction = {
  type: 'set_label';
  payload: { labelId: number };
};
export type SetAlertAction = {
  type: 'set_alert';
  payload: { severity: NotificationSeverity; title?: string; body?: string };
};

export type RuleAction =
  | SetCategoryAction
  | SetBusinessAction
  | SetSplitAction
  | SetLabelAction
  | SetAlertAction;

/** The scalar effect columns that the actions list mirrors for back-compat. */
export interface RuleScalarEffects {
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
}

const VALID_SPLIT_TYPES = new Set(['me', 'partner', 'shared']);

/**
 * Build the `actions` array from a rule's scalar columns — the exact mapping
 * the forward migration uses. Pushed in a stable order so equality checks and
 * round-trips are deterministic:
 *   - `set_category` when `category` is non-null,
 *   - `set_business` when `isBusiness` is true,
 *   - `set_split` when `splitType` is anything other than the default `me`,
 *     OR a split percentage is set.
 */
export function deriveActionsFromScalars(s: RuleScalarEffects): RuleAction[] {
  const actions: RuleAction[] = [];
  if (s.category != null) {
    actions.push({ type: 'set_category', payload: { category: s.category } });
  }
  if (s.isBusiness) {
    actions.push({ type: 'set_business', payload: { isBusiness: true } });
  }
  const hasSplit = s.splitType !== 'me' || s.pctMe != null || s.pctPartner != null;
  if (hasSplit) {
    actions.push({
      type: 'set_split',
      payload: { splitType: s.splitType, pctMe: s.pctMe ?? null, pctPartner: s.pctPartner ?? null },
    });
  }
  return actions;
}

/**
 * Derive the scalar columns from an actions list — the inverse of
 * `deriveActionsFromScalars`. Effect types not present default to today's
 * baseline (no category, not business, `me` split). Repeated `set_label` /
 * `set_alert` actions don't affect scalars.
 */
export function deriveScalarsFromActions(actions: RuleAction[]): RuleScalarEffects {
  const out: RuleScalarEffects = {
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  };
  for (const a of actions) {
    if (a.type === 'set_category') out.category = a.payload.category ?? null;
    else if (a.type === 'set_business') out.isBusiness = Boolean(a.payload.isBusiness);
    else if (a.type === 'set_split') {
      out.splitType = a.payload.splitType;
      out.pctMe = a.payload.pctMe ?? null;
      out.pctPartner = a.payload.pctPartner ?? null;
    }
  }
  return out;
}

/** 400 error codes raised by action validation (route surfaces as { error }). */
export type ActionValidationError =
  | 'INVALID_ACTION_TYPE'
  | 'INVALID_SPLIT'
  | 'INVALID_TAG'
  | 'INVALID_ALERT'
  | 'DUPLICATE_ACTION';

export type ValidateActionsResult =
  | { ok: true; actions: RuleAction[] }
  | { ok: false; error: ActionValidationError; message: string; index: number };

/** Decimal-ish parse tolerant of string|number (DECIMAL round-trips as string). */
function toFraction(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate + normalize a raw `actions[]` body. `validLabelIds` is the set of
 * Label ids the caller's household owns — a `set_label` referencing an id
 * outside it is rejected (INVALID_TAG). Pass `null` to skip the label-scope
 * check (e.g. unit tests that only assert shape).
 *
 * Returns normalized actions on success; on failure, the first offending
 * action's index + the documented 400 code so the editor can attribute the
 * error to a row.
 */
export function validateActions(
  raw: unknown,
  validLabelIds: Set<number> | null,
): ValidateActionsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'INVALID_ACTION_TYPE', message: 'actions must be an array', index: -1 };
  }
  const out: RuleAction[] = [];
  const seenSingletons = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as { type?: unknown; payload?: unknown };
    if (!a || typeof a !== 'object') {
      return { ok: false, error: 'INVALID_ACTION_TYPE', message: 'action must be an object', index: i };
    }
    const type = a.type;
    if (typeof type !== 'string' || !(RULE_ACTION_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: 'INVALID_ACTION_TYPE', message: `unknown action type "${String(type)}"`, index: i };
    }
    const payload = (a.payload ?? {}) as Record<string, unknown>;

    if (SINGLETON_ACTION_TYPES.includes(type as RuleActionType)) {
      if (seenSingletons.has(type)) {
        return { ok: false, error: 'DUPLICATE_ACTION', message: `duplicate ${type}`, index: i };
      }
      seenSingletons.add(type);
    }

    switch (type as RuleActionType) {
      case 'set_category': {
        const c = payload.category;
        const category = c == null ? null : String(c);
        out.push({ type: 'set_category', payload: { category } });
        break;
      }
      case 'set_business': {
        out.push({ type: 'set_business', payload: { isBusiness: Boolean(payload.isBusiness) } });
        break;
      }
      case 'set_split': {
        const splitType = typeof payload.splitType === 'string' ? payload.splitType : '';
        if (!VALID_SPLIT_TYPES.has(splitType)) {
          return { ok: false, error: 'INVALID_SPLIT', message: `unknown splitType "${splitType}"`, index: i };
        }
        const pctMe = payload.pctMe != null ? String(payload.pctMe) : null;
        const pctPartner = payload.pctPartner != null ? String(payload.pctPartner) : null;
        const me = toFraction(pctMe);
        const partner = toFraction(pctPartner);
        if (me != null && partner != null && Math.abs(me + partner - 1) > 1e-6) {
          return { ok: false, error: 'INVALID_SPLIT', message: 'pctMe + pctPartner must sum to 1', index: i };
        }
        out.push({ type: 'set_split', payload: { splitType, pctMe, pctPartner } });
        break;
      }
      case 'set_label': {
        const labelId = Number(payload.labelId);
        if (!Number.isInteger(labelId) || labelId <= 0) {
          return { ok: false, error: 'INVALID_TAG', message: 'labelId must be a positive integer', index: i };
        }
        if (validLabelIds != null && !validLabelIds.has(labelId)) {
          return { ok: false, error: 'INVALID_TAG', message: `label ${labelId} not in household`, index: i };
        }
        out.push({ type: 'set_label', payload: { labelId } });
        break;
      }
      case 'set_alert': {
        const severity = payload.severity;
        if (typeof severity !== 'string' || !(NOTIFICATION_SEVERITIES as readonly string[]).includes(severity)) {
          return { ok: false, error: 'INVALID_ALERT', message: `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`, index: i };
        }
        const title = payload.title != null ? String(payload.title) : undefined;
        if (title != null && title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
          return { ok: false, error: 'INVALID_ALERT', message: `title exceeds ${NOTIFICATION_TITLE_MAX_LENGTH} chars`, index: i };
        }
        const body = payload.body != null ? String(payload.body) : undefined;
        out.push({
          type: 'set_alert',
          payload: { severity: severity as NotificationSeverity, ...(title != null ? { title } : {}), ...(body != null ? { body } : {}) },
        });
        break;
      }
    }
  }
  return { ok: true, actions: out };
}

/** Notification `type` written when a `set_alert` action fires. */
export const RULE_ACTION_FIRED_TYPE = 'rule_action_fired';

/**
 * Natural-language query intent schema + validator.
 *
 * Security boundary: the AI is UNTRUSTED. It produces a JSON envelope; this
 * module is the only thing standing between that envelope and the audited
 * query builders. Every field on every intent is checked against a known
 * whitelist; everything else is rejected with a clear error. We deliberately
 * never construct or interpolate SQL based on AI output anywhere downstream.
 *
 * To add a new intent:
 *   1. Add its name to {@link SUPPORTED_INTENTS}.
 *   2. Add a branch to the {@link QueryIntent} union.
 *   3. Add a validator branch in {@link validateIntent}.
 *   4. Add an executor branch in queryBuilders.ts that ONLY reads scoped data.
 *
 * Do NOT add a fall-through "raw" intent. Every supported field on every
 * supported intent must be explicit.
 */

export const SUPPORTED_INTENTS = [
  'transaction_summary',
  'transaction_search',
  'comparison',
  'subscription_increase_check',
  'partner_balance',
] as const;

export type SupportedIntentName = (typeof SUPPORTED_INTENTS)[number];

export const DATE_RANGE_PRESETS = [
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'all_time',
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const SCOPE_VALUES = ['personal', 'shared', 'business', 'all'] as const;
export type ScopeValue = (typeof SCOPE_VALUES)[number];

export const SUMMARY_GROUP_BYS = [
  'category',
  'merchant',
  'currency',
  'month',
  'split',
] as const;
export type SummaryGroupBy = (typeof SUMMARY_GROUP_BYS)[number];

/** Hard cap to avoid an AI shoving a megabyte into a string filter. */
const MAX_STR_LEN = 128;
/** Cap on windowMonths for the subscription-increase check. */
const MAX_WINDOW_MONTHS = 36;
const MIN_WINDOW_MONTHS = 1;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type CommonFilters = {
  category?: string;
  merchant?: string;
  currency?: string;
  scope?: ScopeValue;
  business?: boolean;
  dateRange?: DateRangePreset;
  dateFrom?: string;
  dateTo?: string;
};

type SearchFilters = CommonFilters & {
  missingReceipt?: boolean;
};

/** Discriminated union — every shape the validator can produce. */
export type QueryIntent =
  | {
      intent: 'transaction_summary';
      filters: CommonFilters;
      groupBy?: SummaryGroupBy;
    }
  | {
      intent: 'transaction_search';
      filters: SearchFilters;
    }
  | {
      intent: 'comparison';
      periodA: DateRangePreset;
      periodB: DateRangePreset;
      filters: CommonFilters;
    }
  | {
      intent: 'subscription_increase_check';
      windowMonths: number;
    }
  | {
      intent: 'partner_balance';
    };

export type ValidationResult =
  | { ok: true; intent: QueryIntent }
  | { ok: false; error: string };

const COMMON_FILTER_KEYS = new Set([
  'category',
  'merchant',
  'currency',
  'scope',
  'business',
  'dateRange',
  'dateFrom',
  'dateTo',
]);
const SEARCH_FILTER_KEYS = new Set([...COMMON_FILTER_KEYS, 'missingReceipt']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateStringField(
  value: unknown,
  field: string,
  maxLen = MAX_STR_LEN,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (trimmed.length > maxLen) {
    return { ok: false, error: `${field} must be ${maxLen} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

function validateCommonFilters(
  raw: unknown,
  allowedKeys: Set<string>,
  intentName: string,
): { ok: true; filters: SearchFilters } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, filters: {} };
  if (!isPlainObject(raw)) {
    return { ok: false, error: `filters must be an object on ${intentName}` };
  }
  const out: SearchFilters = {};
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        error: `unknown filter field "${key}" on intent ${intentName}`,
      };
    }
  }

  if ('category' in raw) {
    const r = validateStringField(raw.category, 'filters.category');
    if (!r.ok) return r;
    out.category = r.value;
  }
  if ('merchant' in raw) {
    const r = validateStringField(raw.merchant, 'filters.merchant');
    if (!r.ok) return r;
    out.merchant = r.value;
  }
  if ('currency' in raw) {
    const r = validateStringField(raw.currency, 'filters.currency', 8);
    if (!r.ok) return r;
    const cur = r.value.toUpperCase();
    if (cur.length !== 3) {
      return { ok: false, error: 'filters.currency must be a 3-letter ISO code' };
    }
    out.currency = cur;
  }
  if ('scope' in raw) {
    const scope = raw.scope;
    if (!(SCOPE_VALUES as readonly string[]).includes(String(scope))) {
      return {
        ok: false,
        error: `filters.scope must be one of: ${SCOPE_VALUES.join(', ')}`,
      };
    }
    out.scope = scope as ScopeValue;
  }
  if ('business' in raw) {
    if (typeof raw.business !== 'boolean') {
      return { ok: false, error: 'filters.business must be a boolean' };
    }
    out.business = raw.business;
  }
  if ('dateRange' in raw) {
    if (!(DATE_RANGE_PRESETS as readonly string[]).includes(String(raw.dateRange))) {
      return {
        ok: false,
        error: `filters.dateRange must be one of: ${DATE_RANGE_PRESETS.join(', ')}`,
      };
    }
    out.dateRange = raw.dateRange as DateRangePreset;
  }
  if ('dateFrom' in raw) {
    if (typeof raw.dateFrom !== 'string' || !ISO_DATE_RE.test(raw.dateFrom)) {
      return { ok: false, error: 'filters.dateFrom must be YYYY-MM-DD' };
    }
    const parsed = new Date(`${raw.dateFrom}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'filters.dateFrom is not a valid date' };
    }
    out.dateFrom = raw.dateFrom;
  }
  if ('dateTo' in raw) {
    if (typeof raw.dateTo !== 'string' || !ISO_DATE_RE.test(raw.dateTo)) {
      return { ok: false, error: 'filters.dateTo must be YYYY-MM-DD' };
    }
    const parsed = new Date(`${raw.dateTo}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'filters.dateTo is not a valid date' };
    }
    out.dateTo = raw.dateTo;
  }
  if ('missingReceipt' in raw && allowedKeys.has('missingReceipt')) {
    if (typeof raw.missingReceipt !== 'boolean') {
      return { ok: false, error: 'filters.missingReceipt must be a boolean' };
    }
    out.missingReceipt = raw.missingReceipt;
  }
  return { ok: true, filters: out };
}

function ensureNoUnknownTopLevel(
  raw: Record<string, unknown>,
  allowed: Set<string>,
): { ok: true } | { ok: false; error: string } {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `unknown field "${key}" on intent envelope` };
    }
  }
  return { ok: true };
}

/**
 * Validate an AI-emitted query intent envelope. Returns either a typed
 * {@link QueryIntent} (safe to dispatch to a query builder) or an error
 * message suitable for surfacing to the user.
 *
 * The validator is pure and synchronous so the route layer can run it without
 * any side effects and so we can unit-test every rejection path.
 */
export function validateIntent(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'intent payload must be an object' };
  }
  const intent = raw.intent;
  if (typeof intent !== 'string' || !intent) {
    return { ok: false, error: 'intent is required' };
  }
  if (!(SUPPORTED_INTENTS as readonly string[]).includes(intent)) {
    return {
      ok: false,
      error: `intent "${intent}" is not supported (supported: ${SUPPORTED_INTENTS.join(', ')})`,
    };
  }

  switch (intent as SupportedIntentName) {
    case 'transaction_summary': {
      const topAllowed = new Set(['intent', 'filters', 'groupBy']);
      const noUnknown = ensureNoUnknownTopLevel(raw, topAllowed);
      if (!noUnknown.ok) return noUnknown;
      const filtersR = validateCommonFilters(raw.filters, COMMON_FILTER_KEYS, intent);
      if (!filtersR.ok) return filtersR;
      let groupBy: SummaryGroupBy | undefined;
      if ('groupBy' in raw) {
        if (!(SUMMARY_GROUP_BYS as readonly string[]).includes(String(raw.groupBy))) {
          return {
            ok: false,
            error: `groupBy must be one of: ${SUMMARY_GROUP_BYS.join(', ')}`,
          };
        }
        groupBy = raw.groupBy as SummaryGroupBy;
      }
      return {
        ok: true,
        intent: {
          intent: 'transaction_summary',
          filters: filtersR.filters,
          ...(groupBy ? { groupBy } : {}),
        },
      };
    }
    case 'transaction_search': {
      const topAllowed = new Set(['intent', 'filters']);
      if ('groupBy' in raw) {
        return {
          ok: false,
          error: 'transaction_search does not support groupBy',
        };
      }
      const noUnknown = ensureNoUnknownTopLevel(raw, topAllowed);
      if (!noUnknown.ok) return noUnknown;
      const filtersR = validateCommonFilters(raw.filters, SEARCH_FILTER_KEYS, intent);
      if (!filtersR.ok) return filtersR;
      return {
        ok: true,
        intent: { intent: 'transaction_search', filters: filtersR.filters },
      };
    }
    case 'comparison': {
      const topAllowed = new Set(['intent', 'periodA', 'periodB', 'filters']);
      const noUnknown = ensureNoUnknownTopLevel(raw, topAllowed);
      if (!noUnknown.ok) return noUnknown;
      const periodA = raw.periodA;
      const periodB = raw.periodB;
      if (!(DATE_RANGE_PRESETS as readonly string[]).includes(String(periodA))) {
        return {
          ok: false,
          error: `periodA must be one of: ${DATE_RANGE_PRESETS.join(', ')}`,
        };
      }
      if (!(DATE_RANGE_PRESETS as readonly string[]).includes(String(periodB))) {
        return {
          ok: false,
          error: `periodB must be one of: ${DATE_RANGE_PRESETS.join(', ')}`,
        };
      }
      const filtersR = validateCommonFilters(raw.filters, COMMON_FILTER_KEYS, intent);
      if (!filtersR.ok) return filtersR;
      return {
        ok: true,
        intent: {
          intent: 'comparison',
          periodA: periodA as DateRangePreset,
          periodB: periodB as DateRangePreset,
          filters: filtersR.filters,
        },
      };
    }
    case 'subscription_increase_check': {
      const topAllowed = new Set(['intent', 'windowMonths']);
      const noUnknown = ensureNoUnknownTopLevel(raw, topAllowed);
      if (!noUnknown.ok) return noUnknown;
      const raw_w = raw.windowMonths;
      const w = typeof raw_w === 'number' ? raw_w : Number(raw_w);
      if (!Number.isInteger(w) || w < MIN_WINDOW_MONTHS || w > MAX_WINDOW_MONTHS) {
        return {
          ok: false,
          error: `windowMonths must be an integer between ${MIN_WINDOW_MONTHS} and ${MAX_WINDOW_MONTHS}`,
        };
      }
      return {
        ok: true,
        intent: { intent: 'subscription_increase_check', windowMonths: w },
      };
    }
    case 'partner_balance': {
      const topAllowed = new Set(['intent']);
      const noUnknown = ensureNoUnknownTopLevel(raw, topAllowed);
      if (!noUnknown.ok) return noUnknown;
      return { ok: true, intent: { intent: 'partner_balance' } };
    }
  }
}

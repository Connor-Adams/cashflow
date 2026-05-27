/**
 * parseSearchQuery — structured query parser for issue #235 (smart finance
 * search). Turns the user's typed string into a `SearchIntent` value object
 * that downstream layers (SQL builder + UI chip renderer) consume.
 *
 * Pure function: no req, no DB, no env. Easy to unit-test exhaustively.
 *
 * Supported tokens (case-insensitive keys, case-preserving values):
 *  - `merchant:<text>`          → substring match on merchantClean
 *  - `category:<name>`          → exact match on finalCategory
 *  - `amount:<op><value>`       → amount filter, where <op> is one of
 *                                 `>`, `<`, `>=`, `<=`, `=` (default `=`)
 *                                 `amount:>100`, `amount:<=50`, `amount:42`
 *  - `amount:<a>..<b>`          → inclusive range, e.g. `amount:10..50`
 *  - `date:<from>..<to>`        → inclusive ISO-date range, e.g.
 *                                 `date:2026-01-01..2026-03-31`. Either side
 *                                 may be omitted: `date:2026-01-01..` or
 *                                 `date:..2026-01-31`
 *  - `date:<iso-date>`          → exact day (from == to)
 *  - `has:receipt` / `no:receipt` → receipt presence filter
 *  - `review:yes` / `review:no`   → reviewFlag filter
 *  - `recurring:yes` / `recurring:no` → isRecurring filter
 *  - `scope:business|personal|partner|recurring` → scope filter (recurring
 *    is mapped to isRecurring=true for ergonomics; scope:business maps to
 *    finalBusiness=true; scope:personal maps to finalBusiness=false; partner
 *    maps to finalSplitType including the partner side — implemented as
 *    finalSplitType IN ('partner','shared')).
 *  - Anything else is collected as `freeText` (joined with spaces). Free
 *    text is OR-matched across merchantClean / notes / finalCategory.
 *
 * Quoted values: double quotes group whitespace into one value, e.g.
 *   `merchant:"Costco Wholesale"` → merchant = `Costco Wholesale`.
 *
 * Errors are NOT thrown — they're collected into `errors[]` so the route
 * layer can return a 200 with helpful feedback. Empty query returns an
 * intent with no filters set and `errors[]` empty.
 */

/** Comparison operator for an amount filter. */
export type AmountOp = '>' | '<' | '>=' | '<=' | '=';

export interface AmountFilter {
  /** Equality / inequality filter (single bound). */
  op?: AmountOp;
  value?: number;
  /** Closed range; both ends inclusive. Mutually exclusive with op/value. */
  min?: number;
  max?: number;
}

/** Receipt presence — present, absent, or unspecified. */
export type ReceiptFilter = 'has' | 'none' | undefined;

/** Boolean ternary — yes / no / unspecified. */
export type YesNoFilter = 'yes' | 'no' | undefined;

/** Scope filter. Matches a small finite set of business/personal lanes. */
export type ScopeFilter =
  | 'business'
  | 'personal'
  | 'partner'
  | 'recurring'
  | undefined;

export interface SearchIntent {
  merchant?: string;
  category?: string;
  amount?: AmountFilter;
  dateFrom?: string;
  dateTo?: string;
  hasReceipt?: ReceiptFilter;
  review?: YesNoFilter;
  recurring?: YesNoFilter;
  scope?: ScopeFilter;
  freeText?: string;
  errors: string[];
  /** True when no filters AND no free text were captured. Routes use this
   * to emit the "empty query" helper message instead of returning all
   * transactions. */
  isEmpty: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Splits the raw query into tokens, respecting double-quoted values. Returns
 * an array of strings such as `['merchant:Costco', 'category:"Food and Dining"']`.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      buf += c;
      continue;
    }
    if (!inQuotes && /\s/.test(c)) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/** Strip surrounding double quotes from a value, if any. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

function parseAmount(raw: string, errors: string[]): AmountFilter | undefined {
  // Range form: `10..50`, `..50`, `10..`
  if (raw.includes('..')) {
    const [a, b] = raw.split('..');
    const min = a === '' ? undefined : Number(a);
    const max = b === '' ? undefined : Number(b);
    if ((a !== '' && Number.isNaN(min)) || (b !== '' && Number.isNaN(max))) {
      errors.push(`Invalid amount range: "${raw}"`);
      return undefined;
    }
    if (min === undefined && max === undefined) {
      errors.push(`Invalid amount range: "${raw}"`);
      return undefined;
    }
    return { min, max };
  }
  // Single-bound form: `>100`, `<=50`, `=42`, `42`.
  const m = raw.match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    errors.push(`Invalid amount filter: "${raw}"`);
    return undefined;
  }
  const op = (m[1] ?? '=') as AmountOp;
  const value = Number(m[2]);
  if (Number.isNaN(value)) {
    errors.push(`Invalid amount value: "${raw}"`);
    return undefined;
  }
  return { op, value };
}

function parseDate(
  raw: string,
  errors: string[],
): { dateFrom?: string; dateTo?: string } | undefined {
  if (raw.includes('..')) {
    const [from, to] = raw.split('..');
    const f = from === '' ? undefined : from;
    const t = to === '' ? undefined : to;
    if (f !== undefined && !ISO_DATE.test(f)) {
      errors.push(`Invalid date: "${f}" (expected YYYY-MM-DD)`);
      return undefined;
    }
    if (t !== undefined && !ISO_DATE.test(t)) {
      errors.push(`Invalid date: "${t}" (expected YYYY-MM-DD)`);
      return undefined;
    }
    if (f === undefined && t === undefined) {
      errors.push(`Invalid date range: "${raw}"`);
      return undefined;
    }
    return { dateFrom: f, dateTo: t };
  }
  if (!ISO_DATE.test(raw)) {
    errors.push(`Invalid date: "${raw}" (expected YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD)`);
    return undefined;
  }
  return { dateFrom: raw, dateTo: raw };
}

/**
 * Parse a structured search query into a SearchIntent.
 *
 * Always returns an object — never throws. Unknown tokens collect into
 * freeText. Malformed values collect into errors[].
 */
export function parseSearchQuery(input: string | null | undefined): SearchIntent {
  const intent: SearchIntent = { errors: [], isEmpty: true };
  if (input == null) return intent;
  const trimmed = String(input).trim();
  if (trimmed.length === 0) return intent;

  const tokens = tokenize(trimmed);
  const freeBits: string[] = [];

  for (const tok of tokens) {
    const colonIdx = tok.indexOf(':');
    // Treat as free-text if no key:value structure, OR if the colon is
    // inside a quoted segment (treat as free text in that edge case).
    if (colonIdx <= 0) {
      freeBits.push(unquote(tok));
      continue;
    }
    const key = tok.slice(0, colonIdx).toLowerCase();
    const value = unquote(tok.slice(colonIdx + 1));
    if (value.length === 0) {
      intent.errors.push(`Missing value for "${key}:"`);
      continue;
    }

    switch (key) {
      case 'merchant': {
        intent.merchant = value;
        break;
      }
      case 'category': {
        intent.category = value;
        break;
      }
      case 'amount': {
        const a = parseAmount(value, intent.errors);
        if (a) intent.amount = a;
        break;
      }
      case 'date': {
        const d = parseDate(value, intent.errors);
        if (d) {
          intent.dateFrom = d.dateFrom;
          intent.dateTo = d.dateTo;
        }
        break;
      }
      case 'has': {
        if (value.toLowerCase() === 'receipt') intent.hasReceipt = 'has';
        else intent.errors.push(`Unknown has: "${value}" (try has:receipt)`);
        break;
      }
      case 'no': {
        if (value.toLowerCase() === 'receipt') intent.hasReceipt = 'none';
        else intent.errors.push(`Unknown no: "${value}" (try no:receipt)`);
        break;
      }
      case 'review': {
        const v = value.toLowerCase();
        if (v === 'yes' || v === 'true') intent.review = 'yes';
        else if (v === 'no' || v === 'false') intent.review = 'no';
        else intent.errors.push(`Unknown review: "${value}" (try review:yes|no)`);
        break;
      }
      case 'recurring': {
        const v = value.toLowerCase();
        if (v === 'yes' || v === 'true') intent.recurring = 'yes';
        else if (v === 'no' || v === 'false') intent.recurring = 'no';
        else intent.errors.push(`Unknown recurring: "${value}" (try recurring:yes|no)`);
        break;
      }
      case 'scope': {
        const v = value.toLowerCase();
        if (v === 'business' || v === 'personal' || v === 'partner' || v === 'recurring') {
          intent.scope = v;
        } else {
          intent.errors.push(`Unknown scope: "${value}" (try business|personal|partner|recurring)`);
        }
        break;
      }
      default: {
        // Unknown key:value → treat the WHOLE token as free text rather
        // than silently dropping the user's input.
        freeBits.push(unquote(tok));
      }
    }
  }

  if (freeBits.length > 0) {
    intent.freeText = freeBits.join(' ');
  }

  intent.isEmpty = !(
    intent.merchant ||
    intent.category ||
    intent.amount ||
    intent.dateFrom ||
    intent.dateTo ||
    intent.hasReceipt ||
    intent.review ||
    intent.recurring ||
    intent.scope ||
    intent.freeText
  );

  return intent;
}

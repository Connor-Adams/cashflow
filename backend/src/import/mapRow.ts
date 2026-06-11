import { normalizeMerchant } from './normalizeMerchant';
import {
  inferDateOrdering,
  parseDateFlexible,
  type DateOrdering,
} from './parseDateFlexible';
import {
  profiles,
  normalizeHeaderMap,
  pickColumn,
  type CsvProfile,
} from './csvProfiles';

type AmountDirection = 'debit' | 'credit';

const TYPE_DIRECTION_HEADERS = [
  'Type',
  'Transaction Type',
  'Activity Type',
  'Entry Type',
  'Record Type',
  'Credit/Debit',
  'Debit/Credit',
];

const NARRATIVE_DIRECTION_HEADERS = [
  'Description',
  'Merchant',
  'Payee',
  'Name',
  'Memo',
  'Details',
  'Transaction Details',
  'Original Transaction Details',
  'Statement Line',
  'Appears On Your Statement As',
  'Extended Details',
  'Simplified Details',
];

const TYPE_CREDIT_PATTERNS = [
  /\bcredit\b/,
  /\bcr\b/,
  /\bpayment\b/,
  /\brefund\b/,
  /\breturn(?:ed)?\b/,
  /\breversal\b/,
  /\bdeposit\b/,
];

const TYPE_DEBIT_PATTERNS = [
  /\bdebit\b/,
  /\bdr\b/,
  /\bpurchase\b/,
  /\bwithdrawal\b/,
  /\bfee\b/,
  /\bcharge\b/,
];

const NARRATIVE_CREDIT_PATTERNS = [
  /\bonline payment\b/,
  /\bpayment received\b/,
  /\bpayment thank you\b/,
  /\bautopay\b/,
  /\brefund\b/,
  /\breturn(?:ed)?\b/,
  /\breversal\b/,
  /\bstatement credit\b/,
  /\breward\b/,
  /\bcash ?back\b/,
  /\bdeposit\b/,
  /\btransfer in\b/,
];

const NARRATIVE_DEBIT_PATTERNS = [
  /\bpurchase\b/,
  /\bwithdrawal\b/,
  /\bfee\b/,
  /\bcharge\b/,
  /\btransfer out\b/,
];

const MERCHANT_FALLBACK_HEADERS = [
  'Type',
  'Transaction Type',
  'Activity Type',
  'Entry Type',
  'Record Type',
];

function normalizeSignalText(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchDirection(
  raw: unknown,
  creditPatterns: RegExp[],
  debitPatterns: RegExp[]
): AmountDirection | null {
  const text = normalizeSignalText(raw);
  if (!text) return null;
  if (creditPatterns.some((re) => re.test(text))) return 'credit';
  if (debitPatterns.some((re) => re.test(text))) return 'debit';
  return null;
}

function pickFirstNonEmptyColumnWithHeader(
  row: Record<string, string>,
  headerMap: Record<string, string>,
  candidates: string[]
): { value: string; header: string } | null {
  for (const candidate of candidates) {
    const value = pickColumn(row, headerMap, [candidate]);
    if (value != null && String(value).trim() !== '') {
      return { value, header: candidate };
    }
  }
  return null;
}

function pickFirstNonEmptyColumn(
  row: Record<string, string>,
  headerMap: Record<string, string>,
  candidates: string[]
): string | undefined {
  return pickFirstNonEmptyColumnWithHeader(row, headerMap, candidates)?.value;
}

/** Currency code embedded in an amount header name (e.g. 'USD$', 'Amount (USD)'). */
function currencyFromAmountHeader(header: string): string | null {
  const m = /\b(CAD|USD|GBP|EUR|AUD|NZD|CHF|JPY)\b/i.exec(header);
  return m ? m[1].toUpperCase() : null;
}

function inferAmountDirection(
  row: Record<string, string>,
  headerMap: Record<string, string>
): AmountDirection | null {
  for (const candidate of TYPE_DIRECTION_HEADERS) {
    const value = pickColumn(row, headerMap, [candidate]);
    const direction = matchDirection(
      value,
      TYPE_CREDIT_PATTERNS,
      TYPE_DEBIT_PATTERNS
    );
    if (direction) return direction;
  }

  for (const candidate of NARRATIVE_DIRECTION_HEADERS) {
    const value = pickColumn(row, headerMap, [candidate]);
    const direction = matchDirection(
      value,
      NARRATIVE_CREDIT_PATTERNS,
      NARRATIVE_DEBIT_PATTERNS
    );
    if (direction) return direction;
  }

  return null;
}

function parseRawNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim();
  // Accounting-style negative: '($10.00)' -> '-$10.00'.
  if (s.startsWith('(') && s.endsWith(')')) s = `-${s.slice(1, -1).trim()}`;
  // Currency prefix ('$', 'CA$', 'C$', 'US$'), preserving a leading minus.
  s = s.replace(/^(-?)(?:CA?|US?)?\$\s*/i, '$1');
  // European decimal comma ('12,34', '1.234,56') — detect before stripping
  // commas, which would otherwise read '12,34' as 1234 (100x). Mirrors
  // parseFxAmount in pdf/amex.ts. A trailing comma group of 1-2 digits can't
  // be a thousands group (those are exactly 3 digits).
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const europeanDecimal =
    lastComma !== -1 &&
    (lastDot !== -1 ? lastComma > lastDot : /,\d{1,2}$/.test(s));
  if (europeanDecimal) {
    s = s.replace(/\./g, '');
    const i = s.lastIndexOf(',');
    s = `${s.slice(0, i)}.${s.slice(i + 1)}`;
  } else {
    s = s.replace(/,/g, '');
  }
  if (s === '') return null;
  // Strict Number(), not parseFloat: partial parsing would silently drop
  // trailing text ('25.00 CR' -> 25) and corrupt the amount.
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Trailing CR/DR marker (statement-style exports), e.g. '25.00 CR'. */
const AMOUNT_DIRECTION_SUFFIX_RE = /^(.+?)\s*(CR|DR)\.?$/i;

function splitAmountDirectionSuffix(rawAmount: unknown): {
  amount: unknown;
  direction: AmountDirection | null;
} {
  if (typeof rawAmount !== 'string') {
    return { amount: rawAmount, direction: null };
  }
  const m = AMOUNT_DIRECTION_SUFFIX_RE.exec(rawAmount.trim());
  if (!m || parseRawNumber(m[1]) === null) {
    return { amount: rawAmount, direction: null };
  }
  return {
    amount: m[1],
    direction: m[2].toUpperCase() === 'CR' ? 'credit' : 'debit',
  };
}

function normalizeAmount(
  rawAmount: unknown,
  convention: CsvProfile['amountConvention'],
  direction: AmountDirection | null
): number | null {
  const { amount: rawValue, direction: suffixDirection } =
    splitAmountDirectionSuffix(rawAmount);
  const n = parseRawNumber(rawValue);
  if (n === null) return null;
  // An explicit CR/DR marker on the amount cell beats every other signal.
  if (suffixDirection === 'credit') return Math.abs(n);
  if (suffixDirection === 'debit') return -Math.abs(n);
  // passthrough — amount is already signed correctly in source; Type/narrative
  // heuristics must not override it (e.g. Type 'Card payment' on a chequing
  // export is an outflow, not a credit).
  if (convention === 'passthrough') return n;
  if (direction === 'credit') return Math.abs(n);
  if (direction === 'debit') return -Math.abs(n);
  if (convention === 'charges_negative') return n > 0 ? -Math.abs(n) : n;
  if (convention === 'charges_positive') return n < 0 ? Math.abs(n) : n;
  if (convention === 'invert_sign') return -n;
  return n;
}

/**
 * Resolve amount from split debit/credit columns.
 * Returns null if neither column has a non-zero value (treated as missing).
 */
function resolveSplitAmount(
  row: Record<string, string>,
  headerMap: Record<string, string>,
  debitHeaders: string[],
  creditHeaders: string[]
): number | null {
  const debitRaw = pickColumn(row, headerMap, debitHeaders);
  const creditRaw = pickColumn(row, headerMap, creditHeaders);
  const debit = parseRawNumber(debitRaw);
  const credit = parseRawNumber(creditRaw);
  if (debit != null && debit !== 0) return -Math.abs(debit);
  if (credit != null && credit !== 0) return Math.abs(credit);
  return null;
}

export type MappedRow =
  | { error: string }
  | {
      value: {
        date: string;
        merchantRaw: string;
        merchantClean: string;
        amount: number;
        currency: string;
        sourceReference: string | null;
      };
    };

/**
 * Infer one file-wide day/month ordering from the profile's date column so
 * an ambiguous dd/MM file ('15/03' rows prove the ordering for '03/04' rows)
 * parses consistently instead of falling back per row. Pass the result to
 * mapCsvRow's dateOrdering parameter.
 */
export function inferCsvDateOrdering(
  records: Record<string, string>[],
  headers: string[],
  profileId: string
): DateOrdering | null {
  const profile = profiles[profileId] ?? profiles.generic_simple;
  const headerMap = normalizeHeaderMap(headers);
  return inferDateOrdering(
    records.map((row) => pickColumn(row, headerMap, profile.dateHeaders))
  );
}

export function mapCsvRow(
  row: Record<string, string>,
  headers: string[],
  profileId: string,
  defaultCurrency: string,
  dateOrdering?: DateOrdering | null
): MappedRow {
  const profile = profiles[profileId] ?? profiles.generic_simple;
  const headerMap = normalizeHeaderMap(headers);

  const dateRaw = pickColumn(row, headerMap, profile.dateHeaders);
  const merchantRaw =
    pickFirstNonEmptyColumn(row, headerMap, profile.merchantHeaders) ??
    pickFirstNonEmptyColumn(row, headerMap, MERCHANT_FALLBACK_HEADERS);
  // Fall through empty amount cells: dual-currency exports (e.g. RBC's
  // CAD$/USD$) populate exactly one of the candidate columns per row.
  const amountPick = pickFirstNonEmptyColumnWithHeader(
    row,
    headerMap,
    profile.amountHeaders
  );
  const currencyRaw = pickColumn(row, headerMap, profile.currencyHeaders ?? []);
  const refRaw = pickColumn(row, headerMap, profile.referenceHeaders ?? []);

  const hasSplitColumns =
    (profile.debitAmountHeaders?.length ?? 0) > 0 ||
    (profile.creditAmountHeaders?.length ?? 0) > 0;
  const hasAmountRaw = amountPick != null;

  const missing =
    dateRaw == null ||
    String(dateRaw).trim() === '' ||
    merchantRaw == null ||
    String(merchantRaw).trim() === '' ||
    (!hasAmountRaw && !hasSplitColumns);
  if (missing) {
    return { error: 'Missing required columns' };
  }

  const parsedDate = parseDateFlexible(dateRaw, profile.dateFormat, dateOrdering);
  if (!parsedDate) {
    return { error: `Invalid date: ${dateRaw}` };
  }
  const y = parsedDate.getFullYear();
  const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
  const d = String(parsedDate.getDate()).padStart(2, '0');
  const dateOnly = `${y}-${m}-${d}`;

  // Split debit/credit columns take priority over single-column amount.
  let amount: number | null = null;
  let amountFromSingleColumn = false;
  if (hasSplitColumns) {
    amount = resolveSplitAmount(
      row,
      headerMap,
      profile.debitAmountHeaders ?? [],
      profile.creditAmountHeaders ?? []
    );
    // Fall back to single-column if split columns are both empty (e.g. balance-only row).
    if (amount === null && amountPick) {
      const dir = inferAmountDirection(row, headerMap);
      amount = normalizeAmount(amountPick.value, profile.amountConvention, dir);
      amountFromSingleColumn = amount != null;
    }
  } else {
    const dir = inferAmountDirection(row, headerMap);
    amount = normalizeAmount(amountPick?.value, profile.amountConvention, dir);
    amountFromSingleColumn = amount != null;
  }
  if (amount == null) {
    return { error: `Invalid amount: ${amountPick?.value ?? '(split columns)'}` };
  }

  const merchantClean = normalizeMerchant(merchantRaw);
  // When the file has no currency column, a currency embedded in the matched
  // amount header (e.g. RBC's USD$) labels the row better than the default.
  const headerCurrency =
    amountFromSingleColumn && amountPick
      ? currencyFromAmountHeader(amountPick.header)
      : null;
  const currency = (currencyRaw || headerCurrency || defaultCurrency || 'CAD')
    .toString()
    .trim()
    .toUpperCase()
    .slice(0, 3);

  return {
    value: {
      date: dateOnly,
      merchantRaw: String(merchantRaw),
      merchantClean,
      amount,
      currency,
      sourceReference: refRaw != null ? String(refRaw).trim() || null : null,
    },
  };
}

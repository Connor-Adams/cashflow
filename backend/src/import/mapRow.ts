import { normalizeMerchant } from './normalizeMerchant';
import { parseDateFlexible } from './parseDateFlexible';
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

function pickFirstNonEmptyColumn(
  row: Record<string, string>,
  headerMap: Record<string, string>,
  candidates: string[]
): string | undefined {
  for (const candidate of candidates) {
    const value = pickColumn(row, headerMap, [candidate]);
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
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

function normalizeAmount(
  rawAmount: unknown,
  convention: CsvProfile['amountConvention'],
  direction: AmountDirection | null
): number | null {
  if (rawAmount == null || rawAmount === '') return null;
  let s = String(rawAmount).replace(/,/g, '').trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = `-${s.slice(1, -1)}`;
  }
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  if (direction === 'credit') {
    return Math.abs(n);
  }
  if (direction === 'debit') {
    return -Math.abs(n);
  }
  if (convention === 'charges_negative') {
    if (n > 0) return -Math.abs(n);
    return n;
  }
  if (convention === 'charges_positive') {
    if (n < 0) return Math.abs(n);
    return n;
  }
  if (convention === 'invert_sign') {
    return -n;
  }
  return n;
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

export function mapCsvRow(
  row: Record<string, string>,
  headers: string[],
  profileId: string,
  defaultCurrency: string
): MappedRow {
  const profile = profiles[profileId] ?? profiles.generic_simple;
  const headerMap = normalizeHeaderMap(headers);

  const dateRaw = pickColumn(row, headerMap, profile.dateHeaders);
  const merchantRaw =
    pickFirstNonEmptyColumn(row, headerMap, profile.merchantHeaders) ??
    pickFirstNonEmptyColumn(row, headerMap, MERCHANT_FALLBACK_HEADERS);
  const amountRaw = pickColumn(row, headerMap, profile.amountHeaders);
  const currencyRaw = pickColumn(row, headerMap, profile.currencyHeaders ?? []);
  const refRaw = pickColumn(row, headerMap, profile.referenceHeaders ?? []);

  const missing =
    dateRaw == null ||
    String(dateRaw).trim() === '' ||
    merchantRaw == null ||
    String(merchantRaw).trim() === '' ||
    amountRaw == null ||
    String(amountRaw).trim() === '';
  if (missing) {
    return { error: 'Missing required columns' };
  }

  const parsedDate = parseDateFlexible(dateRaw, profile.dateFormat);
  if (!parsedDate) {
    return { error: `Invalid date: ${dateRaw}` };
  }
  const y = parsedDate.getFullYear();
  const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
  const d = String(parsedDate.getDate()).padStart(2, '0');
  const dateOnly = `${y}-${m}-${d}`;

  const amountDirection = inferAmountDirection(row, headerMap);
  const amount = normalizeAmount(
    amountRaw,
    profile.amountConvention,
    amountDirection
  );
  if (amount == null) {
    return { error: `Invalid amount: ${amountRaw}` };
  }

  const merchantClean = normalizeMerchant(merchantRaw);
  const currency = (currencyRaw || defaultCurrency || 'CAD')
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

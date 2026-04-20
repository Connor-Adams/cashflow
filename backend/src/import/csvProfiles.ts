export type AmountConvention =
  | 'charges_negative'
  | 'charges_positive'
  | 'invert_sign';

export interface CsvProfile {
  dateHeaders: string[];
  merchantHeaders: string[];
  amountHeaders: string[];
  currencyHeaders?: string[];
  referenceHeaders?: string[];
  dateFormat: string;
  amountConvention: AmountConvention;
}

const generic_amex: CsvProfile = {
  dateHeaders: [
    'Date',
    'Transaction Date',
    'TransactionDate',
    'Posted Date',
    'Process Date',
    'Date Processed',
    'Trans Date',
  ],
  merchantHeaders: [
    'Description',
    'Merchant',
    'Statement Line',
    'Appears On Your Statement As',
    'Extended Details',
    'Payee',
    'Details',
    'Category',
    'Simplified Details',
  ],
  amountHeaders: [
    'Amount',
    'Transaction Amount',
    'Charge Amount',
    'Amt',
    'Charge',
    'Charges',
    'Debit',
    'Spend',
    'Net Amount',
    'Amount (CAD)',
    'Amount (USD)',
    'Amount (GBP)',
  ],
  currencyHeaders: ['Currency', 'Currency Code', 'Txn Currency'],
  dateFormat: 'MM/dd/yyyy',
  // Amex exports commonly use positive charges and negative credits/payments.
  // Invert sign so charges become negative and credits/payments become positive.
  amountConvention: 'invert_sign',
};

/** Column names are matched case-insensitively against CSV headers. */
export const profiles: Record<string, CsvProfile> = {
  generic_simple: {
    dateHeaders: [
      'Date',
      'date',
      'Transaction Date',
      'Posted Date',
      'Posting Date',
      'Trans Date',
      'Purchase Date',
      'Activity Date',
      'Post Date',
    ],
    merchantHeaders: [
      'Description',
      'Merchant',
      'Payee',
      'Name',
      'Memo',
      'Details',
      'Transaction Details',
      'Original Transaction Details',
    ],
    amountHeaders: [
      'Amount',
      'amount',
      'Transaction Amount',
      'Amt',
      'Purchase Amount',
      'Debit',
    ],
    currencyHeaders: ['Currency', 'currency'],
    referenceHeaders: ['Reference', 'reference', 'Id'],
    dateFormat: 'yyyy-MM-dd',
    amountConvention: 'charges_negative',
  },
  generic_amex,
  amex: generic_amex,
};

const profileHints: Record<string, { label: string; hint: string }> = {
  generic_simple: {
    label: 'generic_simple',
    hint: 'ISO dates (yyyy-MM-dd); common bank exports.',
  },
  generic_amex: {
    label: 'generic_amex',
    hint: 'Amex-style columns; US date order (MM/dd/yyyy).',
  },
  amex: {
    label: 'amex',
    hint: 'Same mapping as generic_amex.',
  },
};

export type CsvProfileListEntry = {
  id: string;
  label: string;
  hint: string;
};

/** One entry per distinct profile definition (skips duplicate object refs, e.g. amex). */
export function listImportProfiles(): CsvProfileListEntry[] {
  const seen = new Set<CsvProfile>();
  const out: CsvProfileListEntry[] = [];
  const ids = Object.keys(profiles).sort((a, b) => {
    const da = profiles[a];
    const db = profiles[b];
    if (da === db) {
      if (a === 'generic_amex') return -1;
      if (b === 'generic_amex') return 1;
    }
    return a.localeCompare(b);
  });
  for (const id of ids) {
    const def = profiles[id];
    if (seen.has(def)) continue;
    seen.add(def);
    const meta = profileHints[id] ?? { label: id, hint: '' };
    out.push({ id, label: meta.label, hint: meta.hint });
  }
  return out;
}

/** Strip UTF-8 BOM so "Date" matches Excel/Numbers exports */
export function stripBom(s: string): string {
  return String(s).replace(/^\uFEFF/, '').trim();
}

export function normalizeHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const cleaned = stripBom(h);
    map[cleaned.toLowerCase()] = h;
  }
  return map;
}

export function pickColumn(
  row: Record<string, string>,
  headerMap: Record<string, string>,
  candidates: string[]
): string | undefined {
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (headerMap[key] !== undefined) {
      const orig = headerMap[key];
      return row[orig];
    }
  }
  return undefined;
}

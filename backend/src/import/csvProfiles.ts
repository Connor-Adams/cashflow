export type AmountConvention =
  | 'charges_negative'
  | 'charges_positive'
  | 'invert_sign'
  /** Amount is already signed correctly (negative = charge, positive = credit). No transformation. */
  | 'passthrough';

export interface CsvProfile {
  dateHeaders: string[];
  merchantHeaders: string[];
  /** Single-column amount. Leave empty when using debitAmountHeaders + creditAmountHeaders. */
  amountHeaders: string[];
  /** Two-column format: this column holds the withdrawal/charge amount (always positive in source). */
  debitAmountHeaders?: string[];
  /** Two-column format: this column holds the deposit/credit amount (always positive in source). */
  creditAmountHeaders?: string[];
  currencyHeaders?: string[];
  referenceHeaders?: string[];
  accountNumberHeaders?: string[];
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
  // Amex CSVs include a `Reference Number` column populated for cleared
  // transactions (e.g. AT26053000600001…). The column is blank while a
  // transaction is in the ~30-day pending window, then flips to the
  // assigned reference on re-download. Mapping it here surfaces it on the
  // Transaction row; dedup keys off `sourceIdentityFingerprint` (which
  // excludes sourceReference) so the NULL→populated flip no longer breaks
  // re-imports.
  referenceHeaders: ['Reference Number', 'Reference'],
  dateFormat: 'MM/dd/yyyy',
  // Amex exports commonly use positive charges and negative credits/payments.
  // Invert sign so charges become negative and credits/payments become positive.
  amountConvention: 'invert_sign',
};

// ── Canadian bank profiles ────────────────────────────────────────────────────

/**
 * RBC (Royal Bank of Canada) — credit card and personal banking.
 * Export: Account Type, Account Number, Transaction Date, Cheque Number,
 *         Description 1, Description 2, CAD$, USD$
 * Positive CAD$ = charge; negative = payment/credit → invert_sign.
 */
const rbc: CsvProfile = {
  dateHeaders: ['Transaction Date'],
  merchantHeaders: ['Description 1', 'Description 2'],
  amountHeaders: ['CAD$', 'USD$'],
  referenceHeaders: ['Cheque Number'],
  accountNumberHeaders: ['Account Number'],
  dateFormat: 'M/d/yyyy',
  amountConvention: 'invert_sign',
};

/**
 * RBC personal banking (chequing/savings). Identical column layout to the `rbc`
 * credit-card profile (Description 1/2, CAD$), but the CAD$ column is already
 * signed (negative = withdrawal/debit, positive = deposit/credit), so it must
 * NOT be inverted — using `rbc` here flips every sign. Auto-detect picks between
 * the two via the "Account Type" column (see inferProfile.ts).
 */
const rbc_banking: CsvProfile = {
  dateHeaders: ['Transaction Date'],
  merchantHeaders: ['Description 1', 'Description 2'],
  amountHeaders: ['CAD$', 'USD$'],
  referenceHeaders: ['Cheque Number'],
  accountNumberHeaders: ['Account Number'],
  dateFormat: 'M/d/yyyy',
  amountConvention: 'passthrough',
};

/**
 * TD Bank credit card (newer format).
 * Export: Transaction Date, Posting Date, Effective Date, Transaction Type,
 *         Amount, Payee
 * Transaction Type = "DEBIT" or "CREDIT"; Amount always positive.
 * Direction inference from Transaction Type handles sign; convention is fallback.
 */
const td_credit_card: CsvProfile = {
  dateHeaders: ['Transaction Date', 'Date'],
  merchantHeaders: ['Payee', 'Description'],
  amountHeaders: ['Amount'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'charges_negative',
};

/**
 * TD Bank personal banking (chequing/savings).
 * Export: Date, Activity Description, Debit Amount, Credit Amount, Balance
 * Two-column split: Debit Amount = withdrawals, Credit Amount = deposits.
 */
const td_banking: CsvProfile = {
  dateHeaders: ['Date', 'Settlement Date'],
  merchantHeaders: ['Activity Description', 'Description'],
  amountHeaders: [],
  debitAmountHeaders: ['Debit Amount', 'Debit'],
  creditAmountHeaders: ['Credit Amount', 'Credit'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'charges_negative',
};

/**
 * Scotiabank credit card.
 * Export: Date, Transaction Details, Amount, Balance
 * Positive Amount = charge; negative = payment → invert_sign.
 */
const scotiabank_credit_card: CsvProfile = {
  dateHeaders: ['Date'],
  merchantHeaders: ['Transaction Details', 'Description', 'Name'],
  amountHeaders: ['Amount'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'invert_sign',
};

/**
 * Scotiabank personal banking.
 * Export: Date, Description, Withdrawals, Deposits, Balance
 * Two-column split.
 */
const scotiabank_banking: CsvProfile = {
  dateHeaders: ['Date'],
  merchantHeaders: ['Description', 'Name'],
  amountHeaders: [],
  debitAmountHeaders: ['Withdrawals', 'Withdrawal'],
  creditAmountHeaders: ['Deposits', 'Deposit'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'charges_negative',
};

/**
 * BMO (Bank of Montreal) credit card.
 * Export: Item #, Card #, Transaction Date, Posting Date, Transaction Amount,
 *         Description
 * Positive Transaction Amount = charge; negative = credit → invert_sign.
 */
const bmo_credit_card: CsvProfile = {
  dateHeaders: ['Transaction Date'],
  merchantHeaders: ['Description'],
  amountHeaders: ['Transaction Amount'],
  referenceHeaders: ['Item #'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'invert_sign',
};

/**
 * BMO personal banking.
 * Export: Date, Description, Withdrawl, Deposit, Balance
 * Note: BMO has a persistent typo — "Withdrawl" not "Withdrawal".
 * Two-column split.
 */
const bmo_banking: CsvProfile = {
  dateHeaders: ['Date'],
  merchantHeaders: ['Description'],
  amountHeaders: [],
  debitAmountHeaders: ['Withdrawl', 'Withdrawal', 'Withdrawals'],
  creditAmountHeaders: ['Deposit', 'Deposits'],
  referenceHeaders: ['Cheque Number'],
  dateFormat: 'yyyy-MM-dd',
  amountConvention: 'charges_negative',
};

/**
 * CIBC (Canadian Imperial Bank of Commerce) — credit card and banking.
 * Export: Date, Description, Debit, Credit
 * Debit column = charges/withdrawals; Credit column = payments/deposits.
 * Both columns use positive values.
 */
const cibc: CsvProfile = {
  dateHeaders: ['Date'],
  merchantHeaders: ['Description'],
  amountHeaders: [],
  debitAmountHeaders: ['Debit'],
  creditAmountHeaders: ['Credit'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'charges_negative',
};

/**
 * Tangerine (personal banking and credit card).
 * Export: Date, Transaction, Name, Memo, Amount
 * Amount is pre-signed: negative = charge/withdrawal, positive = deposit/credit.
 * Passthrough preserves the source sign (direction heuristics never override
 * pre-signed amounts).
 */
const tangerine: CsvProfile = {
  dateHeaders: ['Date'],
  merchantHeaders: ['Name', 'Memo', 'Transaction'],
  amountHeaders: ['Amount'],
  dateFormat: 'MM/dd/yyyy',
  amountConvention: 'passthrough',
};

/**
 * EQ Bank (savings and GIC accounts).
 * Export: Date, Description, Amount  (or Debit/Credit)
 * Amount pre-signed like Tangerine.
 */
const eq_bank: CsvProfile = {
  dateHeaders: ['Date', 'Effective Date', 'Transaction Date'],
  merchantHeaders: ['Description', 'Memo'],
  amountHeaders: ['Amount'],
  dateFormat: 'yyyy-MM-dd',
  amountConvention: 'passthrough',
};

/**
 * National Bank of Canada.
 * Export: Date de transaction, Description, Débit, Crédit  (French headers)
 *         or: Transaction Date, Description, Debit, Credit  (English)
 * Two-column split.
 */
const national_bank: CsvProfile = {
  dateHeaders: ['Date de transaction', 'Transaction Date', 'Date'],
  merchantHeaders: ['Description'],
  amountHeaders: [],
  debitAmountHeaders: ['Débit', 'Debit'],
  creditAmountHeaders: ['Crédit', 'Credit'],
  dateFormat: 'yyyy-MM-dd',
  amountConvention: 'charges_negative',
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wealthsimple monthly statement CSVs (Cash, Save, Save for Business, TFSA,
 * FHSA, Corporate Investing). Header layout:
 *   date,transaction,description,amount,balance,currency
 * The `amount` column is already signed: negative = outflow, positive = inflow
 * (interest received, deposits, dividends). Use passthrough so positive
 * narratives like "Interest received"/"Interest earned" stay positive even
 * when the generic narrative-direction patterns don't match.
 */
const wealthsimple_cash: CsvProfile = {
  dateHeaders: ['date', 'Date'],
  merchantHeaders: ['description', 'Description'],
  amountHeaders: ['amount', 'Amount'],
  currencyHeaders: ['currency', 'Currency'],
  dateFormat: 'yyyy-MM-dd',
  amountConvention: 'passthrough',
};

/** Column names are matched case-insensitively against CSV headers. */
export const profiles: Record<string, CsvProfile> = {
  // Generic fallbacks
  generic_passthrough: {
    dateHeaders: [
      'Date', 'Transaction Date', 'Posted Date', 'Trans Date', 'Activity Date',
    ],
    merchantHeaders: [
      'Description', 'Merchant', 'Payee', 'Name', 'Memo', 'Details', 'Type',
    ],
    amountHeaders: ['Amount', 'amount', 'Net Amount', 'Transaction Amount'],
    currencyHeaders: ['Currency', 'currency'],
    referenceHeaders: ['Reference', 'Id', 'id'],
    dateFormat: 'yyyy-MM-dd',
    // Amount already signed: negative = charge/withdrawal, positive = deposit/credit.
    amountConvention: 'passthrough',
  },
  generic_simple: {
    dateHeaders: [
      'Date',
      'date',
      'transaction_date',
      'Transaction Date',
      'transaction date',
      'Posted Date',
      'posted_date',
      'Posting Date',
      'Trans Date',
      'Purchase Date',
      'Activity Date',
      'Post Date',
    ],
    merchantHeaders: [
      'Description',
      'description',
      'Merchant',
      'Payee',
      'Name',
      'Memo',
      'Details',
      'details',
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
    referenceHeaders: ['Reference', 'reference', 'Id', 'id'],
    dateFormat: 'yyyy-MM-dd',
    amountConvention: 'charges_negative',
  },
  generic_amex,
  amex: generic_amex,
  wealthsimple_cash,
  // Canadian banks
  rbc,
  rbc_banking,
  td_credit_card,
  td_banking,
  scotiabank_credit_card,
  scotiabank_banking,
  bmo_credit_card,
  bmo_banking,
  cibc,
  tangerine,
  eq_bank,
  national_bank,
};

const profileHints: Record<string, { label: string; hint: string }> = {
  generic_passthrough: {
    label: 'Generic (pre-signed)',
    hint: 'yyyy-MM-dd dates; Amount already signed — negative = charge, positive = deposit. Use for Wealthsimple Cash and similar.',
  },
  generic_simple: {
    label: 'Generic (ISO dates)',
    hint: 'yyyy-MM-dd dates; single Amount column, positive = charge (credits detected from description). For pre-signed files use Generic (pre-signed).',
  },
  generic_amex: {
    label: 'Generic (Amex-style)',
    hint: 'MM/dd/yyyy dates; positive = charge.',
  },
  amex: {
    label: 'Amex',
    hint: 'Same as generic_amex.',
  },
  wealthsimple_cash: {
    label: 'Wealthsimple — Cash & Investing',
    hint: 'Monthly statement CSV (date,transaction,description,amount,balance,currency). Amount pre-signed — positive = inflow.',
  },
  rbc: {
    label: 'RBC — Credit Card',
    hint: 'RBC credit cards (e.g. Avion). Columns: Description 1/2, CAD$ — positive = charge.',
  },
  rbc_banking: {
    label: 'RBC — Banking',
    hint: 'RBC chequing/savings. Columns: Description 1/2, CAD$ — already signed (negative = withdrawal).',
  },
  td_credit_card: {
    label: 'TD — Credit Card',
    hint: 'Columns: Transaction Type, Amount, Payee.',
  },
  td_banking: {
    label: 'TD — Banking',
    hint: 'Chequing/savings. Split Debit Amount / Credit Amount columns.',
  },
  scotiabank_credit_card: {
    label: 'Scotiabank — Credit Card',
    hint: 'Column: Transaction Details, Amount.',
  },
  scotiabank_banking: {
    label: 'Scotiabank — Banking',
    hint: 'Chequing/savings. Split Withdrawals / Deposits columns.',
  },
  bmo_credit_card: {
    label: 'BMO — Credit Card',
    hint: 'Columns: Item #, Card #, Transaction Amount.',
  },
  bmo_banking: {
    label: 'BMO — Banking',
    hint: 'Chequing/savings. Split Withdrawl / Deposit columns (BMO typo preserved).',
  },
  cibc: {
    label: 'CIBC',
    hint: 'Credit card & banking. Split Debit / Credit columns.',
  },
  tangerine: {
    label: 'Tangerine',
    hint: 'Columns: Transaction, Name, Memo, Amount. Amount pre-signed.',
  },
  eq_bank: {
    label: 'EQ Bank',
    hint: 'Savings accounts. Single Amount column, pre-signed.',
  },
  national_bank: {
    label: 'National Bank',
    hint: 'Split Débit / Crédit columns (French or English headers).',
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

export function extractAccountNumber(
  records: Record<string, string>[],
  headers: string[],
  profile: CsvProfile
): string | null {
  if (!profile.accountNumberHeaders || profile.accountNumberHeaders.length === 0) {
    return null;
  }

  const headerMap = normalizeHeaderMap(headers);

  // Scan first 10 rows for first non-empty account number
  for (let i = 0; i < Math.min(10, records.length); i++) {
    const value = pickColumn(records[i], headerMap, profile.accountNumberHeaders);
    if (value && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

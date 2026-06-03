import type { AccountType } from '@cashflow/shared';

/**
 * Account types whose statement lines plausibly carry a person-to-person
 * counterparty. Out-of-scope types (credit_card, loan, investment) always
 * return null even when the line contains a recognizable name — credit
 * card "merchant TO YOU" boilerplate and investment "ACME INC dividend"
 * lines would otherwise produce noisy false positives.
 */
const IN_SCOPE_ACCOUNT_TYPES = new Set<AccountType>([
  'checking',
  'savings',
  'cash',
]);

export type CounterpartyKind = 'person' | 'payroll';
export type ExtractedCounterparty = { name: string; kind: CounterpartyKind };

const PATTERNS: { re: RegExp; kind: CounterpartyKind }[] = [
  // Interac e-transfer with explicit FROM/TO.
  { re: /\b(?:INTERAC\s+)?(?:E-?TFR|E-?TRANSFER)\s+(?:FROM|TO|FRM)\s+(.+)/i, kind: 'person' },
  // RBC SEND/RECV variants where the name follows the verb directly.
  { re: /\b(?:SEND|RECV|RECEIVED?)\s+(?:E-?TFR|E-?TRANSFER)\s+(.+)/i, kind: 'person' },
  // Zelle / Venmo with an optional PAYMENT or CASHOUT qualifier.
  { re: /\b(?:ZELLE|VENMO)\s+(?:(?:PAYMENT|CASHOUT|PMT)\s+)?(?:FROM|TO)\s+(.+)/i, kind: 'person' },
  // Cash App asterisk form ("CASHAPP*JANE DOE").
  { re: /\bCASH\s*APP\s*\*\s*(.+)/i, kind: 'person' },
  // Cash App with explicit FROM/TO.
  { re: /\bCASH\s*APP\s+(?:FROM|TO)\s+(.+)/i, kind: 'person' },
  // Payroll / direct-deposit payer name follows the prefix.
  { re: /\b(?:PAYROLL\s+DEP(?:OSIT)?|DIRECT\s+DEP(?:OSIT)?)\s+(.+)/i, kind: 'payroll' },
];

function normalize(raw: string): string | null {
  let n = raw.trim();
  n = n.replace(/\s+REF\W?.*$/i, '');
  n = n.replace(/\s+\d{2,}.*$/, '');
  n = n.replace(/\s+/g, ' ').trim();
  return n === '' ? null : n;
}

/**
 * Extract the counterparty (source/dest) name from a statement line.
 *
 * Returns `{ name, kind }` when a known transfer/payroll pattern matches
 * AND the account is in scope (checking/savings/cash). Returns null
 * otherwise — including for out-of-scope accounts, even when the line
 * contains a recognizable name.
 *
 * `kind` is `'person'` for peer-to-peer transfers (Interac/Zelle/Venmo/
 * CashApp) and `'payroll'` for direct-deposit/payroll lines. The downstream
 * importer uses `kind` to gate Contact auto-creation (Task 5 of PR B):
 * only `'person'` counterparties get a Contact record on import.
 *
 * The caller is the importer (`commitStatementImport.ts`); it writes the
 * result to `transactions.counterparty_raw`. The structured Contact link
 * (`counterparty_contact_id`) is set later by the promote endpoint.
 */
export function extractCounterparty(
  merchantRaw: string,
  accountType: AccountType,
): ExtractedCounterparty | null {
  if (!IN_SCOPE_ACCOUNT_TYPES.has(accountType)) return null;
  if (!merchantRaw || merchantRaw.trim() === '') return null;
  for (const { re, kind } of PATTERNS) {
    const match = merchantRaw.match(re);
    if (match && match[1]) {
      const normalized = normalize(match[1]);
      if (normalized) return { name: normalized, kind };
    }
  }
  return null;
}

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

/**
 * Which way the money moved, from the household's point of view. Same
 * vocabulary as `NamelessTxnLite.direction` in `matchInteracCounterparty.ts`
 * so the two counterparty paths agree. `null` where the statement line names
 * a counterparty but not a direction (Cash App's `CASHAPP*NAME` form).
 */
export type CounterpartyDirection = 'sent' | 'received';

export type ExtractedCounterparty = {
  name: string;
  kind: CounterpartyKind;
  direction: CounterpartyDirection | null;
};

/**
 * Lines that look transfer-shaped but move money between the household's own
 * accounts, or name a service rather than a party. Checked before the pattern
 * table so a future widening can't quietly turn "DEPOSIT ACCOUNT-1134" into a
 * Contact.
 */
const NON_COUNTERPARTY_PATTERNS: RegExp[] = [
  /\bONLINE\s+TRANSFER\s+(?:TO|FROM)\s+DEPOSIT\s+ACCOUNT\b/i,
  /\bAUTO\s+TRANSFER\s+(?:TO|FROM)\b/i,
  /\bMISC\s+PAYMENT\b/i,
  // Anchored: the bank writes these as the WHOLE description
  // ("ATM DEPOSIT - KF470333"). Unanchored they would also veto a
  // hand-written line that merely cites the original in a parenthetical
  // ("Cash repayment from Caelan (ATM deposit KF470333)").
  /^\s*ATM\s+(?:DEPOSIT|WITHDRAWAL)\b/i,
  /^\s*MOBILE\s+CHEQUE\s+DEPOSIT\b/i,
];

/**
 * Account-product words a bank puts where a payee name would go
 * ("Transfer out to Chequing"). Compared against the fully normalized name,
 * lowercased.
 */
const GENERIC_NAMES = new Set([
  'account',
  'the account',
  'cash',
  'cash account',
  'chequing',
  'checking',
  'savings',
  'credit card',
  'deposit account',
  'find & save',
  'tfsa',
  'rrsp',
  'fhsa',
  'resp',
  'rdsp',
]);

/**
 * Pattern table, first match wins. Ordering is load-bearing: the qualified
 * Interac forms (AUTODEPOSIT, REQUEST FULFILLED, CANCEL) must precede the
 * bare SENT/RECEIVED forms, or the qualifier gets captured as the name.
 *
 * Shapes here were read off the production database rather than guessed —
 * see `extractCounterparty.test.ts` for the measured inventory.
 */
const PATTERNS: {
  re: RegExp;
  kind: CounterpartyKind;
  direction: CounterpartyDirection | null;
}[] = [
  // --- Interac e-transfer, RBC statement vocabulary ----------------------
  // `E-TRANSFER - AUTODEPOSIT <name>` — incoming, auto-deposited. AUTODEPOSIT
  // is a direction token, not part of the payer's name.
  {
    re: /\b(?:INTERAC\s+)?E-?TRANSFER\s*-?\s*AUTODEPOSIT\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  // `E-TRANSFER REQUEST FULFILLED <name>` — a money request the household
  // sent was paid, so the money came in.
  {
    re: /\b(?:INTERAC\s+)?E-?TRANSFER\s+REQUEST\s+FULFILLED\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  // `E-TRANSFER RECEIVED <name>` (RBC) and `Interac e-Transfer® Received
  // from <name>` (Wealthsimple).
  {
    re: /\b(?:INTERAC\s+)?E-?TRANSFER(?:®)?\s+RECEIVED(?:\s+FROM)?\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  // `E-TRANSFER SENT <name>` (RBC) and `Interac e-Transfer® Out to <name>`
  // (Wealthsimple).
  {
    re: /\b(?:INTERAC\s+)?E-?TRANSFER(?:®)?\s+(?:SENT|OUT\s+TO)\s+(.+)/i,
    kind: 'person',
    direction: 'sent',
  },
  // `E-TRANSFER CANCEL <name>` — an outgoing transfer that bounced back. The
  // name is still the intended payee, and the leg it reverses was outgoing.
  {
    re: /\b(?:INTERAC\s+)?E-?TRANSFER\s+CANCEL\s+(.+)/i,
    kind: 'person',
    direction: 'sent',
  },
  // Explicit FROM/TO. No production row uses this form, but other banks do.
  {
    re: /\b(?:INTERAC\s+)?(?:E-?TFR|E-?TRANSFER)(?:®)?\s+(?:FROM|FRM)\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  {
    re: /\b(?:INTERAC\s+)?(?:E-?TFR|E-?TRANSFER)(?:®)?\s+TO\s+(.+)/i,
    kind: 'person',
    direction: 'sent',
  },
  // Verb-first variants where the name follows directly.
  { re: /\bSEND\s+(?:E-?TFR|E-?TRANSFER)\s+(.+)/i, kind: 'person', direction: 'sent' },
  {
    re: /\b(?:RECV|RECEIVED?)\s+(?:E-?TFR|E-?TRANSFER)\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },

  // --- RBC bank-to-bank online transfers --------------------------------
  // `ONLINE TRANSFER RECEIVED - 8613 <name>`. The 3-6 digit group is the far
  // account's fragment and precedes the name, so the trailing-digit cleanup
  // in `normalize` can't reach it — the pattern has to consume it.
  {
    re: /\bONLINE\s+(?:BANKING\s+)?TRANSFER\s+RECEIVED\s*-\s*(?:\d{3,6}\s+)?(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  {
    re: /\bONLINE\s+(?:BANKING\s+)?TRANSFER\s+SENT\s*-\s*(?:\d{3,6}\s+)?(.+)/i,
    kind: 'person',
    direction: 'sent',
  },

  // --- Wise --------------------------------------------------------------
  { re: /\bRECEIVED\s+MONEY\s+FROM\s+(.+)/i, kind: 'person', direction: 'received' },
  { re: /\bSENT\s+MONEY\s+TO\s+(.+)/i, kind: 'person', direction: 'sent' },

  // --- Wealthsimple institution-to-institution --------------------------
  { re: /\bTRANSFER\s+IN\s+FROM\s+(.+)/i, kind: 'person', direction: 'received' },
  { re: /\bTRANSFER\s+OUT\s+TO\s+(.+)/i, kind: 'person', direction: 'sent' },

  // --- Hand-written ledger lines ----------------------------------------
  // Connor annotates anonymous cash movements in `merchantClean`, e.g.
  // "Cash repayment from Caelan (ATM deposit KF470333)".
  {
    re: /\bCASH\s+(?:REPAYMENT|ADVANCE|LOAN)\s+FROM\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  {
    re: /\bCASH\s+(?:REPAYMENT|ADVANCE|LOAN)\s+TO\s+(.+)/i,
    kind: 'person',
    direction: 'sent',
  },

  // --- US peer-to-peer apps ---------------------------------------------
  {
    re: /\b(?:ZELLE|VENMO)\s+(?:(?:PAYMENT|CASHOUT|PMT)\s+)?FROM\s+(.+)/i,
    kind: 'person',
    direction: 'received',
  },
  {
    re: /\b(?:ZELLE|VENMO)\s+(?:(?:PAYMENT|CASHOUT|PMT)\s+)?TO\s+(.+)/i,
    kind: 'person',
    direction: 'sent',
  },
  { re: /\bCASH\s*APP\s+FROM\s+(.+)/i, kind: 'person', direction: 'received' },
  { re: /\bCASH\s*APP\s+TO\s+(.+)/i, kind: 'person', direction: 'sent' },
  // Asterisk form ("CASHAPP*JANE DOE") carries no direction.
  { re: /\bCASH\s*APP\s*\*\s*(.+)/i, kind: 'person', direction: null },

  // --- Payroll / direct deposit -----------------------------------------
  // `from` is optional: RBC writes `PAYROLL DEPOSIT ACME CORP`, Wealthsimple
  // writes `Direct deposit from ACME CORP`.
  {
    re: /\b(?:PAYROLL\s+DEP(?:OSIT)?|DIRECT\s+DEP(?:OSIT)?)\s+(?:FROM\s+)?(.+)/i,
    kind: 'payroll',
    direction: 'received',
  },
];

/** `CA` + 6 and `C1A` + 9 are RBC's two fixed-width confirmation formats. */
const FIXED_WIDTH_REFERENCE = /^(?:CA[A-Z0-9]{6}|C1A[A-Z0-9]{9})$/;

/**
 * Whether a single trailing token is an RBC e-transfer confirmation code
 * rather than part of the payee's name.
 *
 * Calibrated against every distinct in-scope description in production. The
 * remaining ambiguity is a name whose LAST token is 8 uppercase characters
 * beginning "CA" with no reference code after it — that would be stripped.
 * No production row has that shape, and the alternative (keeping every
 * `CA…`) splits one payee across a dozen Contacts, one per confirmation
 * code, which is the failure that actually costs something.
 */
function looksLikeReferenceCode(token: string): boolean {
  if (!/^[A-Z0-9]+$/.test(token)) return false;
  if (FIXED_WIDTH_REFERENCE.test(token)) return true;
  // Any code carrying a digit: names don't. (5KBFRY, PVW3RX, D75F1AEF…)
  if (token.length >= 5 && /\d/.test(token)) return true;
  // Long opaque base32/hex blobs.
  if (token.length >= 16) return true;
  // Six letters with at most one vowel is unpronounceable as a name
  // (DPKGQG, KYXLNZ, UNJGNG) — real six-letter surnames carry two or more.
  if (token.length === 6 && (token.match(/[AEIOU]/g)?.length ?? 0) <= 1) return true;
  return false;
}

function normalize(raw: string): string | null {
  let n = raw.trim();
  // Wise appends the payment reference after the name.
  n = n.replace(/\s+with\s+reference\b.*$/i, '');
  n = n.replace(/\s+REF\W?.*$/i, '');
  // Hand-written annotations put the original bank string in parentheses.
  n = n.replace(/\s*\([^)]*\)\s*$/, '');
  // A source string truncated mid-name can leave a dangling open paren
  // ("RBC Bank (Georgi with reference P2P").
  if (n.includes('(') && !n.includes(')')) n = n.slice(0, n.indexOf('('));
  // RBC appends the far account's product after the payee
  // ("… 8288 ERIC BROADFOOT - SAVINGS").
  n = n.replace(
    /\s+-\s+(?:SAVINGS|CHEQUING|CHECKING|CREDIT\s+CARD|DEPOSIT\s+ACCOUNT)\s*$/i,
    '',
  );
  n = n.replace(/\s+\d{2,}.*$/, '');
  n = n.replace(/\s+/g, ' ').trim();
  // Exactly one trailing reference code comes off, and only when a name is
  // left behind: `E-TRANSFER SENT CRYPTO` fits the reference-code shape but
  // CRYPTO *is* the payee.
  const parts = n.split(' ');
  if (parts.length > 1 && looksLikeReferenceCode(parts[parts.length - 1])) {
    parts.pop();
  }
  n = parts.join(' ').trim();
  if (n === '') return null;
  // A bare separator ("INTERAC E-TRANSFER CANCEL -") is not a name.
  if (!/[A-Za-z]/.test(n)) return null;
  if (GENERIC_NAMES.has(n.toLowerCase())) return null;
  return n;
}

/**
 * Extract the counterparty (source/dest) name from a statement line.
 *
 * Returns `{ name, kind, direction }` when a known transfer/payroll pattern
 * matches AND the account is in scope (checking/savings/cash). Returns null
 * otherwise — including for out-of-scope accounts, even when the line
 * contains a recognizable name.
 *
 * `kind` is `'person'` for peer-to-peer transfers (Interac/Wise/Zelle/Venmo/
 * CashApp) and `'payroll'` for direct-deposit/payroll lines. The downstream
 * importer uses `kind` to gate Contact auto-creation: only `'person'`
 * counterparties get a Contact record on import.
 *
 * `direction` is which way the money moved for the household, so a caller can
 * tell "lent to X" from "repaid by X" without re-parsing the line.
 *
 * Callers: the importer (`commitStatementImport.ts`), which passes
 * `merchantRaw`, and the retroactive sweep (`counterpartyBackfill.ts`), which
 * passes `merchantClean ?? merchantRaw` because a hand-corrected clean line
 * can carry a name the raw line never had.
 */
export function extractCounterparty(
  merchantRaw: string,
  accountType: AccountType,
): ExtractedCounterparty | null {
  if (!IN_SCOPE_ACCOUNT_TYPES.has(accountType)) return null;
  if (!merchantRaw || merchantRaw.trim() === '') return null;
  if (NON_COUNTERPARTY_PATTERNS.some((re) => re.test(merchantRaw))) return null;
  for (const { re, kind, direction } of PATTERNS) {
    const match = merchantRaw.match(re);
    if (match && match[1]) {
      const normalized = normalize(match[1]);
      // A pattern that matched but yielded only a product word or separator
      // falls through — a later, more specific pattern may still name a party.
      if (normalized) return { name: normalized, kind, direction };
    }
  }
  return null;
}

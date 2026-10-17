import type {
  PdfLine,
  PdfParseResult,
  PdfParser,
  PdfStatementHeader,
  StatementParseError,
} from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { parseLongDate, parseMoney } from './dateHelpers';

/**
 * Wise multi-currency PDF statement parser.
 *
 * Each Wise PDF holds one currency (CAD, USD, GBP, EUR, …) for one
 * account-holder (corp or personal). The bundle importer creates one Account
 * per currency using `header.accountSuffix` (last 4 of the Wise account number,
 * or last 4 of the IBAN for EUR/GBP accounts) as the shortCode and
 * `header.currency` as Account.defaultCurrency.
 *
 * Dates render DAY-FIRST on real statements ("11 March 2023", "20 June 2025");
 * `parseLongDate` also accepts the month-first form for resilience.
 *
 * Layout markers:
 *   Sniff:        "Wise Payments Canada Inc."
 *   Currency:     "<CCY> statement" (e.g. "CAD statement", "USD statement")
 *   Period:       "11 March 2023 [GMT-04:00] - 1 June 2026 [GMT-04:00]"
 *   Header row:   "Account Holder    Account number    Institution number"
 *                 (or "… IBAN  Swift/BIC" for EUR/GBP). Column labels are
 *                 followed by an aligned value row that splits on 2+ spaces.
 *   Section:      starts at "<CCY> on <date> [GMT-04:00]    <amt> <CCY>"
 *   Columns:      Description | Incoming | Outgoing | Amount (running balance)
 *
 * TWO body layouts are in circulation and both are supported.
 *
 * Newer statements (seen 2026-09) put the numeric columns ON the description
 * line, so a transaction is TWO lines:
 *   1. "<description>   <signed amount>   <running balance>"
 *   2. "<date> | Transaction: <TXNID> [| Reference: <ref>]"
 *
 * Older statements broke the columns onto a line of their own, making it THREE:
 *   1. description (e.g. "Sent money to CDG Labs Inc.")
 *   2. numeric pair "<signed amount>   <running balance>" — first token is the
 *      signed amount (Outgoing values print negative, Incoming positive)
 *   3. "<date>   [Card ending in NNNN   <Holder>   ]Transaction: <TXNID>
 *      [Reference: <ref>]" — card rows interpose card metadata before the ID
 *
 * In both cases the LAST number is the running balance and the one before it is
 * the signed amount. Columns are separated by RUNS of spaces while money inside
 * the description ("Converted 10,499.28 USD to 14,522.37 CAD") is single-spaced,
 * which is what lets `splitTrailingColumns` tell them apart. A long reference
 * can wrap onto its own line after the column-bearing line, so description
 * fragments are joined, not overwritten.
 *
 * Page breaks can split a 3-line block across pages — the walker treats lines
 * as a flat stream and ignores page footers (`ref:... N / N`).
 *
 * TXNID forms: `TRANSFER-12345`, `BALANCE-12345`, `CARD-12345`,
 * `BANK_DETAILS_ORDER_CHECKOUT-invoice-12345`. Used as `sourceReference` for
 * dedup and (for `BALANCE-*` IDs) FX-pair linking across the matching USD/CAD
 * statement.
 */

const SNIFF_RE = /Wise Payments Canada Inc\./i;
const CCY_STMT_RE = /^([A-Z]{3})\s+statement$/;
// Dates render day-first ("11 March 2023") on real Wise Canada PDFs; the older
// corp fixtures were month-first ("March 11, 2023"). `parseLongDate` accepts
// both orderings, so these regexes only need to bracket the date substring.
const PERIOD_RE = /(.+?)\s*\[[^\]]+\]\s*-\s*(.+?)\s*\[[^\]]+\]/;
const ACCOUNT_HOLDER_LABEL_RE = /Account Holder/i;
const BALANCE_HEADER_RE = /^[A-Z]{3}\s+on\s+.+?\s*\[/;
// Card transactions interpose "Card ending in NNNN   <Holder>" between the date
// and "Transaction:", so allow arbitrary text there.
const DATE_TXNID_RE =
  /^(\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+.*?Transaction:\s+([A-Z_]+(?:-[a-z]+)*-\d+)(?:\s+Reference:\s+(\S+))?/;
const MONEY_TOKEN_RE = /^-?[\d,]+\.\d{2}$/;
const MONEY_GLOBAL_RE = /-?[\d,]+\.\d{2}/g;
const PAGE_FOOTER_RE = /^ref:[a-f0-9-]+\s+\d+\s*\/\s*\d+$/;
const FOOTER_HINTS = [
  /money service business/i,
  /wise\.com\/help/i,
  /FINTRAC/i,
];
const ACCOUNT_NUMBER_RE = /\b\d{10,15}\b/;

/**
 * Return the space-stripped IBAN if `token` is one (EUR/GBP Wise accounts are
 * keyed by IBAN, not a numeric account number), else null. IBAN = 2 country
 * letters + 2 check digits + up to 30 alphanumerics; Wise prints it in
 * 4-char groups ("BE08 9052 4770 9513"). BICs ("TRWIBEB1XXX") and numeric
 * account numbers are rejected.
 */
function cleanIban(token: string): string | null {
  const compact = token.replace(/\s+/g, '');
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact) ? compact : null;
}

function isColumnHeader(text: string): boolean {
  const t = text.toLowerCase();
  return /\bdescription\b/.test(t) && /\bincoming\b/.test(t) && /\boutgoing\b/.test(t);
}

function isPageFooter(text: string): boolean {
  return PAGE_FOOTER_RE.test(text);
}

function isFooterEnd(text: string): boolean {
  return FOOTER_HINTS.some((re) => re.test(text));
}

function isAllMoneyLine(text: string): boolean {
  const tokens = text.trim().split(/\s{2,}|\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => MONEY_TOKEN_RE.test(t));
}

function isLikelyDescription(text: string): boolean {
  if (!text) return false;
  if (DATE_TXNID_RE.test(text)) return false;
  if (isAllMoneyLine(text)) return false;
  if (isColumnHeader(text)) return false;
  if (BALANCE_HEADER_RE.test(text)) return false;
  if (isPageFooter(text)) return false;
  return true;
}

function parseHolderAndAccountNumber(
  lines: PdfLine[],
): { holder: string | null; accountNumber: string | null } {
  for (let i = 0; i < lines.length; i++) {
    if (!ACCOUNT_HOLDER_LABEL_RE.test(lines[i].text)) continue;
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const text = lines[j].text.trim();
      if (!text) continue;
      const tokens = text.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean);
      const numericToken = tokens.find((t) => ACCOUNT_NUMBER_RE.test(t));
      const accountNumber = numericToken
        ? (ACCOUNT_NUMBER_RE.exec(numericToken)?.[0] ?? null)
        : (tokens.map(cleanIban).find(Boolean) ?? null);
      const holderToken = tokens.find(
        (t) => !ACCOUNT_NUMBER_RE.test(t) && !/^\d+$/.test(t) && !cleanIban(t),
      );
      if (accountNumber || holderToken) {
        return { holder: holderToken ?? null, accountNumber };
      }
    }
  }
  return { holder: null, accountNumber: null };
}

export function parseWiseStatementHeader(lines: PdfLine[]): PdfStatementHeader {
  if (!lines.some((l) => SNIFF_RE.test(l.text))) {
    throw new Error('Wise header: not a Wise statement (sniff marker missing)');
  }

  let currency: string | null = null;
  for (const l of lines) {
    const m = CCY_STMT_RE.exec(l.text.trim());
    if (m) {
      currency = m[1];
      break;
    }
  }
  if (!currency) {
    throw new Error('Wise header: could not find currency ("<CCY> statement" line)');
  }

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const l of lines) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    periodStart = parseLongDate(m[1]);
    periodEnd = parseLongDate(m[2]);
    if (periodStart && periodEnd) break;
  }
  if (!periodStart || !periodEnd) {
    throw new Error('Wise header: could not parse statement period');
  }

  const { holder, accountNumber } = parseHolderAndAccountNumber(lines);
  if (!accountNumber) {
    throw new Error('Wise header: could not find account number');
  }
  const accountSuffix = accountNumber.slice(-4);

  return {
    accountSuffix,
    productLabel: `Wise ${currency}`,
    accountType: 'checking',
    periodStart,
    periodEnd,
    currency,
    accountHolder: holder ?? undefined,
  };
}

type WiseRow = {
  date: string;
  description: string;
  amount: number;
  sourceReference: string;
};

type ParseErrors = StatementParseError[];

function findBodyStart(lines: PdfLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (BALANCE_HEADER_RE.test(lines[i].text.trim())) return i + 1;
  }
  return 0;
}

function extractAmountFromMoneyLine(text: string): number | null {
  const tokens = text.match(MONEY_GLOBAL_RE);
  if (!tokens || tokens.length === 0) return null;
  const signed = parseMoney(tokens[0]);
  return Number.isFinite(signed) ? signed : null;
}

/**
 * Split a body line into its description text and the Incoming/Outgoing/Amount
 * columns Wise prints at the end of it.
 *
 * Newer statements merge the numeric columns onto the description line:
 *
 *   "Sent money to CDG Labs Inc.   -14,522.37   0.00"
 *   "Converted 10,499.28 USD to 14,522.37 CAD   14,522.37   14,522.37"
 *
 * Columns are separated from the description (and from each other) by RUNS of
 * spaces, while money inside the description text — "Converted 10,499.28 USD" —
 * is single-spaced, so splitting on 2+ spaces keeps the two apart. Trailing
 * money tokens are then peeled off the end.
 *
 * The LAST column is the running balance; the amount is the column immediately
 * before it. Only two of the three labelled columns are ever printed on the
 * statements seen so far (the empty one is dropped), so a line with fewer than
 * two trailing money tokens is treated as having no columns at all rather than
 * guessing which one it is.
 */
export function splitTrailingColumns(
  text: string,
): { description: string; amount: number | null } {
  const tokens = text.trim().split(/\s{2,}/).map((t) => t.trim()).filter(Boolean);
  const trailing: string[] = [];
  // Never consume the final non-money token — a line that is ALL money is the
  // older layout's standalone amount line, handled by `isAllMoneyLine`.
  while (tokens.length > 1 && MONEY_TOKEN_RE.test(tokens[tokens.length - 1])) {
    trailing.unshift(tokens.pop() as string);
  }
  const description = tokens.join(' ');
  if (trailing.length < 2) return { description: description || text.trim(), amount: null };
  const signed = parseMoney(trailing[trailing.length - 2]);
  return { description, amount: Number.isFinite(signed) ? signed : null };
}

function extractAmountFromInline(
  txnLineText: string,
  txnLineMatch: RegExpExecArray,
): number | null {
  const rest = txnLineText.slice(txnLineMatch[0].length);
  const tokens = rest.match(MONEY_GLOBAL_RE);
  if (!tokens || tokens.length === 0) return null;
  const signed = parseMoney(tokens[0]);
  return Number.isFinite(signed) ? signed : null;
}

export function parseWiseStatementBody(
  lines: PdfLine[],
): { rows: WiseRow[]; parseErrors: ParseErrors } {
  const rows: WiseRow[] = [];
  const parseErrors: ParseErrors = [];
  const startIdx = findBodyStart(lines);

  let pendingDescription: string | null = null;
  let pendingAmountLine: string | null = null;
  // Amount lifted off the description line itself (newer two-line layout).
  let pendingInlineAmount: number | null = null;

  for (let i = startIdx; i < lines.length; i++) {
    const text = lines[i].text.trim();
    if (!text) continue;
    if (isFooterEnd(text)) break;
    if (isPageFooter(text)) continue;
    if (isColumnHeader(text)) continue;
    if (BALANCE_HEADER_RE.test(text)) continue;

    const dateIdMatch = DATE_TXNID_RE.exec(text);
    if (dateIdMatch) {
      const isoDate = parseLongDate(dateIdMatch[1]);
      const sourceReference = dateIdMatch[2];
      if (!isoDate) {
        parseErrors.push({ rowIndex: i + 1, message: `Bad txn date: ${dateIdMatch[1]}` });
        pendingDescription = null;
        pendingAmountLine = null;
        pendingInlineAmount = null;
        continue;
      }
      let amount: number | null = null;
      if (pendingAmountLine) {
        amount = extractAmountFromMoneyLine(pendingAmountLine);
      }
      if (amount == null) {
        amount = pendingInlineAmount;
      }
      if (amount == null) {
        amount = extractAmountFromInline(text, dateIdMatch);
      }
      if (amount == null) {
        parseErrors.push({
          rowIndex: i + 1,
          message: `Could not find amount for txn ${sourceReference} on ${isoDate}`,
        });
        pendingDescription = null;
        pendingAmountLine = null;
        pendingInlineAmount = null;
        continue;
      }
      const description = pendingDescription ?? sourceReference;
      rows.push({ date: isoDate, description, amount, sourceReference });
      pendingDescription = null;
      pendingAmountLine = null;
      pendingInlineAmount = null;
      continue;
    }

    if (isAllMoneyLine(text)) {
      pendingAmountLine = text;
      continue;
    }

    if (isLikelyDescription(text)) {
      const { description, amount } = splitTrailingColumns(text);
      if (amount !== null) pendingInlineAmount = amount;
      if (description) {
        // A long reference can wrap onto its own line AFTER the line carrying
        // the columns, so fragments are joined rather than overwritten.
        pendingDescription = pendingDescription ? `${pendingDescription} ${description}` : description;
      }
      continue;
    }
  }

  return { rows, parseErrors };
}

export const wiseStatementParser: PdfParser = {
  id: 'wise_statement',
  label: 'Wise multi-currency statement',
  sniff: (lines) => lines.some((l) => SNIFF_RE.test(l.text)),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseWiseStatementHeader(lines);
    const { rows, parseErrors } = parseWiseStatementBody(lines);
    const currency = header.currency ?? ctx.defaultCurrency;
    const transactions = rows.map((r) => ({
      date: r.date,
      merchantRaw: r.description,
      merchantClean: normalizeMerchant(r.description),
      amount: r.amount,
      currency,
      sourceReference: r.sourceReference,
    }));
    return {
      transactions,
      header,
      warnings: [],
      parseErrors,
    };
  },
};

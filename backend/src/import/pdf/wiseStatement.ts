import type {
  PdfLine,
  PdfParseResult,
  PdfParser,
  PdfStatementHeader,
} from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { parseLongDate, parseMoney } from './dateHelpers';

/**
 * Wise multi-currency PDF statement parser.
 *
 * Each Wise PDF holds one currency (CAD, USD, GBP, …) for one account-holder
 * (corp or personal). The bundle importer creates one Account per currency
 * using `header.accountSuffix` (last 4 of the Wise account number) as the
 * shortCode and `header.currency` as Account.defaultCurrency.
 *
 * Layout markers:
 *   Sniff:        "Wise Payments Canada Inc."
 *   Currency:     "<CCY> statement" (e.g. "CAD statement", "USD statement")
 *   Period:       "June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]"
 *   Header row:   "Account Holder    Account number    Institution number"
 *                 (column labels followed by an aligned value row that splits
 *                 on 2+ spaces into [holder, accountNumber, institution])
 *   Section:      starts at "<CCY> on <date> [GMT-04:00]    <amt> <CCY>"
 *   Columns:      Description | Incoming | Outgoing | Amount (running balance)
 *
 * Each transaction occupies THREE consecutive body lines:
 *   1. description (e.g. "Sent money to CDG Labs Inc.")
 *   2. numeric pair "<signed amount>   <running balance>" — first token is the
 *      signed amount (Outgoing values print negative, Incoming positive)
 *   3. "<Long date>   Transaction: <TXNID>   [Reference: <ref>]"
 *
 * Page breaks can split a 3-line block across pages — the walker treats lines
 * as a flat stream and ignores page footers (`ref:... N / N`).
 *
 * TXNID forms: `TRANSFER-12345`, `BALANCE-12345`,
 * `BANK_DETAILS_ORDER_CHECKOUT-invoice-12345`. Used as `sourceReference` for
 * dedup and (for `BALANCE-*` IDs) FX-pair linking across the matching USD/CAD
 * statement.
 */

const SNIFF_RE = /Wise Payments Canada Inc\./i;
const CCY_STMT_RE = /^([A-Z]{3})\s+statement$/;
const PERIOD_RE =
  /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*\[[^\]]+\]\s*-\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*\[[^\]]+\]/;
const ACCOUNT_HOLDER_LABEL_RE = /Account Holder/i;
const BALANCE_HEADER_RE = /^[A-Z]{3}\s+on\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s*\[/;
const DATE_TXNID_RE =
  /^([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+Transaction:\s+([A-Z_]+(?:-[a-z]+)*-\d+)(?:\s+Reference:\s+(\S+))?/;
const MONEY_TOKEN_RE = /^-?[\d,]+\.\d{2}$/;
const MONEY_GLOBAL_RE = /-?[\d,]+\.\d{2}/g;
const PAGE_FOOTER_RE = /^ref:[a-f0-9-]+\s+\d+\s*\/\s*\d+$/;
const FOOTER_HINTS = [
  /money service business/i,
  /wise\.com\/help/i,
  /FINTRAC/i,
];
const ACCOUNT_NUMBER_RE = /\b\d{10,15}\b/;

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
      const accountToken = tokens.find((t) => ACCOUNT_NUMBER_RE.test(t));
      const holderToken = tokens.find((t) => !ACCOUNT_NUMBER_RE.test(t) && !/^\d+$/.test(t));
      if (accountToken || holderToken) {
        return {
          holder: holderToken ?? null,
          accountNumber: accountToken
            ? (ACCOUNT_NUMBER_RE.exec(accountToken)?.[0] ?? null)
            : null,
        };
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

type ParseErrors = { rowIndex: number; message: string }[];

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
        continue;
      }
      let amount: number | null = null;
      if (pendingAmountLine) {
        amount = extractAmountFromMoneyLine(pendingAmountLine);
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
        continue;
      }
      const description = pendingDescription ?? sourceReference;
      rows.push({ date: isoDate, description, amount, sourceReference });
      pendingDescription = null;
      pendingAmountLine = null;
      continue;
    }

    if (isAllMoneyLine(text)) {
      pendingAmountLine = text;
      continue;
    }

    if (isLikelyDescription(text)) {
      pendingDescription = text;
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

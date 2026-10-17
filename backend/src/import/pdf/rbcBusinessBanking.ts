import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader, StatementParseError } from './types';
import { rbcBankingResult } from './rbcBankingResult';
import { signByRunningBalance, type UnsignedRow } from './rbcRunningBalanceSigns';
import { dayMonthToIso, lastMoneyTokenValue, parseMoney, parsePeriod, type Period } from './dateHelpers';

/**
 * RBC Business/Corporate chequing statement parser.
 *
 * Handles the "Business Account Statement" layout used by RBC business
 * deposit accounts (e.g. "RBC Digital Choice Business™ account package").
 *
 * Layout markers:
 *   Title:        "Business Account Statement" (on page 1, right column)
 *   Package line: "RBC Digital Choice Business            account package"
 *                 (™ superscript appears as separate "TM" line; match loosely)
 *   Account:      "Account number: 03592 105-488-1"  → last 4 digits = "4881"
 *   Account holder: "CDG LABS INC." (line just after the internal code line)
 *   Period:       "April 2, 2026 to May 5, 2026" (no "From" prefix)
 *   Section:      "Account Activity Details"
 *   Columns:      Date | Description | Cheques & Debits ($) | Deposits & Credits ($) | Balance ($)
 *   Date format:  "01 May" (two-digit day + month abbrev; year inferred from period)
 *
 * pdfjs note: All text items on a transaction row are merged into a SINGLE
 * positioned span starting at x≈45 (date-prefixed rows) or x≈90 (date-less
 * rows). Column-midpoint detection (as used in rbcPersonalBanking) is not
 * applicable because there are no separate column spans. Instead, we use the
 * running-balance approach: the signed amount of each transaction is computed
 * as `current_balance - previous_balance`. For transactions without an
 * explicit balance column value, we infer sign via forward-balance lookahead.
 *
 * Date-less rows (x > 60) that contain money amounts are independent
 * transactions that inherit the most recent date (not description continuations).
 */

const TITLE_RE = /Business Account Statement/;
const PACKAGE_RE = /RBC\s+Digital Choice Business/i;
const ACCOUNT_NUMBER_RE = /Account number:\s*([\d\s-]+)/;
// Period line has no "From" prefix: "April 2, 2026 to May 5, 2026"
const PERIOD_RE = /([A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s+to\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})/;
const ACCOUNT_HOLDER_RE = /^([A-Z][A-Z\s.&'-]+(?:INC\.?|CORP\.?|CORPORATION|LTD\.?|LLC|LLP|CO\.?))\s*$/;

/** Matches a transaction date prefix: "01 May" or "1 May" (1–2 digit day + 3-letter month). */
const DATE_PREFIX_RE = /^(\d{1,2}\s+[A-Z][a-z]{2})\b/;

/** Matches a money token: digits with optional commas, a decimal point, two digits. May be negative. */
const MONEY_RE = /^-?[\d,]+\.\d{2}$/;

function isMoneyToken(s: string): boolean {
  return MONEY_RE.test(s.trim());
}

/**
 * Extract trailing money tokens from a line of text.
 * Returns them left-to-right (earliest = leftmost = amount column;
 * last = rightmost = balance column).
 *
 * Splits on 2+ spaces to find column-separated tokens.
 */
function extractTrailingMoneyTokens(text: string): number[] {
  // Remove the date prefix if present (e.g. "01 May") to avoid confusing
  // "01" as a money token.
  const stripped = text.replace(DATE_PREFIX_RE, '').trim();
  // Split by 2+ spaces to find field boundaries.
  const parts = stripped.split(/\s{2,}/);
  const moneyValues: number[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (isMoneyToken(t)) {
      moneyValues.push(parseMoney(t));
    }
  }
  return moneyValues;
}

export function parseRbcBusinessBankingHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  // Account number: "Account number: 03592 105-488-1" → last 4 digits of the account part
  let accountSuffix: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_NUMBER_RE.exec(l.text);
    if (m) {
      // Strip all spaces/dashes, take last 4 digits.
      const digits = m[1].replace(/[\s-]/g, '');
      accountSuffix = digits.slice(-4);
      break;
    }
  }
  if (!accountSuffix) {
    throw new Error('RBC business banking header: could not find account number');
  }

  // Period: "April 2, 2026 to May 5, 2026" (no "From" prefix)
  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    period = parsePeriod(m[1]);
    if (period) break;
  }
  if (!period) {
    throw new Error('RBC business banking header: could not parse statement period');
  }

  // Product label: "RBC Digital Choice Business  account package" (TM appears on a separate line)
  let productLabel = 'RBC Digital Choice Business';
  for (const l of page1) {
    if (PACKAGE_RE.test(l.text)) {
      // Normalize: remove excess whitespace, strip trailing "account package"
      const raw = l.text.replace(/\s+/g, ' ').trim();
      // Extract the product name before "account package"
      const idx = raw.toLowerCase().indexOf('account package');
      if (idx > 0) {
        productLabel = raw.slice(0, idx).trim().replace(/\s+/g, ' ');
      }
      break;
    }
  }

  // Account holder: look for an all-caps company name near the address section.
  // The "CDG LABS INC." line appears after the internal code line on page 1.
  let accountHolder: string | undefined;
  for (const l of page1) {
    const t = l.text.trim();
    if (ACCOUNT_HOLDER_RE.test(t)) {
      accountHolder = t;
      break;
    }
  }

  return {
    accountSuffix,
    productLabel,
    accountType: 'checking',
    periodStart: period.start,
    periodEnd: period.end,
    ...(accountHolder ? { accountHolder } : {}),
  };
}

type PendingRow = UnsignedRow;

/**
 * Parse transactions from the "Account Activity Details" section.
 *
 * Strategy:
 * 1. Slice lines between "Account Activity Details" and "Closing balance".
 * 2. For each line: if it starts with a date prefix (x≈45), it's a new
 *    transaction row. If it has no date prefix (x≈90) and contains money
 *    amounts, it's a new transaction inheriting the previous date.
 * 3. Extract trailing money tokens: last = balance (if 2+ tokens); sole token
 *    = either amount (no balance) or balance-only row (opening/closing).
 * 4. Sign transactions using running balance delta.
 */
export function parseRbcBusinessBankingActivity(
  lines: PdfLine[],
  period: Period,
  openingBalance: number,
  closingBalance: number | null = extractClosingBalance(lines),
): { rows: Array<{ date: string; description: string; amount: number }>; parseErrors: StatementParseError[] } {
  const parseErrors: StatementParseError[] = [];

  // Slice the activity section.
  //
  // The activity table can span multiple pages; RBC prints a per-page "Closing
  // balance" running total at the foot of each page (extractClosingBalance
  // takes the LAST such row). Do NOT terminate at the first "Closing balance" —
  // that truncates every page-2+ transaction. The closing-balance rows are
  // skipped as transactions in the walk below; the section ends at the real
  // "Important information about your account" footer.
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/Account Activity Details/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/Important information about your account/i.test(l.text)) break;
    activityLines.push(l);
  }

  // Collect pending rows
  const pending: PendingRow[] = [];
  let currentDate: string | null = null;
  let descBuffer: string[] = [];

  const isDatelessRow = (l: PdfLine): boolean => {
    // Date-less rows start at x≈90 (first span x > 60).
    const firstX = l.items?.[0]?.x ?? 0;
    return firstX > 60;
  };

  const isNewTxnRow = (l: PdfLine): boolean => {
    // Starts with a date prefix.
    return DATE_PREFIX_RE.test(l.text.trim());
  };

  for (let i = 0; i < activityLines.length; i++) {
    const l = activityLines[i];
    const text = l.text.trim();
    if (!text) continue;

    // Skip the column header row (repeats on each page).
    if (/^Date\s+Description/i.test(text)) continue;
    // Skip the opening balance row.
    if (/^Opening balance\b/i.test(text)) continue;
    // Skip per-page / final "Closing balance" running-total rows — they are not
    // transactions (they carry the balance column only). Without this they would
    // be mis-parsed as date-less transactions inheriting the prior date.
    if (/^Closing balance\b/i.test(text)) continue;
    // Skip "- No activity" rows.
    if (/^-\s*No activity/i.test(text)) continue;

    const moneyTokens = extractTrailingMoneyTokens(text);

    if (isNewTxnRow(l)) {
      // Flush any accumulated description-only lines that didn't get an amount.
      descBuffer = [];

      const dateMatch = DATE_PREFIX_RE.exec(text);
      if (!dateMatch) {
        parseErrors.push({ rowIndex: i + 1, message: `Unexpected: date prefix not found in: ${text}` });
        continue;
      }
      try {
        currentDate = dayMonthToIso(dateMatch[1], period);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        continue;
      }

      // Extract description: strip date prefix and money tokens.
      let desc = text.replace(DATE_PREFIX_RE, '').trim();
      for (const part of desc.split(/\s{2,}/)) {
        if (isMoneyToken(part.trim())) {
          desc = desc.replace(part, '').trim();
        }
      }
      desc = desc.replace(/\s{2,}/g, ' ').trim();

      if (moneyTokens.length === 0) {
        // Description-only line with no amounts yet — accumulate.
        descBuffer = [desc];
        continue;
      }

      pending.push({
        date: currentDate,
        description: desc || text.replace(DATE_PREFIX_RE, '').replace(/\s{2,}/g, ' ').trim(),
        rawAmount: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 2] : moneyTokens[0],
        balance: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 1] : null,
      });
    } else if (isDatelessRow(l)) {
      // Date-less row: could be a new transaction (inherits date) or description continuation.
      if (moneyTokens.length === 0) {
        // Pure description continuation.
        descBuffer.push(text);
        continue;
      }

      // Has amounts → it's a new transaction (or its own row with inherited date).
      if (!currentDate) {
        parseErrors.push({ rowIndex: i + 1, message: `Date-less row with no current date: ${text}` });
        continue;
      }

      // Extract description from the date-less row.
      let desc = text;
      for (const part of desc.split(/\s{2,}/)) {
        if (isMoneyToken(part.trim())) {
          desc = desc.replace(part, '').trim();
        }
      }
      desc = desc.replace(/\s{2,}/g, ' ').trim();

      const fullDesc = [...descBuffer, desc].filter((s) => s.length > 0).join(' ').trim();
      descBuffer = [];

      pending.push({
        date: currentDate,
        description: fullDesc || desc,
        rawAmount: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 2] : moneyTokens[0],
        balance: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 1] : null,
      });
    } else {
      // Non-date-prefixed, non-date-less — description continuation.
      descBuffer.push(text);
    }
  }

  const signed = signByRunningBalance(pending, openingBalance, closingBalance);
  return { rows: signed.rows, parseErrors: [...parseErrors, ...signed.parseErrors] };
}

/**
 * Extract the opening balance: the Account Summary "Opening balance on <date>
 * $X.XX" line or the activity table's "Opening balance   X" row, whichever
 * first carries a dollar figure.
 *
 * Returns null when none does (e.g. the amount wrapped to the next line). Only
 * money-shaped tokens count — a bare "2026" from the summary date must not
 * parse as a $2,026.00 balance. Callers treat null as a hard parse error
 * (requireOpeningBalance): signing is delta-based from the opening, so
 * defaulting to 0 silently flips leading rows.
 */
function extractOpeningBalance(lines: PdfLine[]): number | null {
  for (const l of lines) {
    if (/^[\s]*Opening balance\b/i.test(l.text)) {
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) return v;
    }
  }
  return null;
}

function requireOpeningBalance(lines: PdfLine[]): number {
  const opening = extractOpeningBalance(lines);
  if (opening === null) {
    throw new Error(
      'RBC business banking: could not extract opening balance ' +
        '("Opening balance" line missing or without a dollar figure) — ' +
        'transaction signs would be unverifiable',
    );
  }
  return opening;
}

/**
 * Extract the closing balance.
 * Preference order:
 * 1. Account Summary line: "Closing balance on Month DD, YYYY   $X.XX"
 * 2. Last "Closing balance" row in the activity section (the Balance column value).
 *
 * Returns null if neither can be found.
 */
function extractClosingBalance(lines: PdfLine[]): number | null {
  // 1. Summary line: "Closing balance on <date>   $<amount>"
  const SUMMARY_CLOSING_RE = /Closing balance on\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}/i;
  for (const l of lines) {
    if (SUMMARY_CLOSING_RE.test(l.text)) {
      // Last money-shaped token — never the year, if the amount wrapped.
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) return v;
    }
  }

  // 2. Activity section: last "Closing balance" row.
  let inSection = false;
  let closingFromTable: number | null = null;
  for (const l of lines) {
    if (/Account Activity Details/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[\s]*Closing balance\b/i.test(l.text)) {
      // Trailing money token (balance column).
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) closingFromTable = v;
      // Don't break — if there are multiple pages, take the last one.
    }
    if (/Important information about your account/i.test(l.text)) break;
  }
  return closingFromTable;
}

export const rbcBusinessBankingParser: PdfParser = {
  id: 'rbc_business_banking',
  label: 'RBC business banking (chequing)',
  sniff: (lines) => lines.some((l) => TITLE_RE.test(l.text)),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcBusinessBankingHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const openingBalance = requireOpeningBalance(lines);
    const closingBalance = extractClosingBalance(lines);
    const { rows, parseErrors } = parseRbcBusinessBankingActivity(lines, period, openingBalance, closingBalance);

    return rbcBankingResult({
      header,
      rows,
      parseErrors,
      openingBalance,
      closingBalance,
      currency: ctx.defaultCurrency,
    });
  },
};

import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader, StatementParseError } from './types';
import { rbcBankingResult } from './rbcBankingResult';
import { signByRunningBalance, type UnsignedRow } from './rbcRunningBalanceSigns';
import { dayMonthToIso, lastMoneyTokenValue, parseLongDate, parseMoney, type Period } from './dateHelpers';

/**
 * RBC personal banking + savings statement parser.
 *
 * Handles all 4 deposit-account layouts that share the body shape:
 *   - "RBC Day to Day Banking"      → checking
 *   - "RBC Day to Day Savings"      → savings
 *   - "RBC High Interest eSavings"  → savings
 *   - "Find & Save"                 → savings (NOMI Find & Save)
 *
 * Layout markers:
 *   Title:        "Your RBC personal banking account statement" OR
 *                 "Your RBC personal savings account statement"
 *   Period:       "From November 3, 2025 to December 2, 2025"
 *   Account:      "Your account number: 02022-5016985"
 *   Product line: "<Product> 02022-XXXXXXX" inside "Summary of your account"
 *   Section:      "Details of your account activity"
 *   Columns:      Date | Description | Withdrawals ($) | Deposits ($) | Balance ($)
 *   Date format:  "4 Nov" (day-month, no year — year inferred from period)
 *   Termination:  "Closing Balance" or end of section
 *
 * pdfjs note: pdfjs v5 glues all text items on a transaction row into a SINGLE
 * positioned span. Column-midpoint detection (findColumnMidpoint) and per-item
 * x-position classification are not applicable. Instead we:
 *   1. Split each row on 2+ spaces to find field boundaries.
 *   2. Identify trailing money tokens (last 2 = [amount, balance]; last 1 = [balance-only]).
 *   3. Sign each transaction from the running balance (signByRunningBalance —
 *      runs of balance-less same-day rows are solved together).
 *   4. Gate with extractClosingBalance + reconciliation check (opening + Σsigned ≈ closing).
 */

const PRODUCT_MAP: Record<string, { label: string; accountType: 'checking' | 'savings' }> = {
  'RBC Day to Day Banking': { label: 'RBC Day to Day Banking', accountType: 'checking' },
  'RBC Day to Day Savings': { label: 'RBC Day to Day Savings', accountType: 'savings' },
  'RBC High Interest eSavings': { label: 'RBC High Interest eSavings', accountType: 'savings' },
  'Find & Save': { label: 'Find & Save', accountType: 'savings' },
};

const PRODUCT_REGEX = new RegExp(
  // Allow optional ™ or ® trademark suffix and trailing account-number tail.
  `(${Object.keys(PRODUCT_MAP).map((k) => k.replace(/[&]/g, '\\$&')).join('|')})(?:[™®])?`,
);

const ACCOUNT_NUMBER_RE = /Your account number:\s*(\d{5}-\d{7})/;
const PERIOD_RE = /From\s+(.+?to\s+.+?\d{4})/;

export function parseRbcPersonalBankingHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountNumber: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_NUMBER_RE.exec(l.text);
    if (m) {
      accountNumber = m[1];
      break;
    }
  }
  if (!accountNumber) {
    throw new Error('RBC personal banking header: could not find account number');
  }
  const accountSuffix = accountNumber.split('-')[1]?.slice(-4) ?? accountNumber.slice(-4);

  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const [startStr, endStr] = m[1].split(/\s+to\s+/);
    // Start can be "November 3, 2025" or "November 3" (year-end inherits)
    let startIso = parseLongDate(startStr);
    const endIso = parseLongDate(endStr);
    if (!endIso) continue;
    if (!startIso) {
      // Append year from end and retry.
      const endYear = endIso.slice(0, 4);
      startIso = parseLongDate(`${startStr.trim()}, ${endYear}`);
      // If still null and start > end (year-boundary), subtract one year.
      if (startIso && startIso > endIso) {
        startIso = parseLongDate(`${startStr.trim()}, ${Number(endYear) - 1}`);
      }
    }
    if (startIso && endIso) {
      period = { start: startIso, end: endIso };
      break;
    }
  }
  if (!period) {
    throw new Error('RBC personal banking header: could not parse statement period');
  }

  let productKey: string | null = null;
  for (const l of page1) {
    const m = PRODUCT_REGEX.exec(l.text);
    if (m) {
      productKey = m[1];
      break;
    }
  }
  if (!productKey) {
    throw new Error('RBC personal banking header: could not identify product');
  }
  const product = PRODUCT_MAP[productKey];

  return {
    accountSuffix,
    productLabel: product.label,
    accountType: product.accountType,
    periodStart: period.start,
    periodEnd: period.end,
  };
}

const DATE_PREFIX_RE = /^(\d{1,2}\s+[A-Z][a-z]{2})\b/;

/**
 * Matches a money token: digits with optional commas, a decimal point, two
 * digits. May be negative or have a $ prefix.
 *
 * The whitespace after the sign is load-bearing: when the account is overdrawn
 * RBC renders the balance with the minus SEPARATED from the digits
 * ("- 130.40"). Requiring the sign glued to the number made every such cell
 * fail to register as a balance, so those rows fell through to the
 * no-balance sign-guessing path and were stored with the wrong sign.
 * `parseMoney` already strips whitespace, so only recognition needed widening.
 */
const MONEY_RE = /^-?\s*\$?[\d,]+\.\d{2}$/;

function isMoneyToken(s: string): boolean {
  return MONEY_RE.test(s.trim());
}

/**
 * Extract trailing money tokens from a row of text.
 * Splits on 2+ spaces to find column boundaries (pdfjs uses multi-space as column separator).
 * Strips the date prefix first to avoid "01" matching as a money token.
 */
function extractTrailingMoneyTokens(text: string): number[] {
  const stripped = text.replace(DATE_PREFIX_RE, '').trim();
  const parts = stripped.split(/\s{2,}/);
  const values: number[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (isMoneyToken(t)) {
      values.push(parseMoney(t));
    }
  }
  return values;
}

/**
 * Extract the opening balance from the "Opening Balance" row in the activity section.
 * Real format: "         Opening Balance   96.49" (lots of leading spaces at x≈90).
 * Falls back to the summary line " Your opening balance on <date>   $XX.XX".
 *
 * Returns null when neither carries a dollar figure (e.g. the amount wrapped
 * to the next line). Only money-shaped tokens count — a bare "2025" from the
 * summary date must not parse as a $2,025.00 balance. Callers treat null as a
 * hard parse error (requireOpeningBalance): signing is delta-based from the
 * opening, so defaulting to 0 silently flips leading rows.
 */
function extractOpeningBalance(lines: PdfLine[]): number | null {
  for (const l of lines) {
    if (/^[\s]*Opening Balance\b/i.test(l.text)) {
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) return v;
    }
  }

  for (const l of lines) {
    if (/Your opening balance on\b/i.test(l.text)) {
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
      'RBC personal banking: could not extract opening balance ' +
        '("Opening Balance" row / "Your opening balance on …" line missing or without a dollar figure) — ' +
        'transaction signs would be unverifiable',
    );
  }
  return opening;
}

/**
 * Extract the closing balance.
 * Preference order:
 * 1. Summary line: " Your closing balance on <date>   = $X.XX"
 * 2. Activity section: " Closing Balance   $X.XX"
 * Only money-shaped tokens count (see extractOpeningBalance).
 */
function extractClosingBalance(lines: PdfLine[]): number | null {
  // 1. Summary line (preferred, most reliable)
  for (const l of lines) {
    if (/Your closing balance on\b/i.test(l.text)) {
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) return v;
    }
  }

  // 2. Activity section Closing Balance row
  let inSection = false;
  for (const l of lines) {
    if (/Details of your account activity/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[\s]*Closing Balance\b/i.test(l.text)) {
      const v = lastMoneyTokenValue(l.text);
      if (v !== null) return v;
    }
    if (/Important information about your account/i.test(l.text)) break;
  }

  return null;
}

type PendingRow = UnsignedRow;

export function parseRbcPersonalBankingActivity(
  lines: PdfLine[],
  period: Period,
  closingBalance: number | null = extractClosingBalance(lines),
  openingBalance: number = requireOpeningBalance(lines),
): { rows: Array<{ date: string; description: string; amount: number }>; parseErrors: StatementParseError[] } {
  const parseErrors: StatementParseError[] = [];

  // Slice the activity section: between "Details of your account activity"
  // and the first "Closing Balance" or "Important information about your account".
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/Details of your account activity/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[\s]*Closing Balance\b/i.test(l.text)) break;
    if (/Important information about your account/i.test(l.text)) break;
    if (/Details of your account activity\s*-\s*continued/i.test(l.text)) continue;
    activityLines.push(l);
  }

  // Collect pending rows from the activity section.
  const pending: PendingRow[] = [];
  let currentDate: string | null = null;
  let descBuffer: string[] = [];

  for (let i = 0; i < activityLines.length; i++) {
    const l = activityLines[i];
    const text = l.text.trim();
    if (!text) continue;

    // Skip the column header row.
    if (/^Date\s+Description/i.test(text)) continue;
    // Skip the opening balance row.
    if (/^Opening Balance\b/i.test(text)) continue;
    // Skip "No activity" rows.
    if (/^-?\s*No activity\b/i.test(text)) continue;

    const moneyTokens = extractTrailingMoneyTokens(text);
    const dateMatch = DATE_PREFIX_RE.exec(text);

    if (dateMatch) {
      // New dated row — flush desc buffer from any orphaned desc-only date row.
      descBuffer = [];
      try {
        currentDate = dayMonthToIso(dateMatch[1], period);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        continue;
      }

      // Extract description: strip date prefix and all money tokens.
      let desc = text.replace(DATE_PREFIX_RE, '').trim();
      for (const part of desc.split(/\s{2,}/)) {
        if (isMoneyToken(part.trim())) {
          desc = desc.replace(part, '').trim();
        }
      }
      desc = desc.replace(/\s{2,}/g, ' ').trim();

      if (moneyTokens.length === 0) {
        // Description-only dated row (multi-line txn, amounts on a subsequent dateless row).
        descBuffer = desc ? [desc] : [];
        continue;
      }

      pending.push({
        date: currentDate,
        description: desc || text.replace(DATE_PREFIX_RE, '').replace(/\s{2,}/g, ' ').trim(),
        rawAmount: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 2] : moneyTokens[0],
        balance: moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 1] : null,
      });
    } else {
      // Dateless row — either description continuation or a new amount-bearing row.
      if (moneyTokens.length === 0) {
        // Pure description continuation.
        descBuffer.push(text);
        continue;
      }

      // Has money tokens → it's an amount row (continuation of the last dated row's description).
      if (!currentDate) {
        parseErrors.push({ rowIndex: i + 1, message: `Dateless amount row with no current date: ${text}` });
        continue;
      }

      // Extract description from this dateless row (strip money tokens).
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
    }
  }

  const signed = signByRunningBalance(pending, openingBalance, closingBalance);
  return { rows: signed.rows, parseErrors: [...parseErrors, ...signed.parseErrors] };
}

export const rbcPersonalBankingParser: PdfParser = {
  id: 'rbc_personal_banking',
  label: 'RBC personal banking / savings',
  sniff: (lines) =>
    lines.some((l) =>
      /Your RBC personal (banking|savings) account statement/i.test(l.text),
    ),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcPersonalBankingHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const openingBalance = requireOpeningBalance(lines);
    const closingBalance = extractClosingBalance(lines);
    const { rows, parseErrors } = parseRbcPersonalBankingActivity(lines, period, closingBalance, openingBalance);

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

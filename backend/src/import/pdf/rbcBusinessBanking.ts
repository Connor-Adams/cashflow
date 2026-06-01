import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { dayMonthToIso, parseMoney, parsePeriod, type Period } from './dateHelpers';

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

/** Matches a transaction date prefix: "01 May" (two-digit day + 3-letter month). */
const DATE_PREFIX_RE = /^(\d{2}\s+[A-Z][a-z]{2})\b/;

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

type PendingRow = {
  date: string;          // ISO yyyy-mm-dd
  description: string;
  rawAmount: number;     // absolute value from the PDF
  balance: number | null;  // null if no balance column on this row
};

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
): { rows: Array<{ date: string; description: string; amount: number }>; parseErrors: { rowIndex: number; message: string }[] } {
  const parseErrors: { rowIndex: number; message: string }[] = [];

  // Slice the activity section.
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/Account Activity Details/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[\s]*Closing balance\b/i.test(l.text)) break;
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

    // Skip the column header row.
    if (/^Date\s+Description/i.test(text)) continue;
    // Skip the opening balance row.
    if (/^Opening balance\b/i.test(text)) continue;
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

  // Sign transactions using running balance delta.
  const rows: Array<{ date: string; description: string; amount: number }> = [];
  let runningBalance = openingBalance;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];

    if (row.balance !== null) {
      // Balance column present: sign from delta.
      const delta = row.balance - runningBalance;
      // delta should be ≈ +rawAmount (credit) or ≈ -rawAmount (debit).
      const signed = Math.abs(delta - row.rawAmount) < 0.015 ? row.rawAmount : -row.rawAmount;
      rows.push({ date: row.date, description: row.description, amount: signed });
      runningBalance = row.balance;
    } else {
      // No balance: infer sign using the next known balance.
      // Look ahead to find the next pending row that has a balance.
      let nextBalance: number | null = null;
      let knownAmountsBetween = 0;
      for (let j = i + 1; j < pending.length; j++) {
        if (pending[j].balance !== null) {
          nextBalance = pending[j].balance;
          break;
        }
        // Count other no-balance rows between this one and the next known balance.
        knownAmountsBetween++;
      }

      if (nextBalance !== null && knownAmountsBetween === 0) {
        // One no-balance row before the next known balance.
        // The next known balance was computed from a row that ALSO contributes.
        // But we need to sign THIS row first.
        // delta = nextBalance - runningBalance would include BOTH this row and the next row.
        // We can't sign this row without the next row's sign too.
        // Since next row has a balance, we use: this_signed = nextBalance - runningBalance - next_delta
        // where next_delta = nextKnownBalance - balance_after_this.
        // This is circular. Instead: use (nextBalance - runningBalance) as an approximation
        // and determine sign from rawAmount comparison.
        // Actually: if the next balance row has its balance, we know the delta that
        // covers BOTH this row and the next row's contribution.
        // We can defer signing until we process the next row, then back-fill.
        // For simplicity: mark this as needing back-fill.
        // Back-fill: after signing next row, set this row's signed = nextBalance - runningBalance - next_signed.
        const nextRow = pending.find((p, j) => j > i && p.balance !== null)!;
        const nextNextBalance = nextRow?.balance ?? runningBalance;
        // We don't know the sign yet — defer. Use a sentinel.
        rows.push({ date: row.date, description: row.description, amount: NaN }); // placeholder
        // We'll fix it up below once we process the next row.
        // Store the index for fixup.
        const placeholderIdx = rows.length - 1;
        // Process next row immediately to get its sign.
        // But we need runningBalance to have moved — we can't do that yet.
        // Use a different approach: the no-balance row and the next known-balance row together.
        // total_delta = nextKnownBalance - runningBalance
        // this_signed + next_signed = total_delta
        // |this_signed| = rawAmount, |next_signed| = nextRow.rawAmount
        // Case 1: both credits: this_signed = +rawAmount, next_signed = +nextRow.rawAmount
        // Case 2: this credit, next debit: +rawAmount - nextRow.rawAmount = total_delta
        // Case 3: this debit, next credit: -rawAmount + nextRow.rawAmount = total_delta
        // Case 4: both debits: -rawAmount - nextRow.rawAmount = total_delta
        const totalDelta = nextNextBalance - runningBalance;
        const r1 = row.rawAmount;
        const r2 = nextRow.rawAmount;

        // Find the combination that matches totalDelta within tolerance.
        const candidates: [number, number][] = [
          [r1, r2],   // both credits
          [r1, -r2],  // credit, then debit
          [-r1, r2],  // debit, then credit
          [-r1, -r2], // both debits
        ];

        let matched = false;
        for (const [s1, s2] of candidates) {
          if (Math.abs(s1 + s2 - totalDelta) < 0.015) {
            rows[placeholderIdx] = { date: row.date, description: row.description, amount: s1 };
            runningBalance += s1;
            // Sign next row directly.
            rows.push({ date: nextRow.date, description: nextRow.description, amount: s2 });
            runningBalance = nextNextBalance;
            i++; // skip next row (already processed)
            matched = true;
            break;
          }
        }
        if (!matched) {
          // Fallback: assume credit.
          rows[placeholderIdx] = { date: row.date, description: row.description, amount: row.rawAmount };
          parseErrors.push({ rowIndex: i + 1, message: `Could not determine sign for no-balance row: ${row.description}` });
          runningBalance += row.rawAmount;
        }
      } else if (nextBalance === null) {
        // Last transaction, no more balances — assume credit if balance delta is positive.
        // Without another balance, default to credit (common for last Misc Payment credit).
        // Use the closing balance if known, otherwise assume credit.
        rows.push({ date: row.date, description: row.description, amount: row.rawAmount });
        parseErrors.push({ rowIndex: i + 1, message: `Last transaction has no balance column; defaulting to credit: ${row.description}` });
        runningBalance += row.rawAmount;
      } else {
        // Multiple no-balance rows before the next known balance — more complex.
        // Rare case: use rawAmount as credit (best guess).
        rows.push({ date: row.date, description: row.description, amount: row.rawAmount });
        parseErrors.push({ rowIndex: i + 1, message: `No-balance row with multiple unknowns ahead; defaulting to credit: ${row.description}` });
        runningBalance += row.rawAmount;
      }
    }
  }

  // Fix up any remaining NaN rows (shouldn't happen with the algorithm above).
  const output = rows.filter((r) => {
    if (isNaN(r.amount)) {
      parseErrors.push({ rowIndex: -1, message: `Dropping unresolved no-balance placeholder: ${r.description}` });
      return false;
    }
    return true;
  });

  return { rows: output, parseErrors };
}

/** Extract the opening balance from the "Opening balance X" line in the activity section. */
function extractOpeningBalance(lines: PdfLine[]): number {
  for (const l of lines) {
    if (/^[\s]*Opening balance\b/i.test(l.text)) {
      const tokens = l.text.split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i--) {
        const v = parseMoney(tokens[i]);
        if (Number.isFinite(v)) return v;
      }
    }
  }
  return 0; // fallback
}

export const rbcBusinessBankingParser: PdfParser = {
  id: 'rbc_business_banking',
  label: 'RBC business banking (chequing)',
  sniff: (lines) => lines.some((l) => TITLE_RE.test(l.text)),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcBusinessBankingHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const openingBalance = extractOpeningBalance(lines);
    const { rows, parseErrors } = parseRbcBusinessBankingActivity(lines, period, openingBalance);

    const transactions: PdfParseResult['transactions'] = rows.map((row) => {
      const merchantClean = normalizeMerchant(row.description);
      return {
        date: row.date,
        merchantRaw: row.description,
        merchantClean,
        amount: row.amount,
        currency: ctx.defaultCurrency,
        sourceReference: null,
      };
    });

    return {
      transactions,
      header,
      warnings: [],
      parseErrors,
    };
  },
};

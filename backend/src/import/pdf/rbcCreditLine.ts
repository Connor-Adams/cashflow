import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { dayMonthToIso, parseLongDate, parseMoney, type Period } from './dateHelpers';

/**
 * RBC Royal Credit Line statement parser.
 *
 * Handles monthly statements (e.g. "From July 8, 2025 to August 4, 2025").
 * Does NOT handle the annual summary statement format (no transaction rows).
 *
 * Layout markers:
 *   Title:    "Your Royal Credit Line® Statement" OR "Your Royal Credit Line Statement"
 *             Also sniffed via " Statement" after "Your Royal Credit Line"
 *   Period:   "From November 4, 2025 to December 3, 2025"
 *   Account:  "Your loan account number: 73772650-001"  (last 4 = "0001")
 *   Section:  "Details of your account activity"
 *   Columns:  Date | Description | Interest/Fees/Insurance ($) | Withdrawals ($) | Payments ($) | Balance owing ($)
 *   Termination: "Your LoanProtector insurance coverage summary" OR "Rate History"
 *
 * Balance column semantics:
 *   - SIGNED: negative = amount owed (e.g. -4,000.00 = $4,000 owed)
 *   - Withdrawals increase debt (balance more negative) → cashflow negative
 *   - Payments decrease debt (balance less negative) → cashflow positive
 *   - Interest/fees do NOT change principal balance (processed separately to payment account)
 *     → delta = 0 → detected as interest/fee → cashflow negative
 *
 * Opening/closing balance:
 *   - From summary section: "Principal balance on <date>   $X.XX" (POSITIVE; internally negated)
 *
 * pdfjs note: pdfjs v5 glues all row items into a SINGLE positioned span. The
 * original column-midpoint (findColumnAnchors) approach found 0 money items.
 * Fix: split each row on 2+ spaces, extract trailing money tokens, use
 * running-balance delta to determine sign. Mirror rbcBusinessBanking approach.
 *
 * Reconciliation gate: |opening_principal + Σsigned_principal_impact| - closing_principal| ≤ 0.015.
 * Interest rows do not impact principal, so they are excluded from the sum.
 */

const ACCOUNT_RE = /Your loan account number:\s*([\d-]+)/;
const PERIOD_RE = /From\s+(.+?to\s+.+?\d{4})/;
const MONEY_RE = /^-?\$?[\d,]+\.\d{2}$/;

export function parseRbcCreditLineHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountFull: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_RE.exec(l.text);
    if (m) {
      accountFull = m[1];
      break;
    }
  }
  if (!accountFull) {
    throw new Error('RBC Credit Line header: could not find loan account number');
  }
  // Last 4 of trailing segment (e.g. "73772650-001" → "0001").
  const tail = accountFull.split('-').pop() ?? accountFull;
  const accountSuffix = tail.padStart(4, '0').slice(-4);

  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const [startStr, endStr] = m[1].split(/\s+to\s+/);
    const startIso = parseLongDate(startStr);
    const endIso = parseLongDate(endStr);
    if (startIso && endIso) {
      period = { start: startIso, end: endIso };
      break;
    }
  }
  if (!period) {
    throw new Error('RBC Credit Line header: could not parse statement period');
  }

  return {
    accountSuffix,
    productLabel: 'Royal Credit Line',
    accountType: 'loan',
    periodStart: period.start,
    periodEnd: period.end,
  };
}

function isMoneyToken(s: string): boolean {
  return MONEY_RE.test(s.trim());
}

const DATE_PREFIX = /^(\d{1,2}\s+[A-Z][a-z]{2})\b/;

/**
 * Extract trailing money tokens from a row of text.
 * Splits on 2+ spaces (column separator in glued pdfjs output).
 * Strips the date prefix first to avoid day number matching as a token.
 */
function extractTrailingMoneyTokens(text: string): number[] {
  const stripped = text.replace(DATE_PREFIX, '').trim();
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
 * Extract the opening balance from the summary section.
 * Format: "Principal balance on [period-start-date]   $X.XX" (positive value).
 * Returns the positive principal balance (we track it as negative internally).
 */
function extractOpeningPrincipal(lines: PdfLine[]): number {
  // We look for the first "Principal balance on" line that refers to the opening date.
  for (const l of lines) {
    if (/Principal balance on\b/i.test(l.text)) {
      // Extract the date and check if it's before or at period start.
      // Simpler: take the FIRST such line encountered (it's the opening).
      const tokens = l.text.trim().split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i--) {
        const v = parseMoney(tokens[i]);
        if (Number.isFinite(v)) return Math.abs(v);
      }
    }
  }
  return 0;
}

/**
 * Extract the closing balance from the summary section.
 * Format: "Principal balance on [period-end-date]   $X.XX" (positive value).
 * Returns the positive principal balance, or null if not found.
 */
function extractClosingPrincipal(lines: PdfLine[]): number | null {
  // The LAST "Principal balance on" line is the closing balance.
  let closing: number | null = null;
  for (const l of lines) {
    if (/Principal balance on\b/i.test(l.text)) {
      const tokens = l.text.trim().split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i--) {
        const v = parseMoney(tokens[i]);
        if (Number.isFinite(v)) {
          closing = Math.abs(v);
          break;
        }
      }
    }
  }
  return closing;
}

type PendingRow = {
  date: string;           // ISO yyyy-mm-dd
  description: string;
  rawAmount: number;      // absolute value from PDF
  signedBalance: number | null;  // balance column value (negative = owed), null if absent
};

type CreditLineRow = {
  date: string;
  description: string;
  amount: number;           // signed: negative = withdrawal/interest, positive = payment
  isPrincipalChange: boolean; // false for interest/fee rows that don't move principal
};

export function parseRbcCreditLineActivity(
  lines: PdfLine[],
  period: Period,
  openingPrincipal: number,
): { rows: CreditLineRow[]; parseErrors: { rowIndex: number; message: string }[] } {
  const parseErrors: { rowIndex: number; message: string }[] = [];

  // Activity section: between "Details of your account activity" and
  // "Your LoanProtector insurance coverage summary" or "Rate History".
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/Details of your account activity/i.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/Your LoanProtector insurance/i.test(l.text)) break;
    if (/Rate History for your Statement Period/i.test(l.text)) break;
    if (/Important information about your account/i.test(l.text)) break;
    if (/Details of your account activity\s*-\s*continued/i.test(l.text)) continue;
    activityLines.push(l);
  }

  // Collect pending rows.
  const pending: PendingRow[] = [];
  let currentDate: string | null = null;
  let descBuffer: string[] = [];

  for (let i = 0; i < activityLines.length; i++) {
    const l = activityLines[i];
    const text = l.text.trim();
    if (!text) continue;
    if (/^Date\s+Description/i.test(text)) continue;

    const moneyTokens = extractTrailingMoneyTokens(text);
    const dateMatch = DATE_PREFIX.exec(text);

    if (dateMatch) {
      // New dated row.
      descBuffer = [];
      try {
        currentDate = dayMonthToIso(dateMatch[1], period);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        continue;
      }

      // Extract description: strip date prefix and money tokens.
      let desc = text.replace(DATE_PREFIX, '').trim();
      for (const part of desc.split(/\s{2,}/)) {
        if (isMoneyToken(part.trim())) {
          desc = desc.replace(part, '').trim();
        }
      }
      desc = desc.replace(/\s{2,}/g, ' ').trim();

      if (moneyTokens.length === 0) {
        // Description-only row (amount on subsequent dateless row).
        descBuffer = desc ? [desc] : [];
        continue;
      }

      // Signed balance is the LAST money token (negative = owed).
      // Raw amount is second-to-last if 2+ tokens, otherwise the only token.
      const signedBalance = moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 1] : null;
      const rawAmount = moneyTokens.length >= 2
        ? Math.abs(moneyTokens[moneyTokens.length - 2])
        : Math.abs(moneyTokens[0]);

      pending.push({
        date: currentDate,
        description: desc || text.replace(DATE_PREFIX, '').replace(/\s{2,}/g, ' ').trim(),
        rawAmount,
        signedBalance,
      });
    } else {
      // Dateless row — continuation or amount row.
      if (moneyTokens.length === 0) {
        descBuffer.push(text);
        continue;
      }

      if (!currentDate) {
        parseErrors.push({ rowIndex: i + 1, message: `Dateless amount row with no current date: ${text}` });
        continue;
      }

      let desc = text;
      for (const part of desc.split(/\s{2,}/)) {
        if (isMoneyToken(part.trim())) {
          desc = desc.replace(part, '').trim();
        }
      }
      desc = desc.replace(/\s{2,}/g, ' ').trim();

      const fullDesc = [...descBuffer, desc].filter((s) => s.length > 0).join(' ').trim();
      descBuffer = [];

      const signedBalance = moneyTokens.length >= 2 ? moneyTokens[moneyTokens.length - 1] : null;
      const rawAmount = moneyTokens.length >= 2
        ? Math.abs(moneyTokens[moneyTokens.length - 2])
        : Math.abs(moneyTokens[0]);

      pending.push({
        date: currentDate,
        description: fullDesc || desc,
        rawAmount,
        signedBalance,
      });
    }
  }

  // Sign transactions using running-balance delta.
  // The balance column is SIGNED NEGATIVE (amount owed), e.g. -4000 = $4000 owed.
  // runningSignedBalance tracks the signed balance column value.
  const rows: CreditLineRow[] = [];
  // Opening principal is positive (e.g. 4000 owed = -4000 in balance column).
  let runningSignedBalance = -openingPrincipal;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];

    if (row.signedBalance !== null) {
      const delta = row.signedBalance - runningSignedBalance;
      // delta < 0 → withdrawal (debt increased) → cashflow negative
      // delta > 0 → payment (debt decreased) → cashflow positive
      // delta ≈ 0 → interest/fee (no principal change) → cashflow negative (it's a cost)

      const EPSILON = 0.015;
      let amount: number;
      let isPrincipalChange: boolean;

      if (Math.abs(delta) < EPSILON) {
        // Zero delta: interest/fee row. Amount is the raw value, sign is negative.
        amount = -row.rawAmount;
        isPrincipalChange = false;
      } else if (delta < 0) {
        // Withdrawal: debt increased.
        amount = -row.rawAmount;
        isPrincipalChange = true;
      } else {
        // Payment: debt decreased.
        amount = row.rawAmount;
        isPrincipalChange = true;
      }

      rows.push({ date: row.date, description: row.description, amount, isPrincipalChange });
      runningSignedBalance = row.signedBalance;
    } else {
      // No balance column: look ahead for sign resolution.
      let nextBalance: number | null = null;
      let unknownsBetween = 0;
      for (let j = i + 1; j < pending.length; j++) {
        if (pending[j].signedBalance !== null) {
          nextBalance = pending[j].signedBalance;
          break;
        }
        unknownsBetween++;
      }

      if (nextBalance !== null && unknownsBetween === 0) {
        const nextRow = pending.find((p, j) => j > i && p.signedBalance !== null)!;
        const nextNextBalance = nextRow.signedBalance!;
        const totalDelta = nextNextBalance - runningSignedBalance;
        const r1 = row.rawAmount;
        const r2 = nextRow.rawAmount;

        const candidates: [number, number][] = [
          [r1, r2], [r1, -r2], [-r1, r2], [-r1, -r2],
        ];
        const matching = candidates.filter(([s1, s2]) => Math.abs(s1 + s2 - totalDelta) < 0.015);

        if (matching.length > 1) {
          const [s1, s2] = matching[0];
          rows.push({ date: row.date, description: row.description, amount: s1, isPrincipalChange: true });
          runningSignedBalance += s1;
          rows.push({ date: nextRow.date, description: nextRow.description, amount: s2, isPrincipalChange: true });
          runningSignedBalance = nextNextBalance;
          i++;
          parseErrors.push({
            rowIndex: i,
            message: `ambiguous sign for no-balance row pair: ${matching.length} combinations match delta ${totalDelta.toFixed(2)}; best-guess used`,
          });
        } else if (matching.length === 1) {
          const [s1, s2] = matching[0];
          rows.push({ date: row.date, description: row.description, amount: s1, isPrincipalChange: true });
          runningSignedBalance += s1;
          rows.push({ date: nextRow.date, description: nextRow.description, amount: s2, isPrincipalChange: true });
          runningSignedBalance = nextNextBalance;
          i++;
        } else {
          rows.push({ date: row.date, description: row.description, amount: -row.rawAmount, isPrincipalChange: true });
          parseErrors.push({ rowIndex: i + 1, message: `Could not determine sign for no-balance row: ${row.description}` });
          runningSignedBalance -= row.rawAmount;
        }
      } else {
        rows.push({ date: row.date, description: row.description, amount: -row.rawAmount, isPrincipalChange: true });
        parseErrors.push({ rowIndex: i + 1, message: `No-balance row, defaulting to withdrawal: ${row.description}` });
        runningSignedBalance -= row.rawAmount;
      }
    }
  }

  return { rows, parseErrors };
}

export const rbcCreditLineParser: PdfParser = {
  id: 'rbc_credit_line',
  label: 'RBC Royal Credit Line',
  sniff: (lines) =>
    lines.some((l) => /Your Royal Credit Line.{0,3}\s*Statement/i.test(l.text)),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcCreditLineHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };

    const openingPrincipal = extractOpeningPrincipal(lines);
    const closingPrincipal = extractClosingPrincipal(lines);

    const { rows, parseErrors } = parseRbcCreditLineActivity(lines, period, openingPrincipal);

    const transactions: PdfParseResult['transactions'] = rows.map((row) => ({
      date: row.date,
      merchantRaw: row.description,
      merchantClean: normalizeMerchant(row.description),
      amount: row.amount,
      currency: ctx.defaultCurrency,
      sourceReference: null,
    }));

    // ── Reconciliation gate ─────────────────────────────────────────────────
    // Reconcile principal balance: opening + Σ(principal-change amounts) ≈ closing.
    // Interest/fee rows (isPrincipalChange=false) are excluded from the principal sum.
    if (closingPrincipal === null) {
      parseErrors.push({
        rowIndex: -1,
        message: 'reconciliation: could not extract closing balance from statement; gate skipped',
      });
    } else {
      const principalDelta = rows
        .filter((r) => r.isPrincipalChange)
        .reduce((acc, r) => acc + r.amount, 0);
      // For a credit line, closing principal = opening principal - principalDelta.
      // This is because:
      //   - Withdrawal cashflow is NEGATIVE (money flows out), but INCREASES principal owed.
      //   - Payment cashflow is POSITIVE (money flows in), but DECREASES principal owed.
      // So: closing = opening - (sum of principal cashflow amounts)
      // e.g., opening=0, withdrawals sum to -9000 (delta=-9000), payments sum to +5000 (delta=+5000)
      //   closing = 0 - (-9000 + 5000) = 0 - (-4000) = 4000 ✓
      const recomputed2 = openingPrincipal - principalDelta;
      if (Math.abs(recomputed2 - closingPrincipal) > 0.015) {
        parseErrors.push({
          rowIndex: -1,
          message: `statement does not reconcile: opening ${openingPrincipal} - principal changes ${principalDelta.toFixed(2)} = ${recomputed2.toFixed(2)}, expected closing ${closingPrincipal}`,
        });
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    return {
      transactions,
      header,
      warnings: [],
      parseErrors,
    };
  },
};

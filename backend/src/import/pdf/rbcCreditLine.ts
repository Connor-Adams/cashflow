import type { PdfLine, PdfParser, PdfParseResult, PdfRatePeriod, PdfStatementHeader, StatementParseError } from './types';
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
 * No-balance rows: when the balance-owing column can't be read for a row, the
 * sign is resolved by (1) the description, for interest/fee wording, which the
 * delta arithmetic cannot resolve because interest never moves the principal;
 * (2) a two-row balance lookahead; (3) the description again, for the
 * payment/withdrawal wording RBC uses. Only a description matching nothing
 * falls back to the blind "withdrawal" guess, and that records a parseError.
 * See classifyRowByDescription — guessing "withdrawal + principal change"
 * unconditionally booked a 6,400 payment as a 6,400 withdrawal (a 12,800 error)
 * and leaked interest rows into the principal.
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
 * Returns the positive principal balance (we track it as negative internally),
 * or null when the line is missing or carries no dollar figure (e.g. the
 * amount wrapped to the next line). Only money-shaped tokens count — a bare
 * "2025" from the date must not parse as a $2,025.00 balance. The caller
 * treats null as a hard parse error: signing is delta-based from the opening,
 * so defaulting to 0 silently flips leading payment rows.
 */
function extractOpeningPrincipal(lines: PdfLine[]): number | null {
  // The FIRST "Principal balance on" line is the opening one — do NOT fall
  // through to later lines (the next one is the closing balance).
  for (const l of lines) {
    if (/Principal balance on\b/i.test(l.text)) {
      const tokens = l.text.trim().split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (!isMoneyToken(tokens[i])) continue;
        const v = parseMoney(tokens[i]);
        if (Number.isFinite(v)) return Math.abs(v);
      }
      return null;
    }
  }
  return null;
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
        if (!isMoneyToken(tokens[i])) continue;
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

/**
 * What an activity row does to the account, read off its description alone.
 *
 * The balance-owing column is the authoritative signal and is used whenever it
 * is readable; this is the fallback for rows where it is not. RBC's wording on
 * a Royal Credit Line is unambiguous:
 *
 *   - `WWW PMT <ref> (<amount>) Principal` — a payment against the line.
 *     Positive cashflow; reduces the principal owed.
 *   - `WWW TFR <ref>` / `Withdrawal` / `Advance` — money drawn off the line.
 *     Negative cashflow; increases the principal owed.
 *   - `Interest Payment` (and other interest/fee/insurance wording) — billed to
 *     the linked chequing account, NOT capitalised into the principal. Negative
 *     cashflow, but `isPrincipalChange: false`: it must stay out of the
 *     reconciliation sum and out of the emitted transactions (the chequing
 *     statement already records the same cash leaving).
 *
 * Interest is tested FIRST because "Interest Payment" also contains "Payment" —
 * matching payment first would flip a cost into a credit.
 */
type RowKind = 'payment' | 'withdrawal' | 'interest';

const INTEREST_DESC_RE = /\b(interest|fee|fees|insurance|loanprotector|premium|service\s+charge)\b/i;
const PAYMENT_DESC_RE = /\b(WWW\s+PMT|payment|pmt)\b/i;
const WITHDRAWAL_DESC_RE = /\b(WWW\s+TFR|withdrawal|advance|tfr)\b/i;

function classifyRowByDescription(description: string): RowKind | null {
  if (INTEREST_DESC_RE.test(description)) return 'interest';
  if (PAYMENT_DESC_RE.test(description)) return 'payment';
  if (WITHDRAWAL_DESC_RE.test(description)) return 'withdrawal';
  return null;
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
): { rows: CreditLineRow[]; parseErrors: StatementParseError[] } {
  const parseErrors: StatementParseError[] = [];

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
      // No balance column. Resolve the sign from the description first where
      // the description settles the matter on its own, then fall back to the
      // two-row balance lookahead, then to the description again.
      const kind = classifyRowByDescription(row.description);

      // Interest/fee rows never move the principal, so there is no balance
      // delta for the lookahead below to match against — running it would at
      // best fail and at worst find a coincidental combination. Short-circuit:
      // negative cashflow, NOT a principal change, running balance untouched.
      if (kind === 'interest') {
        rows.push({
          date: row.date,
          description: row.description,
          amount: -row.rawAmount,
          isPrincipalChange: false,
        });
        continue;
      }

      /**
       * Last resort once the balance column has failed to settle the sign:
       * believe the description. Only a description that matches nothing keeps
       * the historical blind "withdrawal" guess, and that case still records a
       * parseError so the reconciliation gate's verdict can be read against it.
       */
      const resolveFromDescription = () => {
        const isPayment = kind === 'payment';
        const amount = isPayment ? row.rawAmount : -row.rawAmount;
        rows.push({
          date: row.date,
          description: row.description,
          amount,
          isPrincipalChange: true,
        });
        runningSignedBalance += amount;
        if (kind === null) {
          parseErrors.push({
            rowIndex: i + 1,
            message: `Could not determine sign for no-balance row (description matches no known credit-line wording), defaulting to withdrawal: ${row.description}`,
          });
        }
      };

      // Look ahead for sign resolution.
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
          resolveFromDescription();
        }
      } else {
        resolveFromDescription();
      }
    }
  }

  return { rows, parseErrors };
}

const RATE_HEADING_RE = /Rate History for your Statement Period/i;

/** Match one column of a rate row: "4.450 %", "+4.490 %", "-0.500 %". */
const RATE_PCT_RE = /^([+-]?[\d.]+)\s*%$/;

/**
 * Parse one candidate line from the Rate History table into a rate period,
 * or null if it doesn't have the row shape.
 *
 * Row layout (glued into one span by pdfjs, per the module header note):
 *   "<from date>   <to date>   <prime> %   <premium> %   <effective> %   <interest>"
 * Split on 2+ spaces (dates and "Prime Rate" text use single spaces
 * internally, so this cleanly separates the six columns) then validate each
 * column's shape. Requiring both dates to parse via parseLongDate is what
 * rejects the column-header row ("Rate from and including ...") and the
 * page-1 marketing line ("Prime Rate + 4.490 % = 8.940 %  ...") even though
 * the latter also contains percentages.
 */
function parseRateRow(text: string): PdfRatePeriod | null {
  const parts = text.trim().split(/\s{2,}/);
  if (parts.length !== 6) return null;
  const [fromRaw, toRaw, primeRaw, premiumRaw, effectiveRaw, interestRaw] = parts;

  const fromDate = parseLongDate(fromRaw);
  const toDate = parseLongDate(toRaw);
  if (!fromDate || !toDate) return null;

  const primeMatch = RATE_PCT_RE.exec(primeRaw.trim());
  const premiumMatch = RATE_PCT_RE.exec(premiumRaw.trim());
  const effectiveMatch = RATE_PCT_RE.exec(effectiveRaw.trim());
  if (!primeMatch || !premiumMatch || !effectiveMatch) return null;

  const interest = parseMoney(interestRaw.trim());
  if (!Number.isFinite(interest)) return null;

  const fixed4 = (n: number) => n.toFixed(4);
  return {
    fromDate,
    toDate,
    primeRate: fixed4(Number(primeMatch[1])),
    premium: fixed4(Number(premiumMatch[1])),
    effectiveRate: fixed4(Number(effectiveMatch[1])),
    applicableInterest: fixed4(interest),
  };
}

/**
 * Read the "Rate History for your Statement Period" table: one row per
 * window during which the prime rate (and thus the effective rate charged)
 * held steady. Returns [] when the heading is absent — the annual-summary
 * format and any statement predating this section both fall through here
 * without throwing.
 *
 * Scans lines strictly after the heading, on the same page, until a line
 * fails to parse as a row after at least one row has already been read
 * (signalling the next section, e.g. "Important information about your
 * account"). A single non-row line before the first match is tolerated —
 * that's the column-header row ("Rate from and including ...") — and simply
 * skipped rather than treated as a terminator.
 */
export function parseRbcCreditLineRates(lines: PdfLine[]): PdfRatePeriod[] {
  const headingIdx = lines.findIndex((l) => RATE_HEADING_RE.test(l.text));
  if (headingIdx === -1) return [];

  const headingPage = lines[headingIdx].page;
  const rows: PdfRatePeriod[] = [];

  for (let i = headingIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.page !== headingPage) break;

    const row = parseRateRow(l.text);
    if (row) {
      rows.push(row);
      continue;
    }
    if (rows.length > 0) break;
    // Otherwise: the column-header row (or blank filler) before any data — skip it.
  }

  return rows;
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
    if (openingPrincipal === null) {
      throw new Error(
        'RBC Credit Line: could not extract opening principal balance ' +
          '("Principal balance on …" line missing or without a dollar figure) — ' +
          'transaction signs would be unverifiable',
      );
    }
    const closingPrincipal = extractClosingPrincipal(lines);

    const { rows, parseErrors } = parseRbcCreditLineActivity(lines, period, openingPrincipal);

    // Only principal movements become transactions. Interest on a Royal Credit
    // Line is billed to the linked chequing account, not capitalised into the
    // principal — the statement shows it by leaving the balance-owing column
    // unchanged across an interest row — and the chequing statement already
    // records that cash leaving as "Loan interest". Emitting it here as well
    // booked the cost twice and overstated the amount owing by the cumulative
    // interest. The rows themselves are kept above: the reconciliation gate
    // needs to see them.
    const transactions: PdfParseResult['transactions'] = rows
      .filter((row) => row.isPrincipalChange)
      .map((row) => ({
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
    //
    // A mismatch is marked `blocking: true`: it is not one bad row, it is the
    // parser reporting that it misread the document, so commitStatementImport
    // refuses the import outright. This gate is the one that caught the +6,400
    // payment booked as a -6,400 withdrawal — and was then ignored, which is
    // exactly what `blocking` exists to prevent. A missing closing balance only
    // means the gate could not run; that stays a plain parse error.
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
          blocking: true,
          message: `statement does not reconcile: opening ${openingPrincipal} - principal changes ${principalDelta.toFixed(2)} = ${recomputed2.toFixed(2)}, expected closing ${closingPrincipal}`,
        });
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    return {
      transactions,
      header,
      ratePeriods: parseRbcCreditLineRates(lines),
      warnings: [],
      parseErrors,
    };
  },
};

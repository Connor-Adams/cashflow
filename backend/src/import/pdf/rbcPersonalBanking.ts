import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader, PdfTextSpan } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { dayMonthToIso, parseLongDate, parseMoney, type Period } from './dateHelpers';

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

type ActivityRow = {
  date: string;        // ISO yyyy-mm-dd
  description: string;
  amount: number;      // signed: + deposit, - withdrawal
};

/**
 * Detect the X centroid of the Withdrawals vs Deposits columns by looking at
 * the header line "Date Description Withdrawals ($) Deposits ($) Balance ($)".
 * Returns the midpoint x between the two columns — amounts left of midpoint
 * are withdrawals, right of midpoint are deposits. Balance (rightmost) is
 * filtered separately.
 */
function findColumnMidpoint(lines: PdfLine[]): { withdrawalMid: number; balanceMin: number } | null {
  for (const l of lines) {
    if (!/Withdrawals\s*\(\$\)/.test(l.text) || !/Deposits\s*\(\$\)/.test(l.text)) continue;
    const items = l.items ?? [];
    let withdrawalX: number | null = null;
    let depositsX: number | null = null;
    let balanceX: number | null = null;
    for (let i = 0; i < items.length; i++) {
      const text = items[i].str;
      if (/^Withdrawals$/.test(text)) withdrawalX = items[i].x;
      if (/^Deposits$/.test(text)) depositsX = items[i].x;
      if (/^Balance$/.test(text)) balanceX = items[i].x;
    }
    if (withdrawalX != null && depositsX != null) {
      const withdrawalMid = (withdrawalX + depositsX) / 2;
      return { withdrawalMid, balanceMin: balanceX ?? Number.POSITIVE_INFINITY };
    }
  }
  return null;
}

const MONEY_RE = /^-?\$?[\d,]+\.\d{2}(?:\s*CR)?$/i;

function isMoneyToken(s: string): boolean {
  return MONEY_RE.test(s.trim());
}

function classifyAmount(
  rightmostMoneySpans: PdfTextSpan[],
  cols: { withdrawalMid: number; balanceMin: number } | null,
): { withdrawal: number | null; deposit: number | null; balance: number | null } {
  // Trim from the right: rightmost numeric span is balance if its X >= balanceMin.
  // Otherwise its X compared to withdrawalMid decides withdrawal vs deposit.
  if (rightmostMoneySpans.length === 0) {
    return { withdrawal: null, deposit: null, balance: null };
  }
  let withdrawal: number | null = null;
  let deposit: number | null = null;
  let balance: number | null = null;
  for (const span of rightmostMoneySpans) {
    const val = parseMoney(span.str);
    if (!Number.isFinite(val)) continue;
    if (cols && span.x >= cols.balanceMin - 5) {
      balance = val;
    } else if (cols && span.x < cols.withdrawalMid) {
      withdrawal = val;
    } else if (cols && span.x >= cols.withdrawalMid && span.x < cols.balanceMin - 5) {
      deposit = val;
    } else {
      // No column hints — fall back to span count: if 2 spans, [amount, balance].
      if (balance == null && rightmostMoneySpans.indexOf(span) === rightmostMoneySpans.length - 1) {
        balance = val;
      } else if (deposit == null) {
        deposit = val;
      }
    }
  }
  return { withdrawal, deposit, balance };
}

/**
 * Find all money-token spans on a line, in left-to-right order.
 */
function collectMoneySpans(line: PdfLine): PdfTextSpan[] {
  const items = line.items;
  if (!items || items.length === 0) {
    // Fallback to splitting line.text by 2+ spaces and inventing X positions
    // proportional to character position. Used by synthetic test fixtures.
    const tokens = line.text.split(/\s{2,}/);
    const spans: PdfTextSpan[] = [];
    let xOffset = 0;
    for (const t of tokens) {
      if (isMoneyToken(t)) spans.push({ x: xOffset, width: t.length * 5, str: t.trim() });
      xOffset += (t.length + 2) * 5;
    }
    return spans;
  }
  return items.filter((it) => isMoneyToken(it.str));
}

export function parseRbcPersonalBankingActivity(
  lines: PdfLine[],
  period: Period,
): { rows: ActivityRow[]; parseErrors: { rowIndex: number; message: string }[] } {
  const rows: ActivityRow[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];
  const cols = findColumnMidpoint(lines);

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
    if (/Closing Balance/i.test(l.text)) {
      // Capture the closing balance line itself? It's not a txn, just stop.
      break;
    }
    if (/Important information about your account/i.test(l.text)) break;
    if (/Details of your account activity - continued/i.test(l.text)) continue;
    activityLines.push(l);
  }

  // Walk lines, tracking the current date and accumulating multi-line descriptions.
  let currentDate: string | null = null;
  let descBuffer: string[] = [];

  const flushTxn = (line: PdfLine, idx: number): void => {
    if (!currentDate) {
      // Date not yet known — skip (probably header noise like column labels).
      descBuffer = [];
      return;
    }
    const moneySpans = collectMoneySpans(line);
    if (moneySpans.length === 0) {
      // Pure description line — accumulate, don't emit.
      const desc = line.text.trim();
      if (desc) descBuffer.push(desc);
      return;
    }
    const { withdrawal, deposit, balance: _balance } = classifyAmount(moneySpans, cols);
    void _balance;
    const amount = deposit != null ? deposit : withdrawal != null ? -withdrawal : null;
    if (amount == null) {
      parseErrors.push({ rowIndex: idx + 1, message: `Could not classify amount in line: ${JSON.stringify(line.text)}` });
      return;
    }
    // Extract description from line: strip the date prefix (if present) and money tokens.
    let text = line.text.replace(DATE_PREFIX_RE, '').trim();
    for (const span of moneySpans) {
      text = text.replace(span.str, '').trim();
    }
    text = text.replace(/\s{2,}/g, ' ').trim();
    const fullDesc = [...descBuffer, text].filter((s) => s.length > 0).join(' ').trim();
    descBuffer = [];
    if (!fullDesc) {
      parseErrors.push({ rowIndex: idx + 1, message: `Empty description on txn row` });
      return;
    }
    rows.push({ date: currentDate, description: fullDesc, amount });
  };

  for (let i = 0; i < activityLines.length; i++) {
    const line = activityLines[i];
    const text = line.text.trim();

    // Skip empties + the table header repeated on continuation pages.
    if (!text) continue;
    if (/^Date\s+Description/i.test(text)) continue;
    if (/^Opening Balance/i.test(text)) {
      // Reset date — Opening Balance is the first row, balance is the last money token.
      descBuffer = [];
      continue;
    }
    if (/^- No activity for this period/i.test(text)) continue;

    const dateMatch = DATE_PREFIX_RE.exec(text);
    if (dateMatch) {
      // New row starts. If buffer has accumulated text without an amount, drop it.
      descBuffer = [];
      try {
        currentDate = dayMonthToIso(dateMatch[1], period);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        continue;
      }
      flushTxn(line, i);
    } else {
      flushTxn(line, i);
    }
  }

  return { rows, parseErrors };
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
    const { rows, parseErrors } = parseRbcPersonalBankingActivity(lines, period);

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

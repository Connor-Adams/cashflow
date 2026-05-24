import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader, PdfTextSpan } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { dayMonthToIso, parseLongDate, parseMoney, type Period } from './dateHelpers';

/**
 * RBC Royal Credit Line statement parser.
 *
 * Layout markers:
 *   Title:    "Your Royal Credit Line® Statement"
 *   Period:   "From November 4, 2025 to December 3, 2025"
 *   Account:  "Your loan account number: 73772650-001"  (last 4 = "0001")
 *   Section:  "Details of your account activity"
 *   Columns:  Date | Description | Interest/Fees/Insurance ($) | Withdrawals ($) | Payments ($) | Balance owing ($)
 *
 * Sign convention (cashflow side):
 *   Withdrawals (loan draw) → negative
 *   Payments (paydown)      → positive
 *   Interest/Fees/Insurance → negative
 *
 * Account type: `loan` (new enum value).
 *
 * Multi-line rows: "WWW PMT TIN0-02134 (550.00) / Principal 550.00 -2,000.00"
 * — the description spans two lines; the amount + balance live on the second.
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

type CreditLineRow = {
  date: string;
  description: string;
  amount: number; // signed: + payment, - withdrawal/interest
};

type ColumnAnchors = {
  interestMid: number;
  withdrawalMid: number;
  paymentMid: number;
  balanceMin: number;
};

function findColumnAnchors(lines: PdfLine[]): ColumnAnchors | null {
  for (const l of lines) {
    if (!/Withdrawals\s*\(\$\)/.test(l.text)) continue;
    if (!/Payments\s*\(\$\)/.test(l.text)) continue;
    const items = l.items ?? [];
    let interestX: number | null = null;
    let withdrawalX: number | null = null;
    let paymentX: number | null = null;
    let balanceX: number | null = null;
    for (const it of items) {
      if (/^Interest\b/.test(it.str)) interestX = it.x;
      if (/^Withdrawals$/.test(it.str)) withdrawalX = it.x;
      if (/^Payments$/.test(it.str)) paymentX = it.x;
      if (/^Balance\b/.test(it.str)) balanceX = it.x;
    }
    if (withdrawalX != null && paymentX != null) {
      return {
        interestMid: interestX != null ? (interestX + withdrawalX) / 2 : -Infinity,
        withdrawalMid: (withdrawalX + paymentX) / 2,
        paymentMid: balanceX != null ? (paymentX + balanceX) / 2 : paymentX + 50,
        balanceMin: balanceX ?? Number.POSITIVE_INFINITY,
      };
    }
  }
  return null;
}

function isMoneyToken(s: string): boolean {
  return MONEY_RE.test(s.trim());
}

function moneySpans(line: PdfLine): PdfTextSpan[] {
  const items = line.items;
  if (!items || items.length === 0) {
    const tokens = line.text.split(/\s{2,}/);
    const out: PdfTextSpan[] = [];
    let xOffset = 0;
    for (const t of tokens) {
      if (isMoneyToken(t)) out.push({ x: xOffset, width: t.length * 5, str: t.trim() });
      xOffset += (t.length + 2) * 5;
    }
    return out;
  }
  return items.filter((it) => isMoneyToken(it.str));
}

function classifyRow(
  spans: PdfTextSpan[],
  cols: ColumnAnchors | null,
): { interest: number | null; withdrawal: number | null; payment: number | null; balance: number | null } {
  let interest: number | null = null;
  let withdrawal: number | null = null;
  let payment: number | null = null;
  let balance: number | null = null;
  for (const s of spans) {
    const val = parseMoney(s.str);
    if (!Number.isFinite(val)) continue;
    if (cols && s.x >= cols.balanceMin - 5) {
      balance = val;
    } else if (cols && s.x < cols.interestMid) {
      // Left of interest column — treat as part of description (e.g. inline amount in PMT label).
      continue;
    } else if (cols && s.x < cols.withdrawalMid) {
      interest = val;
    } else if (cols && s.x < cols.paymentMid) {
      withdrawal = val;
    } else if (cols) {
      payment = val;
    }
  }
  return { interest, withdrawal, payment, balance };
}

const DATE_PREFIX = /^(\d{1,2}\s+[A-Z][a-z]{2})\b/;

export function parseRbcCreditLineActivity(
  lines: PdfLine[],
  period: Period,
): { rows: CreditLineRow[]; parseErrors: { rowIndex: number; message: string }[] } {
  const rows: CreditLineRow[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];
  const cols = findColumnAnchors(lines);

  // Activity section: between "Details of your account activity" and the
  // first "Your LoanProtector insurance coverage summary" or "Rate History".
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
    if (/Details of your account activity - continued/i.test(l.text)) continue;
    activityLines.push(l);
  }

  let currentDate: string | null = null;
  let descBuffer: string[] = [];

  for (let i = 0; i < activityLines.length; i++) {
    const line = activityLines[i];
    const text = line.text.trim();
    if (!text) continue;
    if (/^Date\s+Description/i.test(text)) continue;

    const dm = DATE_PREFIX.exec(text);
    if (dm) {
      try {
        currentDate = dayMonthToIso(dm[1], period);
      } catch (err) {
        parseErrors.push({ rowIndex: i + 1, message: (err as Error).message });
        continue;
      }
      descBuffer = [];
    }

    const spans = moneySpans(line);
    const { interest, withdrawal, payment, balance: _balance } = classifyRow(spans, cols);
    void _balance;

    // Strip date prefix + money tokens from line text to get description.
    let desc = text.replace(DATE_PREFIX, '').trim();
    for (const s of spans) desc = desc.replace(s.str, '').trim();
    desc = desc.replace(/\s{2,}/g, ' ').trim();
    if (desc) descBuffer.push(desc);

    const hasMonetaryAction = interest != null || withdrawal != null || payment != null;
    if (!hasMonetaryAction) continue;

    if (!currentDate) {
      parseErrors.push({ rowIndex: i + 1, message: 'Credit Line row with amount but no date' });
      descBuffer = [];
      continue;
    }
    let amount = 0;
    if (interest != null) amount -= Math.abs(interest);
    if (withdrawal != null) amount -= Math.abs(withdrawal);
    if (payment != null) amount += Math.abs(payment);
    const fullDesc = descBuffer.filter((s) => s.length > 0).join(' ').trim();
    rows.push({ date: currentDate, description: fullDesc || 'Credit Line transaction', amount });
    descBuffer = [];
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
    const { rows, parseErrors } = parseRbcCreditLineActivity(lines, period);

    const transactions: PdfParseResult['transactions'] = rows.map((row) => ({
      date: row.date,
      merchantRaw: row.description,
      merchantClean: normalizeMerchant(row.description),
      amount: row.amount,
      currency: ctx.defaultCurrency,
      sourceReference: null,
    }));

    return {
      transactions,
      header,
      warnings: [],
      parseErrors,
    };
  },
};

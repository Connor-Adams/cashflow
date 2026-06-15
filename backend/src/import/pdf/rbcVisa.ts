import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, parseLongDate, parseMoney, toIso, type Period } from './dateHelpers';

/**
 * RBC Visa (Signature RBC Rewards Visa, RBC Avion, etc) statement parser.
 *
 * Layout markers:
 *   Title:   "Signature® RBC Rewards® Visa‡"  (or other Visa product title)
 *   Account: "CONNOR ADAMS 4510 15** **** 5234"  (last 4 = account suffix)
 *   Period:  "STATEMENT FROM NOV 08 TO DEC 8, 2025"
 *   Header:  "TRANSACTION DATE POSTING DATE ACTIVITY DESCRIPTION AMOUNT ($)"
 *
 * Row format (1-2 lines per txn):
 *   "NOV 07  NOV 10  SPOTIFY P3C3196378 STOCKHOLM"
 *   "74987505311002642493068" (optional reference)
 *   "$14.34"  (amount; sometimes on the same line as description)
 *
 * Or:
 *   "DEC 01  DEC 01  ANNUAL FEE  $39.00"  (single line)
 *
 * Sign convention (cashflow side):
 *   Charge ("$14.34") → negative
 *   Payment ("-$34.17") → positive
 */

const ACCOUNT_RE = /(45\d{2})\s+15\*{2}\s+\*{4}\s+(\d{4})/;
const PERIOD_RE = /STATEMENT FROM\s+([A-Z]{3}\s+\d{1,2})\s+TO\s+([A-Z]{3}\s+\d{1,2},\s+\d{4})/i;
const MONEY_TOKEN_RE = /-?\$[\d,]+\.\d{2}/;
const MONEY_TOKEN_RE_G = /-?\$[\d,]+\.\d{2}/g;
// Statement-total reconciliation: RBC Visa prints a "purchases" subtotal near
// the end of the activity section. Match the common label variants; the soft
// cross-check is skipped when none is found.
const PURCHASES_TOTAL_RE =
  /(?:total purchases[\w,&\s]*|subtotal of (?:monthly )?(?:purchases|transactions)[\w,&\s]*)\s(-?\$[\d,]+\.\d{2})\s*$/i;

function normalizeMonth(monStr: string): string {
  return monStr.charAt(0).toUpperCase() + monStr.slice(1).toLowerCase();
}

function parseShortMonthDay(raw: string, year: number): string | null {
  const m = /^([A-Z]{3})\s+(\d{1,2})$/i.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS_SHORT[normalizeMonth(m[1])];
  if (month === undefined) return null;
  return toIso(year, month, Number(m[2]));
}

export function parseRbcVisaHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountSuffix: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_RE.exec(l.text);
    if (m) {
      accountSuffix = m[2];
      break;
    }
  }
  if (!accountSuffix) {
    throw new Error('RBC Visa header: could not find account suffix');
  }

  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const endIso = parseLongDate(
      m[2].replace(/^([A-Z]{3})/i, (_w, mon) => {
        // Expand 3-letter month to full month name so parseLongDate accepts it.
        const full: Record<string, string> = {
          Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
          Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
        };
        return full[normalizeMonth(mon)] ?? mon;
      }),
    );
    if (!endIso) continue;
    const endYear = Number(endIso.slice(0, 4));
    const startIso = parseShortMonthDay(m[1], endYear);
    if (!startIso) continue;
    // If start > end, period crossed year boundary — back off start year by 1.
    period = startIso > endIso
      ? { start: parseShortMonthDay(m[1], endYear - 1)!, end: endIso }
      : { start: startIso, end: endIso };
    break;
  }
  if (!period) {
    throw new Error('RBC Visa header: could not parse statement period');
  }

  // Pull the product label (best-effort, falls back to a generic name).
  let productLabel = 'RBC Visa';
  for (const l of page1) {
    if (/Signature.{0,3}\s*RBC\s+Rewards.{0,3}\s*Visa/i.test(l.text)) {
      productLabel = 'Signature RBC Rewards Visa';
      break;
    }
    if (/RBC\s+Avion\s+Visa/i.test(l.text)) {
      productLabel = 'RBC Avion Visa';
      break;
    }
  }

  return {
    accountSuffix,
    productLabel,
    accountType: 'credit_card',
    periodStart: period.start,
    periodEnd: period.end,
  };
}

type VisaRow = { date: string; description: string; amount: number };

export function parseRbcVisaActivity(
  lines: PdfLine[],
  period: Period,
): { rows: VisaRow[]; parseErrors: { rowIndex: number; message: string }[] } {
  const rows: VisaRow[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];

  // Activity section starts after "ACTIVITY DESCRIPTION" header line and ends
  // at "TOTAL ACCOUNT BALANCE" or "INTEREST RATE CHART".
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/ACTIVITY DESCRIPTION/.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/TOTAL ACCOUNT BALANCE/i.test(l.text)) break;
    if (/INTEREST RATE CHART|Time to Pay/i.test(l.text)) break;
    // The printed purchases subtotal marks the end of the transaction list;
    // stop here so its label text is not appended to the last txn description.
    if (PURCHASES_TOTAL_RE.test(l.text.trim())) break;
    activityLines.push(l);
  }

  // Walk lines and emit one txn per "TRANS POST DESCRIPTION ... [AMOUNT]" group.
  // Each txn opens with a TRANS_DATE+POST_DATE prefix; description continues on
  // dateless lines until the amount is found (often on the same line, sometimes
  // on a subsequent line with just the amount).
  const DATE_PREFIX = /^([A-Z]{3}\s+\d{1,2})\s+([A-Z]{3}\s+\d{1,2})\s+(.*)$/;
  type Pending = { transDateRaw: string; descParts: string[]; amount: number | null };
  let pending: Pending | null = null;

  const flush = (idx: number): void => {
    if (!pending) return;
    if (pending.amount == null) {
      parseErrors.push({
        rowIndex: idx + 1,
        message: `RBC Visa row missing amount: ${pending.descParts.join(' ')}`,
      });
      pending = null;
      return;
    }
    const periodEndYear = Number(period.end.slice(0, 4));
    let iso = parseShortMonthDay(pending.transDateRaw, periodEndYear);
    if (iso && iso > period.end) {
      iso = parseShortMonthDay(pending.transDateRaw, periodEndYear - 1);
    }
    if (!iso) {
      parseErrors.push({
        rowIndex: idx + 1,
        message: `RBC Visa: could not resolve transaction date ${pending.transDateRaw}`,
      });
      pending = null;
      return;
    }
    const desc = pending.descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!desc) {
      parseErrors.push({ rowIndex: idx + 1, message: 'RBC Visa: empty description' });
      pending = null;
      return;
    }
    // Sign flip: PDF positive = charge → cashflow negative.
    rows.push({ date: iso, description: desc, amount: -pending.amount });
    pending = null;
  };

  for (let i = 0; i < activityLines.length; i++) {
    const text = activityLines[i].text.trim();
    if (!text) continue;
    // Skip cardholder header line ("CONNOR ADAMS 4510 ...") and primary label.
    if (ACCOUNT_RE.test(text) && /PRIMARY|CARDHOLDER/i.test(text)) continue;

    const dm = DATE_PREFIX.exec(text);
    if (dm) {
      // New row — flush previous if any.
      flush(i);
      pending = { transDateRaw: dm[1], descParts: [], amount: null };
      let remainder = dm[3];
      // Take the LAST money token (the amount column). A $ figure embedded in
      // the merchant/description (e.g. a "$5.00 CREDIT" promo blurb) must not
      // be mistaken for the amount.
      const amtTokens = remainder.match(MONEY_TOKEN_RE_G);
      if (amtTokens) {
        const amt = amtTokens[amtTokens.length - 1];
        pending.amount = parseMoney(amt.replace('$', ''));
        const at = remainder.lastIndexOf(amt);
        remainder = (remainder.slice(0, at) + remainder.slice(at + amt.length)).trim();
      }
      if (remainder) pending.descParts.push(remainder);
      continue;
    }

    if (!pending) continue;

    // Continuation line. Could be: reference number (digits only), more description,
    // or just the amount on its own line.
    const amtMatch = MONEY_TOKEN_RE.exec(text);
    if (amtMatch && text === amtMatch[0]) {
      pending.amount = parseMoney(amtMatch[0].replace('$', ''));
      continue;
    }
    if (/^\d{15,}$/.test(text)) {
      // Pure reference number — skip from description.
      continue;
    }
    pending.descParts.push(text);
  }
  flush(activityLines.length);

  return { rows, parseErrors };
}

export const rbcVisaParser: PdfParser = {
  id: 'rbc_visa',
  label: 'RBC Visa',
  sniff: (lines) =>
    lines.some((l) =>
      /Signature.{0,3}\s*RBC\s+Rewards.{0,3}\s*Visa/i.test(l.text) ||
      /RBC\s+Avion\s+Visa/i.test(l.text),
    ),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcVisaHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const { rows, parseErrors } = parseRbcVisaActivity(lines, period);
    const warnings: string[] = [];

    const transactions: PdfParseResult['transactions'] = rows.map((row) => ({
      date: row.date,
      merchantRaw: row.description,
      merchantClean: normalizeMerchant(row.description),
      amount: row.amount,
      currency: ctx.defaultCurrency,
      sourceReference: null,
    }));

    // ── Soft statement-total reconciliation ─────────────────────────────────
    // Sum parsed charges (PDF positive = charge; cashflow stores it negated)
    // against the printed "purchases" subtotal. Skipped entirely when the
    // statement prints no recognizable total — a missing total is not an error,
    // but a mismatch is a parse warning so swallowed/missed rows surface.
    let printedPurchasesTotal: number | null = null;
    for (const l of lines) {
      const m = PURCHASES_TOTAL_RE.exec(l.text.trim());
      if (m) {
        printedPurchasesTotal = parseMoney(m[1].replace('$', ''));
        break;
      }
    }
    if (printedPurchasesTotal !== null) {
      // Charges are the negative-cashflow rows; sum their PDF-positive magnitude.
      const parsedCharges = rows.reduce(
        (acc, row) => (row.amount < 0 ? acc - row.amount : acc),
        0,
      );
      if (Math.abs(parsedCharges - printedPurchasesTotal) > 0.02) {
        warnings.push(
          `Purchases total mismatch: parsed ${parsedCharges.toFixed(2)} vs printed ${printedPurchasesTotal.toFixed(2)}`,
        );
      }
    }

    return {
      transactions,
      header,
      warnings,
      parseErrors,
    };
  },
};

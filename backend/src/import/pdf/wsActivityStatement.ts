import crypto from 'node:crypto';
import type { PdfLine } from './types';
import type { NormalizedInvestmentActivity } from '../statementTypes';

/**
 * Wealthsimple "Custom Activity Statement" — a multi-account, on-demand PDF.
 *
 * Wealthsimple retired the per-account statement exports, leaving the holdings
 * report (positions only) and this. It is therefore the ONLY remaining source
 * of buys, sells, dividends and interest — the rows ACB, capital gains and
 * investment income are computed from.
 *
 * Shape: one section per account, headed `<Label> (<WSID>)`, then rows in a
 * Transaction Date | Settlement Date | Transaction | Description | Debit |
 * Credit | Currency grid.
 *
 * Three things make it awkward.
 *
 * 1. DESCRIPTIONS WRAP AROUND THE ROW, above it and below it:
 *
 *      TWC - TWC Enterprises Ltd: Bought 0.0058 shares     <- before
 *      2026-06-15  2026-06-16  BUY              $0.15 CAD  <- the row
 *      at $25.75 per share (executed at 2026-06-15)        <- after
 *
 *    Attaching only the preceding fragments would truncate; attaching
 *    everything between two rows would merge one description into the next.
 *    A description block instead STARTS at a fragment shaped `SYM - Name:` and
 *    continues until the next such start, so it can span the row it describes.
 *
 * 2. DEBIT VS CREDIT IS POSITIONAL, and the columns move between sections —
 *    debit sits at x≈436 in the TFSA section and x≈448 in the FHSA one, and
 *    some rows collapse into a single span with no x information at all. So
 *    the sign comes from the activity CODE, which is unambiguous; the observed
 *    x-positions corroborate it (every BUY sits left of every DIVIDEND).
 *    An unrecognised code is reported rather than guessed at — silently
 *    mis-signing a row would corrupt ACB.
 *
 * 3. Page furniture (`Page 1 of 4`, repeated column headers) interleaves with
 *    the rows and has to be skipped wherever it appears.
 */

export interface WsActivitySlice {
  /** Wealthsimple account id, matched against `Account.shortCode`. */
  wsid: string;
  accountLabel: string;
  activities: NormalizedInvestmentActivity[];
}

export interface WsActivityStatementResult {
  slices: WsActivitySlice[];
  parseErrors: { rowIndex: number; message: string }[];
}

/** `TFSA (HQ6LMLTK8CAD)` / `Non-registered margin (HQ4TLFJ02CAD)`. */
const SECTION_RE = /^(.+?)\s+\(([A-Z0-9]{8,})\)$/;
/** A row opens with a trade date and, for settled trades, a settlement date. */
const ROW_RE = /^(\d{4}-\d{2}-\d{2})\s+(?:(\d{4}-\d{2}-\d{2})\s+)?([A-Z_]{2,})\b\s*(.*)$/;
/** `$26.89 CAD` — the trailing money-and-currency pair on a row. */
const AMOUNT_RE = /\$([\d,]+\.\d{2})\s*([A-Z]{3})/;
/** A description block opens with a ticker, e.g. `XEQT - iShares …`. */
const DESC_START_RE = /^([A-Z0-9.]{1,12})\s+-\s+/;
// The grid header arrives as several spans that join into "Transaction
// Settlement" / "Date Date" / "Transaction Description Debit Credit Currency",
// and repeats on every page, so each shape has to be recognised wherever it
// lands — otherwise it becomes description text on the next row.
const PAGE_FURNITURE_RES = [
  /^Page \d+ of \d+$/i,
  /^(?:Transaction|Settlement|Date)(?:\s+(?:Transaction|Settlement|Date))*\s*$/i,
  /Description\s+Debit\s+Credit\s+Currency/i,
  /^(?:CAD|USD)\s+Activity$/i,
];
function isPageFurniture(text: string): boolean {
  return PAGE_FURNITURE_RES.some((re) => re.test(text));
}
const NO_ACTIVITY_RE = /No activities were recorded/i;

/**
 * Wealthsimple's activity codes, mapped to our activity types and to which
 * side of the ledger they land on. `direction` is what gives the amount its
 * sign — see note 2 above.
 */
const CODES: Record<string, {
  activityType: NormalizedInvestmentActivity['activityType'];
  direction: 'debit' | 'credit' | 'none';
}> = {
  BUY: { activityType: 'buy', direction: 'debit' },
  BUYTOOPEN: { activityType: 'buy', direction: 'debit' },
  SELL: { activityType: 'sell', direction: 'credit' },
  SELLTOCLOSE: { activityType: 'sell', direction: 'credit' },
  DIVIDEND: { activityType: 'dividend', direction: 'credit' },
  STKDIV: { activityType: 'dividend', direction: 'credit' },
  INTEREST: { activityType: 'interest', direction: 'credit' },
  INT: { activityType: 'interest', direction: 'credit' },
  CRYPTORWD: { activityType: 'staking_reward', direction: 'credit' },
  EFT: { activityType: 'transfer_in', direction: 'credit' },
  TRFIN: { activityType: 'transfer_in', direction: 'credit' },
  TRFINTF: { activityType: 'transfer_in', direction: 'credit' },
  TRANSFER_TF: { activityType: 'transfer_in', direction: 'credit' },
  DEP: { activityType: 'transfer_in', direction: 'credit' },
  TRFOUT: { activityType: 'transfer_out', direction: 'debit' },
  WDL: { activityType: 'transfer_out', direction: 'debit' },
  // Withholding tax and card/account fees both reduce the account.
  NRT: { activityType: 'fee', direction: 'debit' },
  FEE: { activityType: 'fee', direction: 'debit' },
  DCTFEE: { activityType: 'fee', direction: 'debit' },
  // A share-count correction moves units, never cash; WS prints $0.00.
  CONSOLIDATION: { activityType: 'split', direction: 'none' },
  SPLIT: { activityType: 'split', direction: 'none' },
  JRL: { activityType: 'other', direction: 'none' },
  CREDIT: { activityType: 'cash_movement', direction: 'credit' },
};

function isDescriptionFragment(line: PdfLine): boolean {
  const text = line.text.trim();
  if (text === '') return false;
  if (isPageFurniture(text)) return false;
  if (SECTION_RE.test(text)) return false;
  return !ROW_RE.test(text);
}

/**
 * Split the fragments between two rows into the part that trailed the row
 * above and the part that leads the row below.
 *
 * A description wraps both above and below the row it belongs to, so a run of
 * fragments between two rows is shared between them. Two signals decide the
 * boundary:
 *
 *   - A ticker (`XEQT - …`) always opens a description, so the LAST such
 *     fragment begins the next row's lead.
 *   - Failing that, only a row that brings no description of its own needs a
 *     lead. `TRANSFER_TF` prints an empty cell and takes "Money transfer into
 *     the account…" from the line above; `INTEREST` prints "Stock lending
 *     monthly interest payment" inline and needs nothing, so everything
 *     buffered ahead of it trailed the row before.
 *
 * Getting this wrong is not cosmetic: a row that inherits the previous row's
 * text also inherits its ticker, attaching activity to the wrong security.
 */
function splitFragments(
  fragments: string[],
  rowHasOwnDescription: boolean,
): [tail: string[], lead: string[]] {
  if (fragments.length === 0) return [[], []];
  let boundary = -1;
  fragments.forEach((fragment, i) => {
    if (DESC_START_RE.test(fragment)) boundary = i;
  });
  if (boundary === -1) {
    if (rowHasOwnDescription) return [fragments, []];
    boundary = fragments.length - 1;
  }
  return [fragments.slice(0, boundary), fragments.slice(boundary)];
}

export function parseWsActivityStatement(lines: PdfLine[]): WsActivityStatementResult {
  const slices: WsActivitySlice[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];

  let slice: WsActivitySlice | null = null;
  // Fragments seen since the last row. They belong partly to that row (text
  // that wrapped BELOW it) and partly to the row about to appear (text that
  // wrapped ABOVE it); `splitFragments` decides where the boundary falls.
  let pending: string[] = [];
  let previousRow: NormalizedInvestmentActivity | null = null;

  const appendTo = (row: NormalizedInvestmentActivity | null, parts: string[]): void => {
    if (!row || parts.length === 0) return;
    row.description = [row.description, ...parts].join(' ').replace(/\s+/g, ' ').trim();
  };

  lines.forEach((line, index) => {
    const text = line.text.trim();
    if (text === '') return;

    const section = SECTION_RE.exec(text);
    if (section) {
      // Whatever trails the last row of the previous section belongs to it.
      appendTo(previousRow, pending);
      slice = { wsid: section[2], accountLabel: section[1].trim(), activities: [] };
      slices.push(slice);
      pending = [];
      previousRow = null;
      return;
    }
    if (slice == null) return; // preamble
    if (isPageFurniture(text) || NO_ACTIVITY_RE.test(text)) return;

    const row = ROW_RE.exec(text);
    if (!row) {
      if (isDescriptionFragment(line)) pending.push(text);
      return;
    }

    const code = row[3].toUpperCase();
    const mapped = CODES[code];
    if (!mapped) {
      parseErrors.push({
        rowIndex: index + 1,
        message: `WS activity statement: unrecognised transaction code "${code}" on ${row[1]}`,
      });
      return;
    }

    const money = AMOUNT_RE.exec(text);
    const magnitude = money ? Number(money[1].replace(/,/g, '')) : null;
    const amount = magnitude == null || mapped.direction === 'none'
      ? magnitude
      : (mapped.direction === 'debit' ? -magnitude : magnitude);

    // The row's own inline description sits between the code and the amount.
    const inline = row[4].replace(AMOUNT_RE, '').trim();

    // Hand the trailing half of the buffer back to the row it wrapped under,
    // and keep the leading half for this one.
    const [tail, lead] = splitFragments(pending, inline !== '');
    appendTo(previousRow, tail);
    pending = [];
    const description = [...lead, inline]
      .filter((part) => part !== '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const symbol = DESC_START_RE.exec(description)?.[1] ?? null;
    const currency = money ? money[2] : 'CAD';

    const activity: NormalizedInvestmentActivity = {
      activityType: mapped.activityType,
      tradeDate: row[1],
      settlementDate: row[2] ?? null,
      description,
      security: symbol ? { symbol, name: null, assetType: null, currency } : null,
      quantity: null,
      price: null,
      amount,
      fees: null,
      currency,
      sourceReference: null,
      // Two rows can share a date, code and amount — the pair of same-day
      // $0.00 CONSOLIDATIONs in the real statement do — so the ordinal keeps
      // them distinct.
      sourceRowFingerprint: crypto
        .createHash('sha256')
        .update(JSON.stringify([
          'ws-activity', slice.wsid, row[1], code, magnitude, description,
          slice.activities.length,
        ]))
        .digest('hex'),
    };
    slice.activities.push(activity);
    previousRow = activity;
  });
  // End of document: anything still buffered trailed the final row.
  appendTo(previousRow, pending);

  return { slices, parseErrors };
}

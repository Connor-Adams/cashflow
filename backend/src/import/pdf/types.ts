import type {
  NormalizedHoldingSnapshot,
  NormalizedInvestmentActivity,
} from '../statementTypes';
import type { TxnType } from '../enrichment/types';

/** One positioned text fragment on a line. X-positions are in pdfjs user-space units. */
export type PdfTextSpan = {
  x: number;
  width: number;
  str: string;
};

export type PdfLine = {
  /** 1-based page number. */
  page: number;
  /** Y coordinate of the line (in pdfjs user-space units, top-of-page is large). */
  y: number;
  /** Reconstructed line text, with multi-space gaps preserved (one or more spaces between adjacent items). */
  text: string;
  /**
   * Positioned text fragments composing this line, left-to-right. Parsers
   * that need column-based disambiguation (RBC withdrawal-vs-deposit
   * columns) read these; parsers that work on the joined `text` ignore
   * them. Optional: synthetic test fixtures and the receipt-PDF code path
   * omit positions.
   */
  items?: PdfTextSpan[];
};

export type PdfParseContext = {
  /** Account default currency, e.g. 'CAD'. */
  defaultCurrency: string;
  /**
   * The target Account's type, when the caller already knows it. Wealthsimple
   * runs Cash/Chequing/Save accounts and brokerage accounts through one
   * statement layout (and so one parser + sniff), and the row codes alone no
   * longer separate them — WS relabels them between statement cycles. The
   * account type is the stable signal, so the WS brokerage parser reads it to
   * decide whether a row belongs in the cash ledger or in investment activity.
   * Omit when the account is not known yet: the bundle importers parse once
   * just to read the header, resolve the account from it, then re-parse
   * through `parseStatementFile`, which does supply this.
   */
  accountType?: 'checking' | 'savings' | 'credit_card' | 'investment' | 'loan';
};

/**
 * Account-shape metadata extracted from the PDF body. The RBC bundle importer
 * reads this to auto-create the matching Account (shortCode = accountSuffix).
 * Filename hints are sanity-checked against this — the body is authoritative.
 */
export type PdfStatementHeader = {
  /** Last-4 (or other distinguishing suffix) used as Account.shortCode. */
  accountSuffix: string;
  /** Human-readable product label from the PDF (e.g. "RBC Day to Day Banking"). */
  productLabel: string;
  /** Maps to the Account.accountType enum. */
  accountType: 'checking' | 'savings' | 'credit_card' | 'investment' | 'loan';
  /** ISO yyyy-mm-dd. */
  periodStart: string;
  /** ISO yyyy-mm-dd. */
  periodEnd: string;
  /**
   * 3-letter ISO currency code (e.g. "CAD", "USD"). Surfaced by parsers that
   * produce multi-currency statements (Wise) so the bundle importer can set
   * Account.defaultCurrency from the body rather than defaulting to CAD.
   * Omit when the parser only handles single-currency statements.
   */
  currency?: string;
  /**
   * Legal account-holder name as printed on the statement (e.g. "CDG Labs Inc."
   * or "Connor Adams"). Used by the bundle importer to find-or-create the
   * matching Entity and decide corp-vs-personal routing. Omit when the parser
   * cannot reliably extract a holder.
   */
  accountHolder?: string;
  // Credit-card statement summary fields, when the parser can read the bill
  // block. Drive the statement→calendar auto-fill (#243 follow-up). `null` when
  // absent or unparseable — never throw, never break the transaction path.
  /** New balance owed for the cycle (positive). */
  statementBalance?: number | null;
  /** ISO YYYY-MM-DD payment due date as printed on the statement. */
  paymentDueDate?: string | null;
  /** Minimum payment due for the cycle (positive). */
  minimumPayment?: number | null;
};

export type PdfParseResult = {
  /** Transactions in cashflow's sign convention (positive = credit, negative = charge for credit cards). */
  transactions: Array<{
    date: string;            // YYYY-MM-DD
    merchantRaw: string;
    merchantClean: string;
    amount: number;
    currency: string;
    sourceReference: string | null;
    /**
     * Authoritative txnType supplied by the parser when the source carries a
     * stronger signal than the narrative detector (WS brokerage cash codes,
     * WS credit-card TYPE column). Flows onto NormalizedCashTransaction.
     * overrideTxnType in parseStatementFile so the commit pipeline types the
     * row by the source code instead of guessing. Omit to let enrichment decide.
     */
    overrideTxnType?: TxnType;
  }>;
  /**
   * Investment activity rows (mutual fund buys/sells, distributions,
   * reinvestments). Only emitted by parsers that handle investment
   * statements. Fingerprinting is applied downstream in parseStatementFile.
   */
  investmentActivities?: Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[];
  /**
   * Holding snapshot rows (as-of statementDate positions). Only emitted by
   * parsers that handle investment statements. Fingerprinting is applied
   * downstream in parseStatementFile.
   */
  holdings?: Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>[];
  /**
   * Account-shape metadata extracted from the PDF body. The RBC bundle
   * importer uses this to auto-create or match the Account. Optional so
   * existing parsers (CIBC) don't need to be retrofitted.
   */
  header?: PdfStatementHeader;
  warnings: string[];
  parseErrors: { rowIndex: number; message: string }[];
};

export type PdfParser = {
  id: string;
  label: string;
  /** Cheap content sniff — return true if this parser can handle the PDF. */
  sniff: (lines: PdfLine[]) => boolean;
  /** Parse all transactions out of the PDF. */
  parse: (lines: PdfLine[], ctx: PdfParseContext) => PdfParseResult;
  /**
   * When set, `parseStatementFile` stamps `preview.crossSourceDedup` with this
   * value so the commit pipeline runs the fuzzy investment-activity matcher
   * against existing DB rows before inserting. Use for parsers whose source
   * overlaps another importer (Wealthsimple PDF vs Wealthsimple CSV).
   */
  crossSourceDedup?: 'fuzzy-window-5d';
  /**
   * Holding fingerprint scheme. Default (omitted) = the generic
   * kind:'holding' scheme. 'ws_holding' makes emitted holdings hash
   * identically to the Wealthsimple holdings CSV importer so the same
   * month-end snapshot does not duplicate across the two sources.
   */
  holdingFingerprint?: 'ws_holding';
};

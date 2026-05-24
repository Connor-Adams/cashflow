import type {
  NormalizedHoldingSnapshot,
  NormalizedInvestmentActivity,
} from '../statementTypes';

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
};

export type PdfLine = {
  /** 1-based page number. */
  page: number;
  /** Y coordinate of the line (in pdfjs user-space units, top-of-page is large). */
  y: number;
  /** Reconstructed line text, with multi-space gaps preserved (one or more spaces between adjacent items). */
  text: string;
};

export type PdfParseContext = {
  /** Account default currency, e.g. 'CAD'. */
  defaultCurrency: string;
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

import type { PdfLine } from '../types';
import type { ExtractedReceiptOrder } from '../../../ai/extractReceiptItems';

export type ReceiptPdfParseContext = {
  defaultCurrency: string;
};

export type ReceiptPdfParseResult = {
  extracted: ExtractedReceiptOrder;
  warnings: string[];
};

export type ReceiptPdfParser = {
  id: string;
  label: string;
  sniff: (lines: PdfLine[]) => boolean;
  parse: (lines: PdfLine[], ctx: ReceiptPdfParseContext) => ReceiptPdfParseResult;
};

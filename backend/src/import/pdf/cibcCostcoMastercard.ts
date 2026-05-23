import type { PdfParser } from './types';

export const cibcCostcoMastercardParser: PdfParser = {
  id: 'cibc_costco_mastercard',
  label: 'CIBC Costco Mastercard',
  sniff: (lines) => lines.some((l) => l.text.includes('CIBC Costco Mastercard')),
  parse: () => {
    throw new Error('cibc_costco_mastercard parser not implemented yet');
  },
};

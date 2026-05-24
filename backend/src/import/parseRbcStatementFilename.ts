/**
 * Parse an RBC PDF statement filename into account hints + period end.
 *
 * Filename grammar (from rbcroyalbank.com PDF downloads):
 *   "<ProductName> Statement-<accountSuffix> <YYYY-MM-DD>.pdf"
 *
 * Known products (8 layouts in the 2025-12 sample):
 *   Chequing, Savings, NOMI Savings, Visa, Credit Line, TFSA, RDSP
 *
 * Note: filename hints are advisory. The PDF body is authoritative — e.g. a
 * file named "Chequing Statement-4660 2025-12-02.pdf" actually contains an
 * RBC High Interest eSavings statement. The bundle importer should rely on
 * the parser's `header.accountType` and `header.productLabel`, using these
 * filename fields only for batch labelling / fallback sniffing.
 */

export type RbcProductHint =
  | 'chequing'
  | 'savings'
  | 'nomi_savings'
  | 'visa'
  | 'credit_line'
  | 'tfsa'
  | 'rdsp';

export type ParsedRbcFilename = {
  accountSuffix: string;
  productHint: RbcProductHint;
  periodEnd: string; // YYYY-MM-DD
};

const PRODUCT_PATTERNS: Array<{ regex: RegExp; hint: RbcProductHint }> = [
  // Order matters: "NOMI Savings" must match before "Savings".
  { regex: /^NOMI\s+Savings$/i, hint: 'nomi_savings' },
  { regex: /^Credit\s+Line$/i, hint: 'credit_line' },
  { regex: /^Chequing$/i, hint: 'chequing' },
  { regex: /^Savings$/i, hint: 'savings' },
  { regex: /^Visa$/i, hint: 'visa' },
  { regex: /^TFSA$/i, hint: 'tfsa' },
  { regex: /^RDSP$/i, hint: 'rdsp' },
];

export function parseRbcStatementFilename(name: string): ParsedRbcFilename | null {
  const trimmed = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^(.+?)\s+Statement-([A-Za-z0-9-]+)\s+(\d{4}-\d{2}-\d{2})\.pdf$/i.exec(trimmed);
  if (!m) return null;
  const [, productRaw, accountSuffix, periodEnd] = m;
  const match = PRODUCT_PATTERNS.find((p) => p.regex.test(productRaw.trim()));
  if (!match) return null;
  return { accountSuffix, productHint: match.hint, periodEnd };
}

/** Expects `CardName_YYYY_MM.csv` */
export function parseStatementFilename(fileName: string): {
  cardToken: string;
  year: string;
  month: string;
  batchLabel: string;
} | null {
  const base = fileName.replace(/\.csv$/i, '');
  const m = base.match(/^(.+)_(\d{4})_(\d{2})$/);
  if (!m) return null;
  return {
    cardToken: m[1].trim(),
    year: m[2],
    month: m[3],
    batchLabel: `${m[2]}-${m[3]} ${m[1].trim()}`,
  };
}

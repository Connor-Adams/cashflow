/**
 * Expects `CardName_YYYY_MM.csv`
 * @param {string} fileName
 */
function parseStatementFilename(fileName) {
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

module.exports = { parseStatementFilename };

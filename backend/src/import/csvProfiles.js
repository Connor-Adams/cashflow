/**
 * Column names are matched case-insensitively against CSV headers.
 * @typedef {object} CsvProfile
 * @property {string[]} dateHeaders
 * @property {string[]} merchantHeaders
 * @property {string[]} amountHeaders
 * @property {string[]} [currencyHeaders]
 * @property {string[]} [referenceHeaders]
 * @property {string} dateFormat date-fns format string
 * @property {'charges_negative'|'charges_positive'} amountConvention
 */

/** @type {Record<string, CsvProfile>} */
const profiles = {
  generic_simple: {
    dateHeaders: [
      'Date',
      'date',
      'Transaction Date',
      'Posted Date',
      'Posting Date',
      'Trans Date',
    ],
    merchantHeaders: [
      'Description',
      'Merchant',
      'Payee',
      'Name',
      'Memo',
      'Details',
    ],
    amountHeaders: ['Amount', 'amount', 'Transaction Amount', 'Amt'],
    currencyHeaders: ['Currency', 'currency'],
    referenceHeaders: ['Reference', 'reference', 'Id'],
    dateFormat: 'yyyy-MM-dd',
    amountConvention: 'charges_negative',
  },
  generic_amex: {
    dateHeaders: ['Date'],
    merchantHeaders: ['Description'],
    amountHeaders: ['Amount'],
    currencyHeaders: ['Currency'],
    dateFormat: 'MM/dd/yyyy',
    amountConvention: 'charges_negative',
  },
};

/** Strip UTF-8 BOM so "Date" matches Excel/Numbers exports */
function stripBom(s) {
  return String(s).replace(/^\uFEFF/, '').trim();
}

function normalizeHeaderMap(headers) {
  const map = {};
  for (const h of headers) {
    const cleaned = stripBom(h);
    map[cleaned.toLowerCase()] = h;
  }
  return map;
}

function pickColumn(row, headerMap, candidates) {
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (headerMap[key] !== undefined) {
      const orig = headerMap[key];
      return row[orig];
    }
  }
  return undefined;
}

module.exports = {
  profiles,
  normalizeHeaderMap,
  pickColumn,
  stripBom,
};

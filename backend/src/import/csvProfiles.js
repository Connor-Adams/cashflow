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
  /** Amex US/CA/UK exports — dates vary; mapRow tries many formats */
  generic_amex: {
    dateHeaders: [
      'Date',
      'Transaction Date',
      'TransactionDate',
      'Posted Date',
      'Process Date',
      'Date Processed',
      'Trans Date',
    ],
    merchantHeaders: [
      'Description',
      'Merchant',
      'Statement Line',
      'Appears On Your Statement As',
      'Extended Details',
      'Payee',
      'Details',
      'Category',
      'Simplified Details',
    ],
    amountHeaders: [
      'Amount',
      'Transaction Amount',
      'Charge Amount',
      'Amt',
      'Charge',
      'Charges',
      'Debit',
      'Spend',
      'Net Amount',
      'Amount (CAD)',
      'Amount (USD)',
      'Amount (GBP)',
    ],
    currencyHeaders: ['Currency', 'Currency Code', 'Txn Currency'],
    dateFormat: 'MM/dd/yyyy',
    amountConvention: 'charges_negative',
  },
};

profiles.amex = profiles.generic_amex;

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

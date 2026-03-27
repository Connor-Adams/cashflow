const { normalizeMerchant } = require('./normalizeMerchant');
const { parseDateFlexible } = require('./parseDateFlexible');
const {
  profiles,
  normalizeHeaderMap,
  pickColumn,
} = require('./csvProfiles');

/**
 * @param {string} rawAmount
 * @param {'charges_negative'|'charges_positive'} convention
 */
function normalizeAmount(rawAmount, convention) {
  if (rawAmount == null || rawAmount === '') return null;
  let s = String(rawAmount).replace(/,/g, '').trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = `-${s.slice(1, -1)}`;
  }
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  if (convention === 'charges_negative') {
    if (n > 0) return -Math.abs(n);
    return n;
  }
  if (convention === 'charges_positive') {
    if (n < 0) return Math.abs(n);
    return n;
  }
  return n;
}

/**
 * @param {Record<string, string>} row
 * @param {string[]} headers
 * @param {keyof typeof profiles} profileId
 * @param {string} defaultCurrency
 */
function mapCsvRow(row, headers, profileId, defaultCurrency) {
  const profile = profiles[profileId] || profiles.generic_simple;
  const headerMap = normalizeHeaderMap(headers);

  const dateRaw = pickColumn(row, headerMap, profile.dateHeaders);
  const merchantRaw = pickColumn(row, headerMap, profile.merchantHeaders);
  const amountRaw = pickColumn(row, headerMap, profile.amountHeaders);
  const currencyRaw = pickColumn(row, headerMap, profile.currencyHeaders || []);
  const refRaw = pickColumn(row, headerMap, profile.referenceHeaders || []);

  const missing =
    dateRaw == null ||
    String(dateRaw).trim() === '' ||
    merchantRaw == null ||
    String(merchantRaw).trim() === '' ||
    amountRaw == null ||
    String(amountRaw).trim() === '';
  if (missing) {
    return { error: 'Missing required columns' };
  }

  const parsedDate = parseDateFlexible(dateRaw, profile.dateFormat);
  if (!parsedDate) {
    return { error: `Invalid date: ${dateRaw}` };
  }
  const y = parsedDate.getFullYear();
  const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
  const d = String(parsedDate.getDate()).padStart(2, '0');
  const dateOnly = `${y}-${m}-${d}`;

  const amount = normalizeAmount(amountRaw, profile.amountConvention);
  if (amount == null) {
    return { error: `Invalid amount: ${amountRaw}` };
  }

  const merchantClean = normalizeMerchant(merchantRaw);
  const currency = (
    currencyRaw ||
    defaultCurrency ||
    'CAD'
  )
    .toString()
    .trim()
    .toUpperCase()
    .slice(0, 3);

  return {
    value: {
      date: dateOnly,
      merchantRaw: String(merchantRaw),
      merchantClean,
      amount,
      currency,
      sourceReference: refRaw != null ? String(refRaw).trim() || null : null,
    },
  };
}

module.exports = { mapCsvRow, normalizeAmount };

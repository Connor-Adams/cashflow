function normalizeMerchant(raw) {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/\s+/g, ' ');
}

module.exports = { normalizeMerchant };

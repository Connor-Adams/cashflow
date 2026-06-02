// Human labels for tax `computed.totals` keys. Known keys get curated labels;
// anything unmapped falls back to a camelCase→sentence-case humanizer so new
// corp/personal total keys still render readably without a code change.

export const TOTALS_LABELS: Record<string, string> = {
  totalIncome: 'Total income',
  netIncome: 'Net income',
  taxableIncome: 'Taxable income',
  federalTax: 'Federal tax',
  provincialTax: 'Provincial tax',
  cppContrib: 'CPP contributions',
  eiPremium: 'EI premiums',
  totalPayable: 'Total payable',
  refundOrOwing: 'Refund / owing',
  netTaxPayable: 'Net tax payable',
}

// camelCase → "Sentence case". 'grossTaxBeforeCredits' -> 'Gross tax before credits'.
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function labelForTotal(key: string): string {
  return TOTALS_LABELS[key] ?? humanizeKey(key)
}

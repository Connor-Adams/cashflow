/**
 * Split the dashboard's per-business rows into Income vs Spend, each broken out
 * by business/personal, with business-share percentages for the tile bars.
 *
 * `netSpend` is the Spend value (gross outflows minus offset credits — income
 * is excluded by the backend aggregate). `income` is true earned income
 * (txnType='income'). Shares are clamped to [0, 100] and guard divide-by-zero.
 */
export type BusinessIncomeSpendRow = {
  currency: string
  business: boolean
  totalSpend: number
  totalCredits: number
  netSpend: number
  income: number
}

export type BusinessIncomeSpend = {
  income: { business: number; personal: number }
  spend: { business: number; personal: number }
  incomeShare: number
  spendShare: number
}

function businessShare(business: number, personal: number): number {
  const total = business + personal
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (business / total) * 100))
}

export function businessIncomeSpend(
  rows: BusinessIncomeSpendRow[],
  currency: string,
): BusinessIncomeSpend {
  let bizIncome = 0
  let perIncome = 0
  let bizSpend = 0
  let perSpend = 0
  for (const row of rows) {
    if (currency && row.currency !== currency) continue
    if (row.business) {
      bizIncome += row.income
      bizSpend += row.netSpend
    } else {
      perIncome += row.income
      perSpend += row.netSpend
    }
  }
  return {
    income: { business: bizIncome, personal: perIncome },
    spend: { business: bizSpend, personal: perSpend },
    incomeShare: businessShare(bizIncome, perIncome),
    spendShare: businessShare(bizSpend, perSpend),
  }
}

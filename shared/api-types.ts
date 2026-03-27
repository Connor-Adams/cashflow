/** API DTOs shared by backend serialization and frontend consumers. */

export type Account = {
  id: number
  name: string
  owner: string
  shortCode: string | null
  defaultCurrency: string | null
}

export type Transaction = {
  id: number
  accountId: number
  importBatch: string
  date: string
  merchantRaw: string
  merchantClean: string
  amount: number
  currency: string
  notes: string | null
  sourceReference: string | null
  sourceRowFingerprint: string
  appliedRuleId: number | null
  autoCategory: string | null
  categoryOverride: string | null
  finalCategory: string | null
  autoBusiness: boolean | null
  businessOverride: boolean | null
  finalBusiness: boolean
  autoSplitType: string | null
  splitOverride: string | null
  finalSplitType: string
  autoPctMe: number | null
  pctMeOverride: number | null
  finalPctMe: number | null
  autoPctPartner: number | null
  pctPartnerOverride: number | null
  finalPctPartner: number | null
  myShareAmount: number
  partnerShareAmount: number
  businessAmount: number
  reviewFlag: boolean
  reviewedAt: string | null
  account?: Pick<Account, 'id' | 'name' | 'shortCode'>
}

export type Rule = {
  id: number
  merchantPattern: string
  matchKind: string
  priority: number
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  usageCount?: number
}

export type Paginated<T> = {
  data: T[]
  page: number
  pageSize: number
  total: number
}

import { useMatch } from 'react-router-dom'

export type SettingsTopTab =
  | 'settings'
  | 'accounts'
  | 'imports'
  | 'enrichment'
  | 'contacts'
  | 'budgets'
  | 'categories'
  | 'jobs'

export function useActiveSettingsTopTab(): SettingsTopTab {
  const isDisplay = useMatch('/settings/display')
  const isGmail = useMatch('/settings/gmail')
  const isPartnerInvite = useMatch('/settings/partner-invite')
  const isAccounts = useMatch('/settings/accounts')
  const isImports = useMatch('/settings/imports')
  const isEnrichment = useMatch('/settings/enrichment')
  const isContacts = useMatch('/settings/contacts')
  const isBudgets = useMatch('/settings/budgets')
  const isCategories = useMatch('/settings/categories')
  const isJobs = useMatch('/settings/jobs')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isAccounts) return 'accounts'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isBudgets) return 'budgets'
  if (isCategories) return 'categories'
  if (isJobs) return 'jobs'
  return 'settings'
}

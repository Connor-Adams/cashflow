import { useMatch } from 'react-router-dom'

export type SettingsTopTab =
  | 'settings'
  | 'imports'
  | 'enrichment'
  | 'contacts'
  | 'members'
  | 'budgets'
  | 'categories'
  | 'notifications'
  | 'jobs'
  | 'whatsnew'

export function useActiveSettingsTopTab(): SettingsTopTab {
  const isDisplay = useMatch('/settings/display')
  const isGmail = useMatch('/settings/gmail')
  const isPartnerInvite = useMatch('/settings/partner-invite')
  const isImports = useMatch('/settings/imports')
  const isEnrichment = useMatch('/settings/enrichment')
  const isContacts = useMatch('/settings/contacts')
  const isMembers = useMatch('/settings/members')
  const isBudgets = useMatch('/settings/budgets')
  const isCategories = useMatch('/settings/categories')
  const isNotifications = useMatch('/settings/notifications')
  const isJobs = useMatch('/settings/jobs')
  const isWhatsnew = useMatch('/settings/whatsnew')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isMembers) return 'members'
  if (isBudgets) return 'budgets'
  if (isCategories) return 'categories'
  if (isNotifications) return 'notifications'
  if (isJobs) return 'jobs'
  if (isWhatsnew) return 'whatsnew'
  return 'settings'
}

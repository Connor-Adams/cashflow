import { useMatch } from 'react-router-dom'

export type SettingsTopTab =
  | 'settings'
  | 'imports'
  | 'enrichment'
  | 'contacts'
  | 'members'
  | 'budgets'
  | 'categories'
  | 'labels'
  | 'notifications'
  | 'feedback'
  | 'jobs'
  | 'audit-tokens'
  | 'whats-new'
  | 'saved-filters'
  | 'data'

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
  const isLabels = useMatch('/settings/labels')
  const isNotifications = useMatch('/settings/notifications')
  const isFeedback = useMatch('/settings/feedback')
  const isJobs = useMatch('/settings/jobs')
  const isAuditTokens = useMatch('/settings/audit-tokens')
  const isWhatsNew = useMatch('/settings/whats-new')
  const isSavedFilters = useMatch('/settings/saved-filters')
  const isData = useMatch('/settings/data')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isMembers) return 'members'
  if (isBudgets) return 'budgets'
  if (isCategories) return 'categories'
  if (isLabels) return 'labels'
  if (isNotifications) return 'notifications'
  if (isFeedback) return 'feedback'
  if (isJobs) return 'jobs'
  if (isAuditTokens) return 'audit-tokens'
  if (isWhatsNew) return 'whats-new'
  if (isSavedFilters) return 'saved-filters'
  if (isData) return 'data'
  return 'settings'
}

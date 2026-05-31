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
  | 'saved-filters'
  | 'notifications'
  | 'feedback'
  | 'jobs'
  | 'whatsnew'
  | 'audit-tokens'
  | 'audit-log'
  | 'backup'

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
  const isSavedFilters = useMatch('/settings/saved-filters')
  const isNotifications = useMatch('/settings/notifications')
  const isFeedback = useMatch('/settings/feedback')
  const isJobs = useMatch('/settings/jobs')
  const isWhatsnew = useMatch('/settings/whatsnew')
  const isAuditTokens = useMatch('/settings/audit-tokens')
  const isAuditLog = useMatch('/settings/audit-log')
  const isBackup = useMatch('/settings/backup')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isMembers) return 'members'
  if (isBudgets) return 'budgets'
  if (isCategories) return 'categories'
  if (isLabels) return 'labels'
  if (isSavedFilters) return 'saved-filters'
  if (isNotifications) return 'notifications'
  if (isFeedback) return 'feedback'
  if (isJobs) return 'jobs'
  if (isWhatsnew) return 'whatsnew'
  if (isAuditTokens) return 'audit-tokens'
  if (isAuditLog) return 'audit-log'
  if (isBackup) return 'backup'
  return 'settings'
}

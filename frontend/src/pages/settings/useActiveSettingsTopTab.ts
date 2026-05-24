import { useMatch } from 'react-router-dom'

export type SettingsTopTab =
  | 'settings'
  | 'imports'
  | 'enrichment'
  | 'contacts'
  | 'budgets'

export function useActiveSettingsTopTab(): SettingsTopTab {
  const isDisplay = useMatch('/settings/display')
  const isGmail = useMatch('/settings/gmail')
  const isPartnerInvite = useMatch('/settings/partner-invite')
  const isImports = useMatch('/settings/imports')
  const isEnrichment = useMatch('/settings/enrichment')
  const isContacts = useMatch('/settings/contacts')
  const isBudgets = useMatch('/settings/budgets')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isBudgets) return 'budgets'
  return 'settings'
}

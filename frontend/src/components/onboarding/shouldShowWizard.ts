import type { Account, CashflowSettings } from '@/types/api'

/**
 * Decide whether the first-run onboarding wizard should show (#259):
 *   - zero NON-ARCHIVED accounts (closedAt === null), AND
 *   - onboarding_dismissed_at IS NULL.
 *
 * A user with archived-only accounts still counts as empty (issue edge case),
 * and a dismissal is permanent regardless of later account creation.
 *
 * Kept in its own module (not the component file) so the gate file only
 * exports a component — satisfies the react-refresh/only-export-components
 * lint rule and keeps this pure helper unit-testable in isolation.
 */
export function shouldShowWizard(
  accounts: Account[],
  settings: Pick<CashflowSettings, 'onboardingDismissedAt'>,
): boolean {
  const activeAccounts = accounts.filter((a) => a.closedAt == null)
  if (activeAccounts.length > 0) return false
  return settings.onboardingDismissedAt == null
}

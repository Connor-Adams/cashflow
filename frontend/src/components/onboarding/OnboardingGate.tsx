import { useCallback, useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import type { Account, CashflowSettings } from '@/types/api'
import { OnboardingWizard } from './OnboardingWizard'
import { shouldShowWizard } from './shouldShowWizard'

/**
 * Mounts once inside the router and overlays the first-run onboarding wizard
 * (#259) on top of whatever page is showing when the app is empty. Renders
 * nothing while loading or once onboarding is satisfied, so it never blocks
 * returning users.
 */
export function OnboardingGate() {
  const [show, setShow] = useState(false)
  const [checked, setChecked] = useState(false)

  const recheck = useCallback(async () => {
    try {
      const [accounts, settings] = await Promise.all([
        getJson<Account[]>('/api/accounts'),
        getJson<CashflowSettings>('/api/settings/cashflow'),
      ])
      setShow(shouldShowWizard(accounts, settings))
    } catch {
      // On any fetch error, fail closed (don't show) — a transient API blip
      // shouldn't slam a full-screen overlay over a returning user.
      setShow(false)
    } finally {
      setChecked(true)
    }
  }, [])

  useEffect(() => {
    void recheck()
  }, [recheck])

  if (!checked || !show) return null
  return <OnboardingWizard onDone={() => setShow(false)} />
}
